/**
 * Claude Go - Client Application
 *
 * Handles:
 * - Session listing and selection
 * - WebSocket connection for real-time updates
 * - Message rendering with markdown
 * - Input handling and quick actions
 * - Device heartbeat for lease management
 */

// =============================================================================
// State
// =============================================================================

const state = {
  currentSession: null,
  ws: null,
  deviceId: localStorage.getItem('deviceId') || `device-${Date.now()}`,
  messages: [],
  heartbeatInterval: null,
  pendingPermissions: new Map() // tool_use_id -> permission data
};

// Save device ID for persistence across reloads
localStorage.setItem('deviceId', state.deviceId);

// =============================================================================
// DOM Elements
// =============================================================================

const elements = {
  sessionPicker: document.getElementById('session-picker'),
  sessionsList: document.getElementById('sessions-list'),
  newSessionBtn: document.getElementById('new-session-btn'),
  chatView: document.getElementById('chat-view'),
  backBtn: document.getElementById('back-btn'),
  sessionName: document.getElementById('session-name'),
  sessionStatus: document.getElementById('session-status'),
  menuBtn: document.getElementById('menu-btn'),
  messagesContainer: document.getElementById('messages-container'),
  quickActions: document.getElementById('quick-actions'),
  messageInput: document.getElementById('message-input'),
  sendBtn: document.getElementById('send-btn'),
  takeoverBanner: document.getElementById('takeover-banner'),
  takeBackBtn: document.getElementById('take-back-btn')
};

// =============================================================================
// API Functions
// =============================================================================

async function fetchSessions() {
  const res = await fetch('/api/sessions');
  return res.json();
}

async function createSession() {
  const res = await fetch('/api/sessions', { method: 'POST' });
  return res.json();
}

async function fetchSessionContent(sessionId) {
  const res = await fetch(`/api/sessions/${sessionId}`);
  return res.json();
}

async function sendInput(text, action) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'input', text, action }));
  }
}

async function sendInterrupt() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'interrupt' }));
  }
}

// =============================================================================
// WebSocket Connection
// =============================================================================

