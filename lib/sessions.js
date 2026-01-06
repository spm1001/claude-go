/**
 * Session Manager - tmux wrapper for Claude sessions
 *
 * Manages Claude CLI processes inside tmux sessions for persistence.
 * Sessions survive browser disconnects and can be resumed from any device.
 */

const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const path = require('path');

const execAsync = promisify(exec);

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
 * @param {string} action - Optional action: 'approve', 'reject', 'continue'
 */
async function sendInput(id, text, action) {
  const name = `${SESSION_PREFIX}${id}`;

  // Handle special actions
  if (action === 'approve') {
    // Send 'y' for approval prompts
    await execAsync(`tmux send-keys -t "${name}" 'y' Enter`);
    return;
  }

  if (action === 'reject') {
    // Send 'n' for rejection
    await execAsync(`tmux send-keys -t "${name}" 'n' Enter`);
    return;
  }

  if (action === 'continue' || (!text && !action)) {
    // Just send Enter to continue
    await execAsync(`tmux send-keys -t "${name}" Enter`);
    return;
  }

  // Escape special characters for tmux
  // Use -l flag for literal interpretation
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');

  // For multi-line input, send as literal with -l flag
  if (text.includes('\n')) {
    await execAsync(`tmux send-keys -t "${name}" -l '${escaped}'`);
    await execAsync(`tmux send-keys -t "${name}" Enter`);
  } else {
    await execAsync(`tmux send-keys -t "${name}" '${escaped}' Enter`);
  }
}

/**
 * Send interrupt (Ctrl+C) to a session
 * @param {string} id - Session ID
 */
async function sendInterrupt(id) {
  const name = `${SESSION_PREFIX}${id}`;
  await execAsync(`tmux send-keys -t "${name}" C-c`);
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
  killSession,
  isSessionAlive
};
