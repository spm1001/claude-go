/**
 * Claude Go - Self-hosted Claude Code web client
 *
 * Start tasks on mobile, close browser, get notified when Claude needs attention,
 * continue seamlessly on any device.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Configuration
const PORT = process.env.PORT || 7682;
const HOST = process.env.HOST || '0.0.0.0'; // Tailscale binding handled at firewall level
const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ||
  path.join(process.env.HOME, '.claude', 'projects');
const REPOS_DIR = process.env.REPOS_DIR ||
  path.join(process.env.HOME, 'Repos');

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize WebSocket server
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Track connected clients per session
const sessionClients = new Map(); // sessionId -> Set<WebSocket>
const deviceLeases = new Map();   // sessionId -> { deviceId, lastHeartbeat }

// Track pending permission requests
// Key: tool_use_id, Value: { session_id, tool_name, tool_input, received_at }
const pendingPermissions = new Map();

// =============================================================================
// API Routes
// =============================================================================

/**
 * GET /api/sessions
 * List all Claude sessions with their status
 */
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await require('./lib/sessions').listSessions();
    res.json(sessions);
  } catch (err) {
    console.error('Error listing sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions
 * Create a new Claude session
 */
app.post('/api/sessions', async (req, res) => {
  try {
    const { cwd } = req.body;
    const session = await require('./lib/sessions').createSession(cwd || REPOS_DIR);
    res.json(session);
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sessions/:id
 * Get full conversation content for a session
 */
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const content = await require('./lib/jsonl').readSession(req.params.id);
    res.json(content);
  } catch (err) {
    console.error('Error reading session:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:id/input
 * Send input to a Claude session (via tmux)
 */
app.post('/api/sessions/:id/input', async (req, res) => {
  try {
    const { text, action } = req.body;
    await require('./lib/sessions').sendInput(req.params.id, text, action);
    res.json({ success: true });
  } catch (err) {
    console.error('Error sending input:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/sessions/:id
 * Kill a Claude session
 */
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await require('./lib/sessions').killSession(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error killing session:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dropzone
 * List files in the drop zone
 */
app.get('/api/dropzone', async (req, res) => {
  try {
    const fs = require('fs').promises;
    const dropzonePath = path.join(process.env.HOME, 'dropzone');

    try {
      const files = await fs.readdir(dropzonePath);
      const fileStats = await Promise.all(
        files.map(async (name) => {
          const stat = await fs.stat(path.join(dropzonePath, name));
          return {
            name,
            size: stat.size,
            modified: stat.mtime
          };
        })
      );
      res.json(fileStats);
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.json([]); // Drop zone doesn't exist yet
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('Error listing dropzone:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Hook Endpoints (Permission Handling)
// =============================================================================

/**
 * POST /hook/permission
 * Receives permission requests from Claude Code PreToolUse hook.
 * Stores the request and broadcasts to connected WebSocket clients.
 */
app.post('/hook/permission', (req, res) => {
  const { session_id, tool_name, tool_input, tool_use_id } = req.body;

  if (!tool_use_id || !session_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log(`Permission request: session=${session_id}, tool=${tool_name}, id=${tool_use_id}`);

  // Store pending permission
  const permission = {
    session_id,
    tool_name,
    tool_input,
    tool_use_id,
    received_at: Date.now()
  };
  pendingPermissions.set(tool_use_id, permission);

  // Broadcast to all clients watching this session
  const clients = sessionClients.get(session_id);
  if (clients) {
    const message = JSON.stringify({
      type: 'permission_request',
      data: permission
    });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // TODO: Trigger push notification here
  // notify.send({ title: `Claude needs approval`, body: `${tool_name}: ${JSON.stringify(tool_input).slice(0, 100)}` });

  res.json({ success: true, queued: true });
});

/**
 * POST /hook/respond
 * Receives approval/denial from the web UI.
 * Sends the appropriate keystroke to tmux.
 */
app.post('/hook/respond', async (req, res) => {
  const { tool_use_id, session_id, approved } = req.body;

  if (!tool_use_id || !session_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Remove from pending
  const permission = pendingPermissions.get(tool_use_id);
  pendingPermissions.delete(tool_use_id);

  console.log(`Permission response: session=${session_id}, id=${tool_use_id}, approved=${approved}`);

  try {
    const sessions = require('./lib/sessions');
    // Claude's permission prompt: 1=Yes, 2=Yes allow all, Esc=cancel
    // We send "1" for single approval
    const key = approved ? '1' : 'Escape';
    const sent = await sessions.sendKeys(session_id, key);

    if (!sent) {
      // Session not found - likely started outside Claude Go
      console.warn(`Permission response for unknown session: ${session_id}`);
      return res.status(404).json({
        error: 'Session not found',
        detail: 'This session may have been started outside Claude Go'
      });
    }

    // Notify clients that permission was handled
    const clients = sessionClients.get(session_id);
    if (clients) {
      const message = JSON.stringify({
        type: 'permission_resolved',
        data: { tool_use_id, approved }
      });
      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error sending permission response:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /hook/pending
 * Get all pending permission requests (useful for UI reconnection)
 */
app.get('/hook/pending', (req, res) => {
  const { session_id } = req.query;

  let permissions = Array.from(pendingPermissions.values());
  if (session_id) {
    permissions = permissions.filter(p => p.session_id === session_id);
  }

  res.json(permissions);
});

// =============================================================================
// WebSocket Handling
// =============================================================================

wss.on('connection', (ws, req) => {
  // Extract session ID from URL: /ws/:sessionId
  const urlParts = req.url.split('/');
  const sessionId = urlParts[urlParts.length - 1];
  const deviceId = req.headers['x-device-id'] || `device-${Date.now()}`;

  console.log(`WebSocket connected: session=${sessionId}, device=${deviceId}`);

  // Track this client
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Set());
  }
  sessionClients.get(sessionId).add(ws);

  // Handle device lease (for collision detection)
  const existingLease = deviceLeases.get(sessionId);
  if (existingLease && existingLease.deviceId !== deviceId) {
    // Notify the old device that session was taken
    const oldClients = sessionClients.get(sessionId);
    oldClients?.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'session-taken',
          by: deviceId
        }));
      }
    });
  }

  // Update lease
  deviceLeases.set(sessionId, {
    deviceId,
    lastHeartbeat: Date.now()
  });

  // Start watching the JSONL file for this session
  const jsonl = require('./lib/jsonl');
  const unwatch = jsonl.watchSession(sessionId, (event, data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: event, data }));
    }
  });

  // Handle messages from client
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.type) {
        case 'heartbeat':
          // Update lease
          deviceLeases.set(sessionId, {
            deviceId,
            lastHeartbeat: Date.now()
          });
          ws.send(JSON.stringify({ type: 'heartbeat-ack' }));
          break;

        case 'input':
          // Send input to Claude via tmux
          await require('./lib/sessions').sendInput(
            sessionId,
            msg.text,
            msg.action
          );
          break;

        case 'interrupt':
          // Send Ctrl+C
          await require('./lib/sessions').sendInterrupt(sessionId);
          break;
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  // Cleanup on disconnect
  ws.on('close', () => {
    console.log(`WebSocket disconnected: session=${sessionId}, device=${deviceId}`);
    sessionClients.get(sessionId)?.delete(ws);
    if (sessionClients.get(sessionId)?.size === 0) {
      sessionClients.delete(sessionId);
    }
    unwatch?.();
  });
});

// =============================================================================
// Periodic Cleanup
// =============================================================================

setInterval(() => {
  const now = Date.now();
  const LEASE_TIMEOUT = 15000; // 15 seconds
  const PERMISSION_TIMEOUT = 600000; // 10 minutes

  // Clean up expired device leases
  for (const [sessionId, lease] of deviceLeases) {
    if (now - lease.lastHeartbeat > LEASE_TIMEOUT) {
      deviceLeases.delete(sessionId);
      console.log(`Lease expired for session ${sessionId}`);
    }
  }

  // Clean up stale pending permissions
  for (const [toolUseId, permission] of pendingPermissions) {
    if (now - permission.received_at > PERMISSION_TIMEOUT) {
      pendingPermissions.delete(toolUseId);
      console.log(`Stale permission cleaned up: ${toolUseId} (${permission.tool_name})`);
    }
  }
}, 5000);

// =============================================================================
// Start Server
// =============================================================================

server.listen(PORT, HOST, () => {
  console.log(`Claude Go server running at http://${HOST}:${PORT}`);
  console.log(`Claude projects dir: ${CLAUDE_PROJECTS_DIR}`);
  console.log(`Repos dir: ${REPOS_DIR}`);
});
