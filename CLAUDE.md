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

**Hook locations:**
| Location | Has hook? | Implication |
|----------|-----------|-------------|
| Laptop (`~/.claude/settings.json`) | No | Local dev/testing unaffected by hook |
| kube.lan (`~/.claude/settings.json`) | Yes | Fishbowl Claudes on kube.lan fire hooks |

**Testing implication:** Local testing (laptop) doesn't have hook contamination — the developer Claude's tool calls don't trigger Claude Go notifications. For integration testing with hooks, use kube.lan.

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

**Tools with inline UI rendering skip the hook.** The hook script checks `tool_name` and exits early for `AskUserQuestion` and `TodoWrite` — these have proper inline rendering in the web UI and shouldn't show permission cards.

## Permission Denial Debugging

**Denial sends Escape key.** When user taps Deny, server calls `sendKeys(session_id, 'Escape')` which sends to tmux. This cancels the permission prompt.

**Debug endpoint:** `GET /api/sessions/:id/terminal` returns raw `tmux capture-pane` output. Use the ▦ button in the UI header to open it. Essential for seeing what the terminal is actually waiting for.

**Stale permissions bug:** If server restarts, pending permissions in UI aren't cleared. User may deny a card that points to a dead session. The keystroke goes nowhere. (See `.6f4`)

**Timing edge cases:** Denial works reliably when tested, but one early test showed a file created despite deny being logged. Couldn't reproduce. If investigating:
1. Check `journalctl -u claude-go` for `sendKeys: BEFORE/AFTER` logs
2. Check terminal state at time of denial (was prompt actually showing?)
3. Check if user was in the right session

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
| `answer-multi` | Each index separately + `Tab` + `Enter` | Multi-select questions (toggles each option) |
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

### Scripts

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `spinup-fishbowl.sh` | Create sandbox + session | Starting fresh test |
| `test-ui.py` | Automated tests | CI / regression |
| `inspect-session.py` | One-shot DOM snapshot | Quick scripting |
| `explore.py` | Interactive REPL | Manual exploration |

### Commands

```bash
# Start dev server
HOST=127.0.0.1 npm run dev

# Create a fishbowl Claude
./scripts/spinup-fishbowl.sh test1

# Run all automated tests
~/.claude/.venv/bin/python scripts/test-ui.py

# Run specific test
~/.claude/.venv/bin/python scripts/test-ui.py --test button-click

# Quick inspect (one-shot)
~/.claude/.venv/bin/python scripts/inspect-session.py --list
~/.claude/.venv/bin/python scripts/inspect-session.py <session-id>

# Interactive exploration
~/.claude/.venv/bin/python scripts/explore.py
```

**Path note:** `/tmp` now works (symlinks resolved). Sandboxes can be anywhere.

### Testing Layers

| Layer | Tool | What It Tests | Claude Needed? |
|-------|------|---------------|----------------|
| **UI rendering** | `POST /dev/inject/:id` + Playwright | Does correct HTML appear? | No |
| **Button clicks** | Playwright `.click()` + API spy | Does clicking call correct endpoint? | No |
| **Keystroke delivery** | Real fishbowl session | Does `/api/sessions/:id/input` reach tmux? | Yes |
| **Full flow** | Real fishbowl on kube.lan | Does Claude respond via hooks? | Yes |

**Mock testing:** The `/dev/inject/:sessionId` endpoint injects fake messages/questions/permissions without needing a real Claude. Use for UI regression tests.

**Hook testing:** Requires kube.lan (where hook is installed). Local testing doesn't exercise the permission hook flow.

## Related

- `~/Repos/claude-code-web/` - Previous ttyd-based solution
- `~/Repos/infra-linux-servers/kube.md` - Server infrastructure docs
