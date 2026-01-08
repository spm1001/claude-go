// THIS IS THE ONE TRUE VERSION - 2026-01-08 20:45
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
// Constants
// =============================================================================

/**
 * Action names used in data-action attributes.
 * Centralizes magic strings to prevent typos and enable find-all-references.
 */
const ACTIONS = {
  // Message container actions
  COPY: 'copy',

  // Inline card actions (rendered but read-only - interactions via panel)
  INLINE_SELECT: 'select',
  INLINE_TOGGLE: 'toggle',
  INLINE_SUBMIT_MULTI: 'submit-multi',
  INLINE_APPROVE_PLAN: 'approve-plan',
  INLINE_REJECT_PLAN: 'reject-plan',

  // Panel actions (active - these are clickable)
  SELECT_OPTION: 'select-option',
  PERM_APPROVE: 'perm-approve',
  PERM_ALWAYS: 'perm-always',
  PERM_DENY: 'perm-deny',
  PLAN_APPROVE: 'plan-approve',
  PLAN_REJECT: 'plan-reject',
  DISMISS: 'dismiss',
};

// =============================================================================
// State
// =============================================================================

const state = {
  currentSession: null,
  ws: null,
  deviceId: localStorage.getItem('deviceId') || `device-${Date.now()}`,
  messages: [],
  heartbeatInterval: null,
  pendingPermissions: new Map(), // tool_use_id -> permission data
  answeredQuestions: new Set(),  // question IDs that have been answered
  respondingPermissions: new Set(), // permission IDs with in-flight responses
  // Bottom panel interaction state
  currentInteraction: null, // { type, tool_use_id, questions, currentIndex, answers, multiSelectState }
};

// Save device ID for persistence across reloads
localStorage.setItem('deviceId', state.deviceId);

// =============================================================================
// State/DOM Sync Helpers
// =============================================================================

/**
 * Mark a question as answered (updates both state and DOM).
 * Single source of truth pattern - call this instead of updating separately.
 */
function markQuestionAnswered(questionId) {
  state.answeredQuestions.add(questionId);
  const card = document.querySelector(`[data-question-id="${questionId}"]`);
  if (card) card.classList.add('answered');
}

/**
 * Mark a plan as answered (updates both state and DOM).
 */
function markPlanAnswered(planId) {
  state.answeredQuestions.add(planId);
  const card = document.querySelector(`[data-plan-id="${planId}"]`);
  if (card) card.classList.add('answered');
}

/**
 * Mark all questions for a tool_use as answered.
 * Used when dismissing or completing multi-question flows.
 */
