/**
 * JSONL Tailer + Parser
 *
 * Watches Claude session JSONL files and streams parsed messages.
 * Handles partial writes during streaming and accumulates content by UUID.
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const chokidar = require('chokidar');

// Claude stores sessions at ~/.claude/projects/{sanitized-cwd}/{session-id}.jsonl
// When sessions start from ~/Repos, the path is:
// ~/.claude/projects/-home-modha-Repos/{session-id}.jsonl
const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ||
  path.join(process.env.HOME, '.claude', 'projects');

// For sessions started from /home/modha/Repos
const SANITIZED_REPOS_PATH = '-home-modha-Repos';

/**
 * Get the JSONL file path for a session
 * @param {string} sessionId - Session UUID
 * @returns {string} Full path to JSONL file
 */
function getSessionPath(sessionId) {
  return path.join(CLAUDE_PROJECTS_DIR, SANITIZED_REPOS_PATH, `${sessionId}.jsonl`);
}

/**
 * Read and parse a complete session
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Array>} Array of parsed messages
 */
async function readSession(sessionId) {
  const filePath = getSessionPath(sessionId);

  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const messages = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        // Skip malformed lines
        console.warn('Skipping malformed JSONL line:', line.slice(0, 100));
      }
    }

    return processMessages(messages);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return []; // Session file doesn't exist yet
    }
    throw err;
  }
}

/**
 * Process raw JSONL messages into display-ready format
 * - Accumulates streaming messages by UUID
 * - Filters out thinking blocks
 * - Extracts relevant fields
 * @param {Array} rawMessages - Raw parsed JSONL entries
 * @returns {Array} Processed messages
 */
function processMessages(rawMessages) {
  const messageMap = new Map(); // uuid -> message
  const processed = [];

  for (const entry of rawMessages) {
    // Skip non-message entries (queue operations, etc.)
    if (!entry.type || !['user', 'assistant', 'summary'].includes(entry.type)) {
      continue;
    }

    const uuid = entry.uuid;
    if (!uuid) continue;

    // For assistant messages, accumulate by UUID
    if (entry.type === 'assistant') {
      const existing = messageMap.get(uuid);

      if (!existing || entry.message?.stop_reason) {
        // New message or final version (has stop_reason)
        messageMap.set(uuid, entry);
      }
    } else {
      // User/summary messages don't stream
      messageMap.set(uuid, entry);
    }
  }

  // Convert to array in order
  for (const entry of rawMessages) {
    if (!entry.uuid) continue;
    if (messageMap.has(entry.uuid)) {
      const msg = messageMap.get(entry.uuid);
      // Only add once (first occurrence)
      if (!processed.some(p => p.uuid === entry.uuid)) {
        processed.push(formatMessage(msg));
      }
    }
  }

  return processed;
}

/**
 * Format a single message for display
 * @param {Object} entry - JSONL entry
 * @returns {Object} Formatted message
 */
function formatMessage(entry) {
  const result = {
    uuid: entry.uuid,
    type: entry.type,
    timestamp: entry.timestamp,
    parentUuid: entry.parentUuid
  };

  if (entry.type === 'user') {
    // Extract user message content
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      // Check if this is a tool_result message
      const hasToolResult = content.some(c => c.type === 'tool_result');
      if (hasToolResult) {
        // Pass tool_result blocks through (renders like assistant content)
        result.type = 'tool_result_message';
        result.content = content.map(c => {
          if (c.type === 'tool_result') {
            return {
              type: 'tool_result',
              tool_use_id: c.tool_use_id,
              content: c.content,
              is_error: c.is_error
            };
          }
          return c;
        });
      } else {
        // Regular text user message
        result.content = content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
      }
    } else if (typeof content === 'string') {
      result.content = content;
    }
  } else if (entry.type === 'assistant') {
    // Extract assistant message, filter thinking blocks
    const content = entry.message?.content || [];
    result.content = content
      .filter(c => c.type !== 'thinking') // Filter out encrypted thinking
      .map(c => {
        if (c.type === 'text') {
          return { type: 'text', text: c.text };
        } else if (c.type === 'tool_use') {
          return {
            type: 'tool_use',
            name: c.name,
            id: c.id,
            input: c.input
          };
        } else if (c.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: c.tool_use_id,
            content: c.content
          };
        }
        return c;
      });

    result.stopReason = entry.message?.stop_reason;
    result.model = entry.message?.model;
  } else if (entry.type === 'summary') {
    result.content = entry.summary;
  }

  return result;
}

/**
 * Watch a session file for changes and emit events
 * @param {string} sessionId - Session UUID
 * @param {Function} callback - Called with (event, data)
 * @returns {Function} Unwatch function
 */
function watchSession(sessionId, callback) {
  const filePath = getSessionPath(sessionId);
  let position = 0;
  let debounceTimer = null;

  // Create directory watcher since file might not exist yet
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);

  const watcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: true
  });

  const processChanges = async () => {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size <= position) {
        // File truncated or unchanged
        position = stat.size;
        return;
      }

      // Read new content from last position
      const stream = fs.createReadStream(filePath, {
        start: position,
        encoding: 'utf8'
      });

      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
      });

      const newMessages = [];

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const formatted = formatMessage(entry);
          if (formatted.content || formatted.type === 'assistant') {
            newMessages.push(formatted);
          }
        } catch (e) {
          // Partial line, will be completed in next read
          break;
        }
      }

      // Update position
      position = stat.size;

      // Emit new messages
      if (newMessages.length > 0) {
        callback('messages', newMessages);
      }

      // Check if Claude is waiting for input (debounced)
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const messages = await readSession(sessionId);
        const lastMsg = messages[messages.length - 1];

        if (lastMsg?.type === 'assistant' && lastMsg.stopReason === 'end_turn') {
          // Check if last content is text (not tool_use)
          const content = lastMsg.content;
          const lastContent = Array.isArray(content) ? content[content.length - 1] : null;
          if (!lastContent || lastContent.type === 'text') {
            callback('waiting', { sessionId });
          }
        }
      }, 2000);

    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Error watching session:', err);
      }
    }
  };

  watcher.on('add', (p) => {
    if (path.basename(p) === filename) {
      processChanges();
    }
  });

  watcher.on('change', (p) => {
    if (path.basename(p) === filename) {
      processChanges();
    }
  });

  // Initial read if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (!err) {
      processChanges();
    }
  });

  // Return unwatch function
  return () => {
    clearTimeout(debounceTimer);
    watcher.close();
  };
}

module.exports = {
  readSession,
  watchSession,
  getSessionPath
};
