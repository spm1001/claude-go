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

## Related

- `~/Repos/claude-code-web/` - Previous ttyd-based solution
- `~/Repos/infra-linux-servers/kube.md` - Server infrastructure docs
