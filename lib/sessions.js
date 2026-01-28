/**
 * Session Manager - tmux wrapper for Claude sessions
 *
 * Manages Claude CLI processes inside tmux sessions for persistence.
 * Sessions survive browser disconnects and can be resumed from any device.
 *
 * KEYSTROKE REFERENCE (see docs/keystroke-testing.md for full details):
 *
 * | Action Type      | Sequence                    | Notes                          |
 * |------------------|-----------------------------|---------------------------------|
 * | permission       | number + Enter              | Permission prompts (1/2/3/n)   |
 * | answer           | number + Tab + Enter        | AskUserQuestion single-select  |
 * | answer-multi     | nums + delays + Right + Enter | Multi-select questions       |
 * | other            | typeOpt + text + Tab + Enter | "Type something" option       |
 * | approve          | y + Enter                   | Simple y/n prompts (rare)      |
 * | reject           | n + Enter                   | Simple y/n prompts (rare)      |
 * | continue         | Enter                       | Continue prompts               |
 * | (default)        | literal text + Enter        | User messages                  |
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const path = require('path');

const execAsync = promisify(exec);

// Enable debug logging with DEBUG=claude-go:keys
const DEBUG = process.env.DEBUG?.includes('claude-go:keys');

/**
 * Log keystroke debug info (only when DEBUG=claude-go:keys)
 */
function debugKeys(action, session, keys) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  const keyStr = Array.isArray(keys) ? keys.join(' → ') : keys;
  console.log(`[${timestamp}] [keys] ${action} session=${session} keys=[${keyStr}]`);
}

/**
 * Run tmux command via spawn (bypasses shell, safe for special chars)
 */