function markAllQuestionsAnswered(toolUseId, questionCount) {
  for (let i = 0; i < questionCount; i++) {
    markQuestionAnswered(`q-${toolUseId}-${i}`);
  }
}

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
  terminalBtn: document.getElementById('terminal-btn'),
  messagesContainer: document.getElementById('messages-container'),
  quickActions: document.getElementById('quick-actions'),
  messageInput: document.getElementById('message-input'),
  sendBtn: document.getElementById('send-btn'),
  takeoverBanner: document.getElementById('takeover-banner'),
  takeBackBtn: document.getElementById('take-back-btn'),
  // Interaction panel elements
  interactionPanel: document.getElementById('interaction-panel'),
  interactionChip: document.querySelector('.interaction-chip'),
  interactionProgress: document.querySelector('.interaction-progress'),
  interactionQuestion: document.querySelector('.interaction-question'),
  interactionOptions: document.querySelector('.interaction-options'),
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
  console.log(`[sendInput] text="${text}" action="${action}" ws=${state.ws?.readyState}`);
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'input', text, action }));
    console.log(`[sendInput] SENT via WebSocket`);
  } else {
    console.log(`[sendInput] WebSocket not open! state=${state.ws?.readyState}`);
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

    // Fetch any pending permissions for this session
    try {
      const res = await fetch(`/hook/pending?session_id=${sessionId}`);
      const pending = await res.json();
      pending.forEach(p => state.pendingPermissions.set(p.tool_use_id, p));
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
      // Check for new interactions to show in bottom panel
      checkForPendingInteractions();
      break;

    case 'reload':
      // Hot reload triggered by server (dev mode)
      console.log('[hot-reload] Reloading page...');
      location.reload();
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
  state.answeredQuestions.clear(); // Reset for new session

  try {
    const messages = await fetchSessionContent(sessionId);

    // Pre-populate answeredQuestions from historical tool_results
    const toolUseIds = new Map(); // tool_use_id -> { type, questionCount }
    const answeredToolUseIds = new Set();

    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          // Track AskUserQuestion and ExitPlanMode tool_use blocks
          if (block.type === 'tool_use') {
            if (block.name === 'AskUserQuestion' && block.input?.questions) {
              toolUseIds.set(block.id, {
                type: 'question',
                count: block.input.questions.length
              });
            } else if (block.name === 'ExitPlanMode') {
              toolUseIds.set(block.id, { type: 'plan', count: 1 });
            }
          }
          // Track tool_results
          if (block.type === 'tool_result' && toolUseIds.has(block.tool_use_id)) {
            answeredToolUseIds.add(block.tool_use_id);
          }
        }
      }
    }

    // Mark answered questions/plans
    for (const [toolUseId, info] of toolUseIds) {
      if (answeredToolUseIds.has(toolUseId)) {
        if (info.type === 'question') {
          for (let i = 0; i < info.count; i++) {
            state.answeredQuestions.add(`q-${toolUseId}-${i}`);
          }
        } else if (info.type === 'plan') {
          state.answeredQuestions.add(`plan-${toolUseId}`);
        }
      }
    }

    elements.messagesContainer.innerHTML = '';

    for (const msg of messages) {
      addOrUpdateMessage(msg);
    }

    scrollToBottom();
    // Check for pending interactions
    checkForPendingInteractions();
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
      // Don't re-render if there are unanswered interactive elements (would swallow clicks)
      const hasUnansweredInteractive = el.querySelector('.ask-user-question:not(.answered), .exit-plan-mode:not(.answered)');
      if (!hasUnansweredInteractive) {
        el.outerHTML = renderMessage(msg);
      }
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
          // Special rendering for ExitPlanMode
          if (block.name === 'ExitPlanMode') {
            const planId = `plan-${block.id}`;
            const answeredClass = state.answeredQuestions.has(planId) ? ' answered' : '';
            return `
              <div class="exit-plan-mode${answeredClass}" data-plan-id="${planId}">
                <div class="plan-header">Implementation Plan</div>
                <div class="plan-content">${renderMarkdown(block.input?.plan || '')}</div>
                <div class="plan-actions">
                  <button class="plan-btn approve" data-action="${ACTIONS.INLINE_APPROVE_PLAN}">Approve</button>
                  <button class="plan-btn reject" data-action="${ACTIONS.INLINE_REJECT_PLAN}">Reject</button>
                </div>
              </div>
            `;
          }
          // Special rendering for AskUserQuestion
          if (block.name === 'AskUserQuestion' && block.input?.questions) {
            return block.input.questions.map((q, qIdx) => {
              const questionId = `q-${block.id}-${qIdx}`;
              const answeredClass = state.answeredQuestions.has(questionId) ? ' answered' : '';
              if (q.multiSelect) {
                // MultiSelect: toggle buttons with submit
                return `
                  <div class="ask-user-question${answeredClass}" data-question-id="${questionId}" data-multi-select="true">
                    <div class="question-header">${escapeHtml(q.header || 'Question')}</div>
                    <div class="question-text">${escapeHtml(q.question)}</div>
                    <div class="question-options multi-select">
                      ${q.options.map((opt, i) => `
                        <button class="question-option" data-action="${ACTIONS.INLINE_TOGGLE}" data-index="${i + 1}">
                          <span class="option-label">${escapeHtml(opt.label)}</span>
                          <span class="option-desc">${escapeHtml(opt.description || '')}</span>
                        </button>
                      `).join('')}
                    </div>
                    <button class="question-submit" data-action="${ACTIONS.INLINE_SUBMIT_MULTI}">Submit</button>
                  </div>
                `;
              } else {
                // Single select: immediate send
                return `
                  <div class="ask-user-question${answeredClass}" data-question-id="${questionId}">
                    <div class="question-header">${escapeHtml(q.header || 'Question')}</div>
                    <div class="question-text">${escapeHtml(q.question)}</div>
                    <div class="question-options">
                      ${q.options.map((opt, i) => `
                        <button class="question-option" data-action="${ACTIONS.INLINE_SELECT}" data-index="${i + 1}">
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
  html = html.replace(/<pre>/g, `<pre><button class="copy-btn" data-action="${ACTIONS.COPY}">Copy</button>`);

  return html;
}

function scrollToBottom() {
  elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
}

// =============================================================================
// Input Handling
// =============================================================================

function handleSend() {
  const text = elements.messageInput.value.trim();
  const interaction = state.currentInteraction;
  console.log(`[handleSend] text="${text}" interaction=${interaction?.type || 'none'}`);

  // Handle contextual submit based on current interaction
  if (interaction) {
    if (interaction.type === 'question') {
      // "Other..." or "Submit" for questions
      const question = interaction.questions[interaction.currentIndex];
      console.log(`[handleSend] question multiSelect=${question.multiSelect}`);
      if (question.multiSelect) {
        // Multi-select: submit selections (and typed text if any)
        console.log(`[handleSend] calling submitQuestionAnswer`);
        submitQuestionAnswer(text || null);
      } else if (text) {
        // Single-select with typed text: send as "Other"
        submitQuestionAnswer(text);
      }
      // If no text and single-select, ignore (user should tap an option)
      elements.messageInput.value = '';
      elements.messageInput.style.height = 'auto';
      return;
    } else if (interaction.type === 'plan' && text) {
      // "Edit..." - send feedback and reject
      markPlanAnswered(`plan-${interaction.tool_use_id}`);
      sendInput(text, null); // Send feedback as message
      clearInteractionPanel();
      elements.messageInput.value = '';
      elements.messageInput.style.height = 'auto';
      return;
    } else if (interaction.type === 'permission' && text) {
      // Send instructions after dismissing permission
      handleDismiss();
      // Then send the instructions as a follow-up message
      sendInput(text, null);
      elements.messageInput.value = '';
      elements.messageInput.style.height = 'auto';
      return;
    }
  }

  // Normal message send
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

// Question/interaction handlers are now via event delegation (see Event Listeners section)

// =============================================================================
// Permission Handling
// =============================================================================

/**
 * Handle incoming permission request from WebSocket
 */
function handlePermissionRequest(permission) {
  console.log('Permission request:', permission);
  state.pendingPermissions.set(permission.tool_use_id, permission);
  // Show in bottom panel
  checkForPendingInteractions();
}

/**
 * Handle permission resolved (approved/denied)
 */
function handlePermissionResolved(data) {
  console.log('Permission resolved:', data);
  state.pendingPermissions.delete(data.tool_use_id);
  // Clear from bottom panel if it was showing this permission
  if (state.currentInteraction?.tool_use_id === data.tool_use_id) {
    clearInteractionPanel();
  }
  // Check for next pending interaction
  checkForPendingInteractions();
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
  // Guard against double-clicks
  if (state.respondingPermissions.has(toolUseId)) return;
  state.respondingPermissions.add(toolUseId);

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
        return;
      }
      throw new Error(data.error || 'Failed to send response');
    }

    // Remove from local state (server will also broadcast permission_resolved)
    state.pendingPermissions.delete(toolUseId);
  } catch (err) {
    console.error('Error responding to permission:', err);
    alert('Failed to send permission response: ' + err.message);
  } finally {
    state.respondingPermissions.delete(toolUseId);
  }
}

// Permission handlers are now via event delegation (see Event Listeners section)

// =============================================================================
// Interaction Panel (Unified Bottom Panel)
// =============================================================================

/**
 * Show an AskUserQuestion in the bottom panel
 */
function showQuestionInPanel(toolUseId, questions) {
  // Don't show if already answered
  const firstQuestionId = `q-${toolUseId}-0`;
  if (state.answeredQuestions.has(firstQuestionId)) return;

  state.currentInteraction = {
    type: 'question',
    tool_use_id: toolUseId,
    questions: questions,
    currentIndex: 0,
    answers: [],
    multiSelectState: {} // { optionIndex: boolean }
  };

  renderInteractionPanel();
}

/**
 * Show a permission prompt in the bottom panel
 */
function showPermissionInPanel(permission) {
  state.currentInteraction = {
    type: 'permission',
    tool_use_id: permission.tool_use_id,
    session_id: permission.session_id,
    tool_name: permission.tool_name,
    tool_input: permission.tool_input
  };

  renderInteractionPanel();
}

/**
 * Show ExitPlanMode in the bottom panel
 */
function showPlanInPanel(toolUseId) {
  const planId = `plan-${toolUseId}`;
  if (state.answeredQuestions.has(planId)) return;

  state.currentInteraction = {
    type: 'plan',
    tool_use_id: toolUseId
  };

  renderInteractionPanel();
}

/**
 * Clear the interaction panel
 */
function clearInteractionPanel() {
  state.currentInteraction = null;
  elements.interactionPanel.classList.add('hidden');
  elements.sendBtn.textContent = 'Send';
  elements.messageInput.placeholder = 'Message Claude...';
}

/**
 * Render the interaction panel based on current state
 */
function renderInteractionPanel() {
  const interaction = state.currentInteraction;

  if (!interaction) {
    elements.interactionPanel.classList.add('hidden');
    elements.sendBtn.textContent = 'Send';
    elements.messageInput.placeholder = 'Message Claude...';
    return;
  }

  elements.interactionPanel.classList.remove('hidden');

  if (interaction.type === 'question') {
    renderQuestionPanel(interaction);
  } else if (interaction.type === 'permission') {
    renderPermissionPanel(interaction);
  } else if (interaction.type === 'plan') {
    renderPlanPanel(interaction);
  }
}

/**
 * Render AskUserQuestion in the panel
 */
function renderQuestionPanel(interaction) {
  const question = interaction.questions[interaction.currentIndex];
  const isMultiSelect = question.multiSelect;
  const isLastQuestion = interaction.currentIndex === interaction.questions.length - 1;
  const totalQuestions = interaction.questions.length;

  // Header
  elements.interactionChip.textContent = `□ ${question.header || 'Question'}`;
  elements.interactionProgress.textContent = totalQuestions > 1
    ? `(${interaction.currentIndex + 1}/${totalQuestions})`
    : '';

  // Question text
  elements.interactionQuestion.textContent = question.question;

  // Options
  let optionsHtml = question.options.map((opt, i) => {
    const index = i + 1;
    const isSelected = interaction.multiSelectState[index];
    const selectedClass = isSelected ? ' selected' : '';
    const checkbox = isMultiSelect
      ? `<span class="option-checkbox">${isSelected ? '[✓]' : '[ ]'}</span>`
      : `<span class="option-number">${index}.</span>`;

    return `
      <button class="interaction-option${selectedClass}" data-action="${ACTIONS.SELECT_OPTION}" data-index="${index}">
        <div>
          ${checkbox}
          <span class="option-label">${escapeHtml(opt.label)}</span>
        </div>
        ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}
      </button>
    `;
  }).join('');

  elements.interactionOptions.innerHTML = optionsHtml;

  // Update send button label
  if (isMultiSelect) {
    elements.sendBtn.textContent = 'Submit';
  } else if (isLastQuestion && totalQuestions > 1) {
    elements.sendBtn.textContent = 'Submit';
  } else {
    elements.sendBtn.textContent = 'Other…';
  }

  elements.messageInput.placeholder = 'Type something...';
}

/**
 * Render permission prompt in the panel
 */
function renderPermissionPanel(interaction) {
  // Header
  elements.interactionChip.textContent = `⚠ ${interaction.tool_name}`;
  elements.interactionProgress.textContent = '';

  // Preview (file path, command, etc)
  const preview = formatToolInput(interaction.tool_name, interaction.tool_input);
  elements.interactionQuestion.innerHTML = `<div class="interaction-preview">${escapeHtml(preview)}</div>`;

  // Permission buttons
  elements.interactionOptions.innerHTML = `
    <div class="permission-buttons">
      <button class="perm-btn approve" data-action="${ACTIONS.PERM_APPROVE}">Approve</button>
      <button class="perm-btn always" data-action="${ACTIONS.PERM_ALWAYS}">Always</button>
      <button class="perm-btn deny" data-action="${ACTIONS.PERM_DENY}">Deny</button>
    </div>
  `;

  elements.sendBtn.textContent = 'Send';
  elements.messageInput.placeholder = 'Instructions for Claude...';
}

/**
 * Render plan approval in the panel
 */
function renderPlanPanel(interaction) {
  elements.interactionChip.textContent = '□ Plan Ready';
  elements.interactionProgress.textContent = '';
  elements.interactionQuestion.textContent = '(tap to scroll to plan above)';

  elements.interactionOptions.innerHTML = `
    <div class="permission-buttons">
      <button class="perm-btn approve" data-action="${ACTIONS.PLAN_APPROVE}">Approve</button>
      <button class="perm-btn deny" data-action="${ACTIONS.PLAN_REJECT}">Reject</button>
    </div>
  `;

  elements.sendBtn.textContent = 'Edit…';
  elements.messageInput.placeholder = 'Feedback on plan...';
}

/**
 * Handle option selection in question panel
 */
function handleOptionSelect(index) {
  const interaction = state.currentInteraction;
  if (!interaction || interaction.type !== 'question') return;

  const question = interaction.questions[interaction.currentIndex];

  if (question.multiSelect) {
    // Toggle selection
    interaction.multiSelectState[index] = !interaction.multiSelectState[index];
    console.log('[multiselect] Toggled index', index, '→', interaction.multiSelectState[index], 'State now:', JSON.stringify(interaction.multiSelectState));
    renderInteractionPanel();
  } else {
    // Single select - send immediately
    submitQuestionAnswer(String(index));
  }
}

/**
 * Submit the current question answer
 */
function submitQuestionAnswer(answer) {
  const interaction = state.currentInteraction;
  if (!interaction || interaction.type !== 'question') return;

  const question = interaction.questions[interaction.currentIndex];
  const isMultiSelect = question.multiSelect;
  const isLastQuestion = interaction.currentIndex === interaction.questions.length - 1;

  // For multi-select, build answer from selected options
  if (isMultiSelect && !answer) {
    console.log('[multiselect] Building answer from state:', JSON.stringify(interaction.multiSelectState));
    const selected = Object.entries(interaction.multiSelectState)
      .filter(([_, v]) => v)
      .map(([k, _]) => k);
    answer = selected.join(',');
    console.log('[multiselect] Built answer:', answer);
  }

  // Mark question as answered (updates both state and DOM)
  const questionId = `q-${interaction.tool_use_id}-${interaction.currentIndex}`;
  console.log(`[submit] About to markQuestionAnswered: ${questionId}`);
  try {
    markQuestionAnswered(questionId);
    console.log(`[submit] markQuestionAnswered succeeded`);
  } catch (e) {
    console.error(`[submit] markQuestionAnswered FAILED:`, e);
  }

  // Send the answer
  // For typed text (not a number), send directly without 'answer' action
  const isTypedText = isNaN(parseInt(answer, 10));
  console.log(`[submit] isMultiSelect=${isMultiSelect} isTypedText=${isTypedText} answer="${answer}"`);
  if (isMultiSelect) {
    console.log(`[submit] Calling sendInput for multiselect`);
    sendInput(answer, 'answer-multi');
  } else if (isTypedText) {
    // Typed "Other" response - need to select option N+1 (Type something), type text, submit
    // Format: "optionCount:text" so server knows which option to select
    const optionCount = question.options.length;
    sendInput(`${optionCount}:${answer}`, 'other');
  } else {
    sendInput(answer, 'answer');
  }

  // Move to next question or finish
  if (isLastQuestion) {
    clearInteractionPanel();
  } else {
    interaction.currentIndex++;
    interaction.multiSelectState = {};
    renderInteractionPanel();
  }
}

/**
 * Handle dismiss button
 */
function handleDismiss() {
  const interaction = state.currentInteraction;
  if (!interaction) return;

  // Send escape
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'escape' }));
  }

  // Mark as answered (wrapper updates both state and DOM)
  if (interaction.type === 'question') {
    markAllQuestionsAnswered(interaction.tool_use_id, interaction.questions.length);
  } else if (interaction.type === 'plan') {
    markPlanAnswered(`plan-${interaction.tool_use_id}`);
  } else if (interaction.type === 'permission') {
    // Remove from pending permissions
    state.pendingPermissions.delete(interaction.tool_use_id);
  }

  clearInteractionPanel();
}

