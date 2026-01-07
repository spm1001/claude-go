# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What This Project Is

**Claude Go** - A self-hosted Claude Code web client.

Start tasks on your phone during your commute, close the browser, get notified when Claude needs attention, continue on your desktop. Full skills, full MCP servers, no spin-up lag.

## Architecture

```
Browser → WebSocket → Node.js server → tmux → Claude CLI
                                    ↓
                              ~/.claude/projects/
                              (JSONL files)
```

- **JSONL is source of truth** - We render from session files, not terminal state
- **tmux for persistence** - Invisible to user, keeps Claude alive when browser closes
- **WebSocket for real-time** - Live updates as Claude types, device handoff

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server |
| `lib/sessions.js` | tmux wrapper for session lifecycle |
| `lib/jsonl.js` | JSONL parser and file watcher |
| `lib/notify.js` | ntfy.sh push notifications (future) |
| `public/` | Mobile-first web UI |

## Running Locally

```bash
npm install
npm start        # Production
npm run dev      # Development (with --watch)
```

Server runs on port 7682 by default.

## Deployment (kube.lan)

Deployed as systemd service on kube.lan, accessible via Tailscale:
- URL: `http://kube.atlas-cloud.ts.net:7682`
- Service: `/etc/systemd/system/claude-go.service`

## Session Management

- Sessions are tmux sessions named `claude-<uuid>`
- Claude runs with `--session-id <uuid>` for predictable JSONL paths
- JSONL stored at `~/.claude/projects/-home-modha-Repos/<uuid>.jsonl`
- Device handoff via heartbeat/lease model (15s expiry)

## Commands

```bash
# List tmux sessions
tmux list-sessions

# Attach to a session (for debugging)
tmux attach -t claude-<uuid>

# View session logs
tail -f ~/.claude/projects/-home-modha-Repos/<uuid>.jsonl | jq .
```

## Beads

This project uses bd (beads) for issue tracking:
- Epic: `claude-go-tvd`
- Run `bd ready` to see available work
- Run `bd list --parent claude-go-tvd` to see all project beads

## JSONL Format Gotchas

The JSONL format has quirks that affect parsing:

| Message Type | Where It Lives | Notes |
|--------------|----------------|-------|
| `user` | Text in `message.content` string or array | Normal user messages |
| `assistant` | Array of content blocks | May contain `text`, `tool_use`, `thinking` |
| `tool_result` | **User message** with `tool_result` content | NOT in assistant message — it's a "user" type with tool_result blocks |
| `summary` | Separate entry, `type: "summary"` | Session title metadata, not conversation content |
| `thinking` | Inside assistant content | Encrypted, should be filtered out |

**Key insight:** Tool results come back as user messages, not assistant messages. The flow is:
1. Assistant sends `tool_use` block
2. System sends `tool_result` as a user message
3. Assistant continues with text

## Systemd Gotchas

**KillMode matters:** The service uses `KillMode=process` to only kill the Node.js process on restart, not tmux children. Without this, `systemctl restart claude-go` kills all active Claude sessions.

**PATH:** Claude CLI lives in `~/.local/bin/`, which isn't in systemd's default PATH. The service file explicitly includes it.

## Permission Handling: "Ask + Queue" Pattern

Permission prompts are terminal-only (not in JSONL). We solve this with hooks:

```
Hook fires (PreToolUse)
  ↓
POST to Node.js server (notification)
  ↓
Return {"permissionDecision": "ask"} immediately  ← no blocking!
  ↓
Terminal prompt appears, waits indefinitely
  ↓
... user on train, hours later ...
  ↓
Mobile UI tap → server sends: tmux send-keys "1" Enter
```

**Why "ask"?** Returning `"ask"` tells Claude Code to show its normal terminal prompt. This decouples notification from approval — the hook doesn't block, the terminal prompt waits forever, user can respond whenever.

