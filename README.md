# Claude Go (Archived)

> **This project has been superseded by [Guéridon](../gueridon).** Claude-go proved the concept and found the landmines. Guéridon rebuilt on better foundations (`claude -p` with JSON stdin/stdout instead of tmux scraping). This repo is kept as read-only history. Hard-won lessons have been documented in `gueridon/docs/lessons-from-claude-go.md`.

Self-hosted Claude Code web client. Start tasks on your phone, continue on your desktop.

## Features

- **Device mobility** - Start on phone, continue on desktop
- **Session persistence** - Close browser, Claude keeps working
- **Push notifications** - Get notified when Claude needs attention (via ntfy.sh)
- **Mobile-first UI** - Touch-friendly, responsive design
- **Full Claude** - Your skills, your MCP servers, no spin-up lag

## Architecture

```
Browser → WebSocket → Node.js server → tmux → Claude CLI
                                    ↓
                              ~/.claude/projects/
                              (JSONL files)
```

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:7682

## Deployment (kube.lan)

### 1. Clone to server

```bash
ssh kube.lan
cd ~/Repos
git clone <this-repo> claude-go
cd claude-go
npm install --production
```

### 2. Create drop zone

```bash
mkdir -p ~/dropzone
```

### 3. Install systemd service

```bash
sudo cp claude-go.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-go
```

### 4. Verify

```bash
sudo systemctl status claude-go
curl http://localhost:7682
```

### Access URL

```
http://kube.atlas-cloud.ts.net:7682
```

(Requires Tailscale)

## Usage

### Session Picker

Lists all running Claude sessions. Click to open, or create new.

### Chat View

- View conversation rendered from JSONL
- Send messages via text input
- Quick actions: Approve, Reject, Stop (Ctrl+C)

### Drop Zone

Upload files to `~/dropzone/` on kube.lan via:
- `tailscale file cp file.png kube:`
- `scp file.png kube.lan:dropzone/`
- SFTP/Finder

Then tell Claude: "look at ~/dropzone/file.png"

## Push Notifications (Optional)

1. Install [ntfy app](https://ntfy.sh) on your phone
2. Subscribe to topic: `sameer-claude-go`
3. Configure in `lib/notify.js` (TODO)

## Troubleshooting

### Check server logs

```bash
sudo journalctl -u claude-go -f
```

### List Claude sessions

```bash
tmux list-sessions | grep claude-
```

### Attach to session (debugging)

```bash
tmux attach -t claude-<uuid>
```

### View session JSONL

```bash
tail -f ~/.claude/projects/-home-modha-Repos/<uuid>.jsonl | jq .
```

## Development

```bash
npm run dev  # Runs with --watch for auto-reload
```

## License

MIT