/**
 * Check messages for pending interactions and show in panel
 */
function checkForPendingInteractions() {
  // Priority: permissions > questions > plans

  // 1. Check pending permissions
  if (state.pendingPermissions.size > 0) {
    const firstPerm = state.pendingPermissions.values().next().value;
    if (!state.currentInteraction || state.currentInteraction.tool_use_id !== firstPerm.tool_use_id) {
      showPermissionInPanel(firstPerm);
    }
    return;
  }

  // 2. Check for unanswered questions in messages
  for (const msg of state.messages) {
    if (msg.type !== 'assistant' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.input?.questions) {
        // Check if ANY question in this block is unanswered
        const questions = block.input.questions;
        const hasUnanswered = questions.some((_, idx) =>
          !state.answeredQuestions.has(`q-${block.id}-${idx}`)
        );

        if (hasUnanswered) {
          if (!state.currentInteraction || state.currentInteraction.tool_use_id !== block.id) {
            showQuestionInPanel(block.id, block.input.questions);
          }
          return;
        }
      }

      if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
        const planId = `plan-${block.id}`;
        if (!state.answeredQuestions.has(planId)) {
          if (!state.currentInteraction || state.currentInteraction.tool_use_id !== block.id) {
            showPlanInPanel(block.id);
          }
          return;
        }
      }
    }
  }

  // No pending interactions
  if (state.currentInteraction) {
    clearInteractionPanel();
  }
}

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

