/**
 * Session Manager - tmux wrapper for Claude sessions
 *
 * Manages Claude CLI processes inside tmux sessions for persistence.
 * Sessions survive browser disconnects and can be resumed from any device.
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const path = require('path');

const execAsync = promisify(exec);

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
 * @param {string} action - Optional action: 'approve', 'reject', 'continue'
 */
async function sendInput(id, text, action) {
  const name = `${SESSION_PREFIX}${id}`;

  // Handle special actions (simple chars, exec is fine)
  if (action === 'approve') {
    await tmuxSpawn(['send-keys', '-t', name, 'y', 'Enter']);
    return;
  }

  if (action === 'reject') {
    await tmuxSpawn(['send-keys', '-t', name, 'n', 'Enter']);
    return;
  }

  if (action === 'continue' || (!text && !action)) {
    await tmuxSpawn(['send-keys', '-t', name, 'Enter']);
    return;
  }

  // Answer a question (select option, tab to submit, enter)
  if (action === 'answer') {
    await tmuxSpawn(['send-keys', '-t', name, text]);  // Select option by number
    await tmuxSpawn(['send-keys', '-t', name, 'Tab']); // Navigate to Submit
    await tmuxSpawn(['send-keys', '-t', name, 'Enter']); // Submit
    return;
  }

  // Answer multi-select (toggle each option, then tab to submit, enter)
  if (action === 'answer-multi') {
    // text is comma-separated indices like "1,3"
    const indices = text.split(',').filter(s => s.trim());
    for (const idx of indices) {
      await tmuxSpawn(['send-keys', '-t', name, idx.trim()]); // Toggle option
    }
    await tmuxSpawn(['send-keys', '-t', name, 'Tab']); // Navigate to Submit
    await tmuxSpawn(['send-keys', '-t', name, 'Enter']); // Submit
    return;
  }

  // Use spawn with -l (literal) flag - bypasses shell, handles all special chars
  await tmuxSpawn(['send-keys', '-t', name, '-l', text]);
  await tmuxSpawn(['send-keys', '-t', name, 'Enter']);
}

/**
 * Send interrupt (Ctrl+C) to a session
 * @param {string} id - Session ID
 */
async function sendInterrupt(id) {
  const name = `${SESSION_PREFIX}${id}`;
  await tmuxSpawn(['send-keys', '-t', name, 'C-c']);
}

/**
 * Send raw keys to a session (for permission prompts)
 * @param {string} id - Session ID
 * @param {string} keys - Keys to send (e.g., '1', 'Escape', 'y')
 * @returns {Promise<boolean>} - true if sent, false if session not found
 */
async function sendKeys(id, keys) {
  const name = `${SESSION_PREFIX}${id}`;

  // Check if session exists first
  const alive = await isSessionAlive(id);
  if (!alive) {
    console.warn(`sendKeys: session ${name} not found (may have been started outside Claude Go)`);
    return false;
  }

  console.log(`sendKeys: BEFORE tmux send-keys -t ${name} ${keys}`);
  await tmuxSpawn(['send-keys', '-t', name, keys]);
  console.log(`sendKeys: AFTER tmux send-keys -t ${name} ${keys}`);
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