**Key files:**
- `hooks/claude-go-permission.sh` — POSTs to server, returns "ask"
- `hooks/settings-snippet.json` — how to register in ~/.claude/settings.json
- `server.js` — `/hook/permission`, `/hook/respond`, `/hook/pending` endpoints

**Deployment requirement:** The hook must be registered in `~/.claude/settings.json` on kube.lan (where Claude sessions run). Project-level hooks don't work — must be global.

## Hooks Gotchas

**Project-level hooks don't work.** `.claude/settings.json` in a project directory is ignored for hooks. Must use `~/.claude/settings.json`.

**Timeout is soft.** Documentation says 60s, but empirically Claude waits 65+ seconds for hooks to return.

**Auto-approved tools still fire hooks.** If a tool is in the `permissions.allow` list, no prompt appears — but the hook still fires. The keystroke goes nowhere (or wrong place).

**Hook input includes correlation ID:**
```json
{
  "session_id": "a2b3fe34-...",
  "tool_name": "Write",
  "tool_input": { "file_path": "...", "content": "..." },
  "tool_use_id": "toolu_01UASrrZ..."  ← use for correlation
}
```

## Interaction Grammar

**Use the API, not raw keystrokes.** The grammar is encoded in `lib/sessions.js`:

```bash
# Answer any numbered selection (AskUserQuestion, plan mode, permissions)
curl -X POST ".../api/sessions/$ID/input" -d '{"text":"1","action":"answer"}'

# Simple y/n prompts (rare)
curl -X POST ".../api/sessions/$ID/input" -d '{"action":"approve"}'

# Send user message
curl -X POST ".../api/sessions/$ID/input" -d '{"text":"Hello Claude"}'
```

| API Action | Sends | Use For |
|------------|-------|---------|
| `answer` | `text` + `Tab` + `Enter` | Numbered selections (questions, plan approval, permissions) |
| `approve` | `y` + `Enter` | Simple y/n only (not numbered options!) |
| `reject` | `n` + `Enter` | Simple y/n only |
| `continue` | `Enter` | Continue prompts |
| (none) | `text` + `Enter` | User messages |

**Key insight:** Almost everything uses `action: "answer"` — AskUserQuestion, ExitPlanMode, permission prompts with options. The `approve`/`reject` actions are only for rare simple y/n prompts.

**Direct tmux (for debugging only):**
```bash
tmux send-keys -t claude-$ID C-m        # Enter (more reliable than "Enter")
tmux send-keys -t claude-$ID "1"        # Literal "1"
tmux send-keys -t claude-$ID -l "text"  # Literal text (use -l flag)
```

## Testing Infrastructure

```bash
# Start dev server
HOST=127.0.0.1 npm run dev

# Spin up a fishbowl Claude (creates sandbox in ~/Repos to avoid /tmp path issues)
./scripts/spinup-fishbowl.sh test1

# Inspect DOM state programmatically
~/.claude/.venv/bin/python scripts/inspect-session.py <session-id>
~/.claude/.venv/bin/python scripts/inspect-session.py --list

# Run automated UI tests
~/.claude/.venv/bin/python scripts/test-ui.py                      # All tests
~/.claude/.venv/bin/python scripts/test-ui.py --test multi-question

# Exploratory testing REPL
~/.claude/.venv/bin/python scripts/explore.py

# Debug endpoint for JSONL inspection
curl http://localhost:7682/dev/messages/<session-id>

# Direct tmux interaction
tmux capture-pane -t claude-<session-id> -p | tail -30   # Check state
tmux send-keys -t claude-<session-id> "Enter"             # Send Enter
```

**Path gotcha:** Don't use `/tmp` for sandboxes — macOS resolves `/tmp` → `/private/tmp`, causing path mismatch. Use `~/Repos/fishbowl-sandboxes/` instead. See `.tvd.15` for the bug.

## Related

- `~/Repos/claude-code-web/` - Previous ttyd-based solution
- `~/Repos/infra-linux-servers/kube.md` - Server infrastructure docs