// copyCode is now via event delegation (see Event Listeners section)

// =============================================================================
// Event Listeners
// =============================================================================

// Event delegation for messages container (questions, copy buttons)
elements.messagesContainer.addEventListener('click', (e) => {
  const target = e.target;
  console.log(`[messagesContainer click] target=${target.tagName} action=${target.dataset?.action || target.closest('[data-action]')?.dataset?.action || 'none'}`);

  // Copy button
  const copyBtn = target.closest(`[data-action="${ACTIONS.COPY}"]`);
  if (copyBtn) {
    const pre = copyBtn.parentElement;
    const code = pre.querySelector('code');
    navigator.clipboard.writeText(code.textContent);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => copyBtn.textContent = 'Copy', 1500);
    return;
  }

  // Inline question and plan cards are read-only context.
  // All interactions go through the bottom panel (interactionPanel).

});

// Event delegation for interaction panel
elements.interactionPanel?.addEventListener('click', (e) => {
  const target = e.target;
  console.log(`[panel click] target=${target.tagName} action=${target.dataset?.action || target.closest('[data-action]')?.dataset?.action || 'none'}`);

  // Dismiss button
  if (target.closest(`[data-action="${ACTIONS.DISMISS}"]`)) {
    handleDismiss();
    return;
  }

  // Question option select
  const optionBtn = target.closest(`[data-action="${ACTIONS.SELECT_OPTION}"]`);
  if (optionBtn) {
    const index = parseInt(optionBtn.dataset.index, 10);
    handleOptionSelect(index);
    return;
  }

  // Permission approve
  if (target.closest(`[data-action="${ACTIONS.PERM_APPROVE}"]`)) {
    const interaction = state.currentInteraction;
    if (interaction?.type === 'permission') {
      respondToPermission(interaction.tool_use_id, interaction.session_id, true);
      clearInteractionPanel();
    }
    return;
  }

  // Permission always
  if (target.closest(`[data-action="${ACTIONS.PERM_ALWAYS}"]`)) {
    const interaction = state.currentInteraction;
    if (interaction?.type === 'permission') {
      // Send "3" for always trust (just number + Enter, no Tab)
      sendInput('3', null);
      state.pendingPermissions.delete(interaction.tool_use_id);
      clearInteractionPanel();
    }
    return;
  }

  // Permission deny
  if (target.closest(`[data-action="${ACTIONS.PERM_DENY}"]`)) {
    const interaction = state.currentInteraction;
    if (interaction?.type === 'permission') {
      respondToPermission(interaction.tool_use_id, interaction.session_id, false);
      clearInteractionPanel();
    }
    return;
  }

  // Plan approve
  if (target.closest(`[data-action="${ACTIONS.PLAN_APPROVE}"]`)) {
    const interaction = state.currentInteraction;
    if (interaction?.type === 'plan') {
      markPlanAnswered(`plan-${interaction.tool_use_id}`);
      sendInput('y', null);
      clearInteractionPanel();
    }
    return;
  }

  // Plan reject
  if (target.closest(`[data-action="${ACTIONS.PLAN_REJECT}"]`)) {
    const interaction = state.currentInteraction;
    if (interaction?.type === 'plan') {
      markPlanAnswered(`plan-${interaction.tool_use_id}`);
      sendInput('n', null);
      clearInteractionPanel();
    }
    return;
  }
});

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

elements.terminalBtn.addEventListener('click', () => {
  if (state.currentSession) {
    window.open(`/api/sessions/${state.currentSession}/terminal`, '_blank');
  }
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
