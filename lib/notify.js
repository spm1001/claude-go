/**
 * Push Notifications via ntfy.sh
 *
 * Sends notifications when Claude needs attention:
 * - Waiting for user input
 * - Permission requests
 * - Errors
 *
 * TODO: Implement (bead claude-go-ero)
 */

const NTFY_TOPIC = process.env.NTFY_TOPIC || 'sameer-claude-go';
const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';

/**
 * Send a push notification
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} options - Additional options (priority, tags, etc.)
 */
async function notify(title, body, options = {}) {
  // TODO: Implement
  console.log(`[notify stub] ${title}: ${body}`);
}

/**
 * Notify that Claude is waiting for input
 * @param {string} sessionId - Session that needs attention
 */
async function notifyWaiting(sessionId) {
  await notify('Claude waiting', `Session ${sessionId.slice(0, 8)} needs input`);
}

/**
 * Notify that Claude is requesting permission
 * @param {string} sessionId - Session ID
 * @param {string} tool - Tool requesting permission
 */
async function notifyPermission(sessionId, tool) {
  await notify('Permission request', `${tool} in session ${sessionId.slice(0, 8)}`, {
    priority: 'high'
  });
}

module.exports = {
  notify,
  notifyWaiting,
  notifyPermission,
  NTFY_TOPIC,
  NTFY_SERVER
};