function connectWebSocket(sessionId) {
  // Close existing connection
  if (state.ws) {
    state.ws.close();
    clearInterval(state.heartbeatInterval);
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}`;

  state.ws = new WebSocket(wsUrl);
  state.ws.onopen = async () => {
    console.log('WebSocket connected');
    updateStatus('connected', 'Connected');

    // Fetch any pending permissions for this session
    try {
      const res = await fetch(`/hook/pending?session_id=${sessionId}`);
      const pending = await res.json();
      pending.forEach(p => state.pendingPermissions.set(p.tool_use_id, p));
      renderPermissionBanner();
    } catch (err) {
      console.error('Error fetching pending permissions:', err);
    }

    // Start heartbeat
    state.heartbeatInterval = setInterval(() => {
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 5000);
  };

  state.ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleWebSocketMessage(msg);
  };

  state.ws.onclose = () => {
    console.log('WebSocket disconnected');
    clearInterval(state.heartbeatInterval);
    updateStatus('disconnected', 'Disconnected');
  };

  state.ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function handleWebSocketMessage(msg) {
  switch (msg.type) {
    case 'messages':
      // New messages from JSONL watcher
      for (const m of msg.data) {
        // If it's a confirmed user message, remove any pending ones
        if (m.type === 'user') {
          document.querySelectorAll('.message.pending').forEach(el => el.remove());
          state.messages = state.messages.filter(msg => !msg.pending);
        }
        addOrUpdateMessage(m);
      }
      scrollToBottom();
      break;

    case 'waiting':
      // Claude is waiting for input - show quick actions
      elements.quickActions.classList.remove('hidden');
      break;

    case 'session-taken':
      // Another device took the session
      elements.takeoverBanner.classList.remove('hidden');
      elements.messageInput.disabled = true;
      elements.sendBtn.disabled = true;
      break;

    case 'heartbeat-ack':
      // Heartbeat acknowledged
      break;

    case 'permission_request':
      // Claude needs permission approval
      handlePermissionRequest(msg.data);
      break;

    case 'permission_resolved':
      // Permission was handled (by us or another device)
      handlePermissionResolved(msg.data);
      break;
  }
}

// =============================================================================
// UI Functions
// =============================================================================

function showSessionPicker() {
  elements.sessionPicker.classList.remove('hidden');
  elements.chatView.classList.add('hidden');
  state.currentSession = null;
  loadSessions();
}

function showChatView(sessionId) {
  elements.sessionPicker.classList.add('hidden');
  elements.chatView.classList.remove('hidden');
  state.currentSession = sessionId;
  elements.sessionName.textContent = `Session ${sessionId.slice(0, 8)}...`;
  loadSessionContent(sessionId);
  connectWebSocket(sessionId);
}

async function loadSessions() {
  elements.sessionsList.innerHTML = '<p class="loading">Loading sessions...</p>';

  try {
    const sessions = await fetchSessions();

    if (sessions.length === 0) {
      elements.sessionsList.innerHTML = '<p class="loading">No sessions yet</p>';
      return;
    }

    elements.sessionsList.innerHTML = sessions.map(s => `
      <div class="session-card" data-id="${s.id}">
        <div class="info">
          <div class="name">${s.id.slice(0, 8)}...</div>
          <div class="preview">Last activity: ${formatTime(s.activity * 1000)}</div>
        </div>
        <div class="status-dot ${s.alive ? 'alive' : 'dead'}"></div>
      </div>
    `).join('');

    // Add click handlers
    document.querySelectorAll('.session-card').forEach(card => {
      card.addEventListener('click', () => {
        showChatView(card.dataset.id);
      });
    });
  } catch (err) {
    console.error('Error loading sessions:', err);
    elements.sessionsList.innerHTML = '<p class="loading">Error loading sessions</p>';
  }
}

async function loadSessionContent(sessionId) {
  elements.messagesContainer.innerHTML = '<p class="loading">Loading conversation...</p>';
  state.messages = [];

  try {
    const messages = await fetchSessionContent(sessionId);
    elements.messagesContainer.innerHTML = '';

    for (const msg of messages) {
      addOrUpdateMessage(msg);
    }

    scrollToBottom();
  } catch (err) {
    console.error('Error loading session:', err);
    elements.messagesContainer.innerHTML = '<p class="loading">Error loading conversation</p>';
  }
}

function addOrUpdateMessage(msg) {
  // Check if message already exists
  const existing = state.messages.find(m => m.uuid === msg.uuid);
  if (existing) {
    // Update existing
    Object.assign(existing, msg);
    const el = document.querySelector(`[data-uuid="${msg.uuid}"]`);
    if (el) {
      el.outerHTML = renderMessage(msg);
    }
  } else {
    // Add new
    state.messages.push(msg);
    elements.messagesContainer.insertAdjacentHTML('beforeend', renderMessage(msg));
  }

  // Highlight code blocks
  document.querySelectorAll('pre code:not(.hljs)').forEach(block => {
    hljs.highlightElement(block);
  });
}

function renderMessage(msg) {
  const typeClass = msg.type === 'user' ? 'user' : 'assistant';
  let content = '';

  if (msg.type === 'user') {
    content = escapeHtml(msg.content || '');
  } else if (msg.type === 'tool_result_message') {
    // Tool result messages (rendered like assistant messages)
    if (Array.isArray(msg.content)) {
      content = msg.content.map(block => {
        if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content, null, 2);
          const errorClass = block.is_error ? ' error' : '';
          return `
            <div class="tool-result${errorClass}">
              <div class="tool-result-header">${block.is_error ? 'Error' : 'Result'}</div>
              <pre><code>${escapeHtml(resultContent)}</code></pre>
            </div>
          `;
        }
        return '';
      }).join('');
    }
  } else if (msg.type === 'assistant') {
    // Render assistant content (may be array of blocks)
    if (Array.isArray(msg.content)) {
      content = msg.content.map(block => {
        if (block.type === 'text') {
          return renderMarkdown(block.text);
        } else if (block.type === 'tool_use') {
          // Special rendering for AskUserQuestion
          if (block.name === 'AskUserQuestion' && block.input?.questions) {
            return block.input.questions.map((q, qIdx) => {
              const questionId = `q-${block.id}-${qIdx}`;
              if (q.multiSelect) {
                // MultiSelect: toggle buttons with submit
                return `
                  <div class="ask-user-question" data-question-id="${questionId}">
                    <div class="question-header">${escapeHtml(q.header || 'Question')}</div>
                    <div class="question-text">${escapeHtml(q.question)}</div>
                    <div class="question-options multi-select">
                      ${q.options.map((opt, i) => `
                        <button class="question-option" data-index="${i + 1}" onclick="toggleOption(this)">
                          <span class="option-label">${escapeHtml(opt.label)}</span>
                          <span class="option-desc">${escapeHtml(opt.description || '')}</span>
                        </button>
                      `).join('')}
                    </div>
                    <button class="question-submit" onclick="submitMultiSelect(this)">Submit</button>
                  </div>
                `;
              } else {
                // Single select: immediate send
                return `
                  <div class="ask-user-question">
                    <div class="question-header">${escapeHtml(q.header || 'Question')}</div>
                    <div class="question-text">${escapeHtml(q.question)}</div>
                    <div class="question-options">
                      ${q.options.map((opt, i) => `
                        <button class="question-option" onclick="sendQuestionResponse(${i + 1})">
                          <span class="option-label">${escapeHtml(opt.label)}</span>
                          <span class="option-desc">${escapeHtml(opt.description || '')}</span>
                        </button>
                      `).join('')}
                    </div>
                  </div>
                `;
              }
            }).join('');
          }
          return `
            <div class="tool-use">
              <div class="tool-name">${escapeHtml(block.name)}</div>
              <pre><code class="language-json">${escapeHtml(JSON.stringify(block.input, null, 2))}</code></pre>
            </div>
          `;
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content, null, 2);
          return `
            <div class="tool-result">
              <div class="tool-result-header">Result</div>
              <pre><code>${escapeHtml(resultContent)}</code></pre>
            </div>
          `;
        }
        return '';
      }).join('');
    } else if (typeof msg.content === 'string') {
      content = renderMarkdown(msg.content);
    }
  } else if (msg.type === 'hidden') {
    // Hide caveat messages
    return '';
  } else if (msg.type === 'local_command_output') {
    // Local command output: render as assistant-style response
    return `
      <div class="message assistant local-command-output" data-uuid="${msg.uuid}">
        <div class="content"><pre>${escapeHtml(msg.content)}</pre></div>
      </div>
    `;
  } else if (msg.type === 'summary') {
    content = `<em>${escapeHtml(msg.content)}</em>`;
  }

  // Skip empty messages
  if (!content.trim()) {
    return '';
  }

  const pendingClass = msg.pending ? ' pending' : '';
  return `
    <div class="message ${typeClass}${pendingClass}" data-uuid="${msg.uuid}">
      <div class="content">${content}</div>
    </div>
  `;
}

function renderMarkdown(text) {
  if (!text) return '';

  // Strip ANSI codes before markdown parsing
  text = stripAnsi(text);

  // Configure marked
  marked.setOptions({
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true
  });

  // Render and add copy buttons to code blocks
  let html = marked.parse(text);

  // Add copy buttons to pre blocks
  html = html.replace(/<pre>/g, '<pre><button class="copy-btn" onclick="copyCode(this)">Copy</button>');

  return html;
}

function updateStatus(type, text) {
  elements.sessionStatus.className = `status ${type}`;
  elements.sessionStatus.textContent = text;
}

function scrollToBottom() {
  elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
}

// =============================================================================
// Input Handling
// =============================================================================

function handleSend() {
  const text = elements.messageInput.value.trim();
  if (!text) return;

  // Slash commands are terminal-local (don't appear in JSONL), so skip optimistic display
  const isSlashCommand = text.startsWith('/');

  if (!isSlashCommand) {
    // Optimistically show user message immediately (italicised until confirmed)
    const tempUuid = `pending-${Date.now()}`;
    addOrUpdateMessage({
      uuid: tempUuid,
      type: 'user',
      content: text,
      pending: true
    });
    scrollToBottom();
  }

  sendInput(text, null);
  elements.messageInput.value = '';
  elements.messageInput.style.height = 'auto';
  elements.quickActions.classList.add('hidden');
}

function handleAction(action) {
  if (action === 'interrupt') {
    sendInterrupt();
  } else {
    sendInput(null, action);
  }
  elements.quickActions.classList.add('hidden');
}

// Auto-resize textarea
function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

// Send response to AskUserQuestion (1-indexed option number)
function sendQuestionResponse(optionNum) {
  sendInput(String(optionNum), null);
}

// Toggle option selection for multiSelect
function toggleOption(btn) {
  btn.classList.toggle('selected');
}

// Submit multiSelect response
function submitMultiSelect(btn) {
  const container = btn.closest('.ask-user-question');
  if (!container) {
    console.error('Could not find question container');
    return;
  }

  const selected = container.querySelectorAll('.question-option.selected');
  const indices = Array.from(selected).map(b => b.dataset.index);

  if (indices.length === 0) {
    // Nothing selected, maybe just press enter or send empty?
    sendInput('', null);
  } else {
    // Send comma-separated indices
    sendInput(indices.join(','), null);
  }
}

// Make functions globally available for onclick handlers
window.sendQuestionResponse = sendQuestionResponse;
window.toggleOption = toggleOption;
window.submitMultiSelect = submitMultiSelect;

// =============================================================================
// Permission Handling
// =============================================================================

/**
 * Handle incoming permission request from WebSocket
 */
function handlePermissionRequest(permission) {
  console.log('Permission request:', permission);
  state.pendingPermissions.set(permission.tool_use_id, permission);
  renderPermissionBanner();
}

/**
 * Handle permission resolved (approved/denied)
 */
function handlePermissionResolved(data) {
  console.log('Permission resolved:', data);
  state.pendingPermissions.delete(data.tool_use_id);
  renderPermissionBanner();
}

/**
 * Render the permission banner showing pending approvals
 */
function renderPermissionBanner() {
  // Get or create permission banner container
  let banner = document.getElementById('permission-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'permission-banner';
    banner.className = 'permission-banner';
    // Insert at top of chat view
    const chatView = document.getElementById('chat-view');
    chatView.insertBefore(banner, chatView.firstChild.nextSibling);
  }

  // If no pending permissions, hide banner
  if (state.pendingPermissions.size === 0) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }

  // Render permission cards
  banner.classList.remove('hidden');
  banner.innerHTML = Array.from(state.pendingPermissions.values()).map(p => {
    const inputPreview = formatToolInput(p.tool_name, p.tool_input);
    return `
      <div class="permission-card" data-tool-use-id="${p.tool_use_id}">
        <div class="permission-header">
          <span class="permission-tool">${escapeHtml(p.tool_name)}</span>
          <span class="permission-time">${formatTime(p.received_at)}</span>
        </div>
        <div class="permission-preview">${escapeHtml(inputPreview)}</div>
        <div class="permission-actions">
          <button class="permission-btn approve" onclick="respondToPermission('${p.tool_use_id}', '${p.session_id}', true)">
            Approve
          </button>
          <button class="permission-btn deny" onclick="respondToPermission('${p.tool_use_id}', '${p.session_id}', false)">
            Deny
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Format tool input for display
 */
function formatToolInput(toolName, input) {
  if (!input) return '';

  switch (toolName) {
    case 'Write':
    case 'Edit':
      return input.file_path || '';
    case 'Bash':
      return input.command?.slice(0, 100) || '';
    case 'Read':
      return input.file_path || '';
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}

/**
 * Send permission response to server
 */
async function respondToPermission(toolUseId, sessionId, approved) {
  try {
    const res = await fetch('/hook/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_use_id: toolUseId,
        session_id: sessionId,
        approved
      })
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 404) {
        // Session not found - started outside Claude Go
        alert('Session not found. This Claude session may have been started outside Claude Go.');
        // Still remove from UI since we can't handle it
        state.pendingPermissions.delete(toolUseId);
        renderPermissionBanner();
        return;
      }
      throw new Error(data.error || 'Failed to send response');
    }

    // Remove from local state (server will also broadcast permission_resolved)
    state.pendingPermissions.delete(toolUseId);
    renderPermissionBanner();
  } catch (err) {
    console.error('Error responding to permission:', err);
    alert('Failed to send permission response: ' + err.message);
  }
}