function tmuxSpawn(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data; });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux ${args[0]} failed (${code}): ${stderr}`));
    });
  });
}

const REPOS_DIR = process.env.REPOS_DIR || path.join(process.env.HOME, 'Repos');
const SESSION_PREFIX = 'claude-';

/**
 * List all Claude tmux sessions with their status
 * @returns {Promise<Array<{id: string, name: string, activity: number, alive: boolean}>>}
 */
async function listSessions() {
  try {
    const { stdout } = await execAsync(
      `tmux list-sessions -F '#{session_name}:#{session_activity}' 2>/dev/null || echo ''`
    );

    const sessions = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line || !line.startsWith(SESSION_PREFIX)) continue;

      const [name, activity] = line.split(':');
      const id = name.replace(SESSION_PREFIX, '');

      sessions.push({
        id,
        name,
        activity: parseInt(activity, 10),
        alive: true
      });
    }

    return sessions;
  } catch (err) {
    // tmux not running or no sessions
    return [];
  }
}

/**
 * Create a new Claude session in tmux
 * @param {string} cwd - Working directory for the session
 * @returns {Promise<{id: string, name: string}>}
 */
async function createSession(cwd = REPOS_DIR) {
  const id = crypto.randomUUID();
  const name = `${SESSION_PREFIX}${id}`;

  // Create tmux session with Claude
  // Using --session-id to ensure JSONL is written to predictable location
  const cmd = `tmux new-session -d -s "${name}" -c "${cwd}" 'claude --session-id ${id}'`;

  try {
    await execAsync(cmd);
    return { id, name };
  } catch (err) {
    throw new Error(`Failed to create session: ${err.message}`);
  }
}

/**
 * Send text input to a Claude session
 * @param {string} id - Session ID (without prefix)
 * @param {string} text - Text to send
 * @param {string} action - Optional action type (see header comment for full list)
 */
async function sendInput(id, text, action) {
  const name = `${SESSION_PREFIX}${id}`;

  // Handle special actions (simple chars, exec is fine)
  if (action === 'approve') {
    debugKeys('approve', name, ['y', 'Enter']);
    await tmuxSpawn(['send-keys', '-t', name, 'y', 'Enter']);
    return;
  }

  if (action === 'reject') {
    debugKeys('reject', name, ['n', 'Enter']);
    await tmuxSpawn(['send-keys', '-t', name, 'n', 'Enter']);
    return;
  }

  if (action === 'continue' || (!text && !action)) {
    debugKeys('continue', name, ['Enter']);
    await tmuxSpawn(['send-keys', '-t', name, 'Enter']);
    return;
  }

  // Permission prompt response (numbered options with Enter)
  // Unlike 'answer', permission prompts don't need Tab - just number + Enter
  // For denial, use 'Escape' as text (no Enter needed)
  if (action === 'permission') {
    if (text === 'Escape' || text === 'escape') {
      debugKeys('permission-deny', name, ['Escape']);
      await tmuxSpawn(['send-keys', '-t', name, 'Escape']);
    } else {
      debugKeys('permission-approve', name, [text, 'Enter']);
      await tmuxSpawn(['send-keys', '-t', name, text]);   // Option number (1/2/3)
      await tmuxSpawn(['send-keys', '-t', name, 'Enter']); // Submit
    }
    return;
  }

  // Answer a question (select option, tab to submit, enter)
  // This is for AskUserQuestion prompts which have a Submit button
  if (action === 'answer') {
    debugKeys('answer', name, [text, 'Tab', 'Enter']);
    await tmuxSpawn(['send-keys', '-t', name, text]);  // Select option by number
    await tmuxSpawn(['send-keys', '-t', name, 'Tab']); // Navigate to Submit
    await tmuxSpawn(['send-keys', '-t', name, 'Enter']); // Submit
    return;
  }

  // Answer multi-select: number keys toggle options directly, Right arrow to Submit
  // Pattern: "1", "3", "Right", "Enter" — numbers jump+toggle, Right reaches Submit
  // Note: small delays needed - Claude Code UI needs time to process each keystroke
  if (action === 'answer-multi') {
    // text is comma-separated indices like "1,3" (1-based)
    const indices = text.split(',').filter(s => s.trim()).map(s => s.trim());
    const delay = ms => new Promise(r => setTimeout(r, ms));

    debugKeys('answer-multi', name, [...indices, 'Right', 'Enter']);
    console.log(`[answer-multi] text="${text}" → indices=${JSON.stringify(indices)} → session=${name}`);

    for (const idx of indices) {
      console.log(`[answer-multi] Sending key: "${idx}"`);
      await tmuxSpawn(['send-keys', '-t', name, idx]); // Number key toggles option
      await delay(50); // Let Claude Code process the keystroke
    }

    console.log(`[answer-multi] Sending Right, then Enter`);
    await tmuxSpawn(['send-keys', '-t', name, 'Right']); // Navigate to Submit
    await delay(50);
    await tmuxSpawn(['send-keys', '-t', name, 'Enter']); // Submit
    return;
  }

  // Answer with typed "Other" text
  // Format: "optionCount:actualText" - we select option N+1 (Type something), type text, submit
  if (action === 'other') {
    const colonIdx = text.indexOf(':');
    const optionCount = parseInt(text.substring(0, colonIdx), 10);
    const actualText = text.substring(colonIdx + 1);
    const typeOptionNum = optionCount + 1; // "Type something" is always N+1

    debugKeys('other', name, [typeOptionNum, `"${actualText}"`, 'Tab', 'Enter']);
    await tmuxSpawn(['send-keys', '-t', name, String(typeOptionNum)]); // Select "Type something" option
    await tmuxSpawn(['send-keys', '-t', name, '-l', actualText]); // Type the text
    await tmuxSpawn(['send-keys', '-t', name, 'Tab']); // Navigate to Submit
    await tmuxSpawn(['send-keys', '-t', name, 'Enter']); // Submit
    return;
  }

  // Default: send literal text + Enter (user messages)
  debugKeys('message', name, [`"${text}"`, 'Enter']);
  await tmuxSpawn(['send-keys', '-t', name, '-l', text]);
  await tmuxSpawn(['send-keys', '-t', name, 'Enter']);
}

/**
 * Send interrupt (Ctrl+C) to a session
 * @param {string} id - Session ID
 */
async function sendInterrupt(id) {
  const name = `${SESSION_PREFIX}${id}`;
  debugKeys('interrupt', name, ['C-c']);
  await tmuxSpawn(['send-keys', '-t', name, 'C-c']);
}

/**
 * Send raw keys to a session (for permission prompts)
 *
 * NOTE: For permission prompts, the sequence should be:
 *   - Approve: number (1/2/3) + Enter
 *   - Deny: Escape (no Enter needed)
 *
 * This function sends keys exactly as provided. If you need Enter after
 * a number key, either pass it separately or use sendInput with action='permission'.
 *
 * @param {string} id - Session ID
 * @param {string} keys - Keys to send (e.g., '1', 'Escape', 'y')
 * @param {Object} options - Optional settings
 * @param {boolean} options.withEnter - If true, send Enter after keys (default: false)
 * @returns {Promise<boolean>} - true if sent, false if session not found
 */
async function sendKeys(id, keys, options = {}) {
  const name = `${SESSION_PREFIX}${id}`;
  const { withEnter = false } = options;

  // Check if session exists first
  const alive = await isSessionAlive(id);
  if (!alive) {
    console.warn(`sendKeys: session ${name} not found (may have been started outside Claude Go)`);
    return false;
  }

  const keysToSend = withEnter ? [keys, 'Enter'] : [keys];
  debugKeys('sendKeys', name, keysToSend);

  console.log(`sendKeys: BEFORE tmux send-keys -t ${name} ${keys}${withEnter ? ' Enter' : ''}`);
  await tmuxSpawn(['send-keys', '-t', name, keys]);
  if (withEnter) {
    await tmuxSpawn(['send-keys', '-t', name, 'Enter']);
  }
  console.log(`sendKeys: AFTER tmux send-keys -t ${name} ${keys}${withEnter ? ' Enter' : ''}`);
  return true;
}

/**
 * Kill a Claude session
 * @param {string} id - Session ID
 */
async function killSession(id) {
  const name = `${SESSION_PREFIX}${id}`;
  await execAsync(`tmux kill-session -t "${name}" 2>/dev/null || true`);
}

/**
 * Check if a session is alive
 * @param {string} id - Session ID
 * @returns {Promise<boolean>}
 */
async function isSessionAlive(id) {
  const name = `${SESSION_PREFIX}${id}`;
  try {
    await execAsync(`tmux has-session -t "${name}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  listSessions,
  createSession,
  sendInput,
  sendInterrupt,
  sendKeys,
  killSession,
  isSessionAlive
};