// Make respondToPermission globally available
window.respondToPermission = respondToPermission;

// =============================================================================
// Utility Functions
// =============================================================================

function stripAnsi(text) {
  // Remove ANSI escape codes (colors, cursor movement, etc.)
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = stripAnsi(text);
  return div.innerHTML;
}

function formatTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

function copyCode(btn) {
  const pre = btn.parentElement;
  const code = pre.querySelector('code');
  navigator.clipboard.writeText(code.textContent);
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 1500);
}

// Make copyCode available globally
window.copyCode = copyCode;

// =============================================================================
// Event Listeners
// =============================================================================

elements.newSessionBtn.addEventListener('click', async () => {
  try {
    elements.newSessionBtn.disabled = true;
    elements.newSessionBtn.textContent = 'Creating...';
    const session = await createSession();
    showChatView(session.id);
  } catch (err) {
    console.error('Error creating session:', err);
    alert('Failed to create session');
  } finally {
    elements.newSessionBtn.disabled = false;
    elements.newSessionBtn.textContent = '+ New Session';
  }
});

elements.backBtn.addEventListener('click', () => {
  if (state.ws) {
    state.ws.close();
  }
  showSessionPicker();
});

elements.sendBtn.addEventListener('click', handleSend);

elements.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

elements.messageInput.addEventListener('input', () => {
  autoResize(elements.messageInput);
});

document.querySelectorAll('.action-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    handleAction(btn.dataset.action);
  });
});

elements.takeBackBtn.addEventListener('click', () => {
  // Reconnect to take back the session
  if (state.currentSession) {
    connectWebSocket(state.currentSession);
    elements.takeoverBanner.classList.add('hidden');
    elements.messageInput.disabled = false;
    elements.sendBtn.disabled = false;
  }
});

// =============================================================================
// Initialize
// =============================================================================

showSessionPicker();
