# Claude Go: Interaction Types Reference

This document catalogues all the ways Claude Code can pause for human input, and how to handle each in Claude Go. The architecture is: **tmux (persistence) + JSONL watching (conversation rendering) + hooks (interaction capture)**.

We're using Claude Code CLI on subscription billing, not the SDK/API.

---

## Architecture overview

```
Claude CLI (in tmux)
      │
      ├─── JSONL files ──────────► Conversation rendering
      │    ~/.claude/projects/     (messages, tool calls, results)
      │
      └─── Hooks ────────────────► Interaction handling
           PreToolUse, etc.        (permissions, notifications, questions)
```

**Key insight**: JSONL captures what happened. Hooks capture what's happening now and needs response.

---

## Interactive tools (appear in JSONL as tool_use blocks)

### AskUserQuestion

Claude presents structured multiple-choice prompts.

**Where it appears**: JSONL as `tool_use` block with `name: "AskUserQuestion"`

**Schema**:
```json
{
  "name": "AskUserQuestion",
  "input": {
    "questions": [{
      "question": "Which database should we use?",
      "header": "Database",
      "multiSelect": false,
      "options": [
        { "label": "PostgreSQL", "description": "Relational, ACID compliant" },
        { "label": "MongoDB", "description": "Document store, flexible schema" }
      ]
    }]
  }
}
```

**Constraints**:
- 1-4 questions per invocation
- 2-4 options per question (plus auto-added "Other")
- `header` max 12 characters
- `label` max 1-5 words
- `question` must end with ?

**Response**: Send the 1-indexed option number via tmux stdin. For multiSelect, comma-separated indices.

**UI considerations**:
- Track answered questions by tool_use block `id` to prevent double-tap
- Disable buttons after response sent
- For multiSelect: toggle selection on tap, submit button sends final answer


### ExitPlanMode

Claude finished planning and wants approval to start implementing.

**Where it appears**: JSONL as `tool_use` block with `name: "ExitPlanMode"`

**Schema**:
```json
{
  "name": "ExitPlanMode",
  "input": {
    "plan": "## Implementation Plan\n\n1. Create database schema..."
  }
}
```

**Response**: Typically "1" to approve, "2" to reject/revise.

**When it fires**: Only for implementation tasks, not research or exploration.

---

## Permission prompts (terminal-only, need hooks)

These tools trigger permission prompts in default mode:

| Tool | What it does | Input to display |
|------|--------------|------------------|
| Bash | Run shell command | `command` field |
| Write | Create/overwrite file | `file_path`, maybe preview `content` |
| Edit | Modify file | `file_path`, diff if available |
| MultiEdit | Multiple file edits | List of `file_path`s |
| NotebookEdit | Jupyter notebook | `notebook_path` |
| WebFetch | HTTP requests | `url` |
| MCP tools | External integrations | Varies by server |

**Read-only tools that DON'T need permission**: Read, Glob, Grep, LS, View, Search

### The "ask + queue" pattern (validated)

1. `PreToolUse` hook fires with tool details
2. Hook POSTs to Node server (notification)
3. Hook returns `{"hookSpecificOutput": {"permissionDecision": "ask"}}`
4. Terminal shows standard permission prompt (waits indefinitely)
5. User eventually taps approve in mobile UI
6. Server sends `tmux send-keys -t {session} "1" Enter`

**Hook input schema** (via stdin):
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/session.jsonl",
  "cwd": "/working/directory",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm run test",
    "description": "Run test suite",
    "timeout": 120000
  },
  "tool_use_id": "toolu_01ABC..."
}
```

**Hook output** (return immediately):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask"
  }
}
```

**Correlation**: Use `tool_use_id` to match pending permissions with responses.

---

## Hook events reference

Configure in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": { "toolName": "*" },
      "hooks": ["~/.claude/scripts/claude-go-hook.sh"]
    }]
  }
}
```

### Hooks useful for Claude Go

| Hook | When | Use for |
|------|------|---------|
| **PreToolUse** | Before tool execution | Permission notifications |
| **PermissionRequest** | When permission dialog appears | Alternative to PreToolUse, fires slightly later |
| **Notification** | Various events | Push notifications to mobile |
| **Stop** | Agent finishes responding | "Ready for input" indicator |
| **SessionStart** | Session begins | Session tracking |
| **SessionEnd** | Session ends | Cleanup |

### Hooks probably not needed

| Hook | When | Why skip |
|------|------|----------|
| PostToolUse | After tool completes | JSONL already captures results |
| UserPromptSubmit | User sends message | We control input, don't need hook |
| SubagentStop | Subagent finishes | Edge case, add later if needed |
| PreCompact | Before context compaction | Informational only |

### Notification hook detail

The `Notification` hook fires for multiple event types:

```json
{
  "hook_event_name": "Notification",
  "notification_type": "idle_prompt",
  "session_id": "..."
}
```

**Notification types**:
- `permission_prompt` - permission dialog shown
- `idle_prompt` - Claude waiting >60 seconds for input
- `auth_success` - authentication completed  
- `elicitation_dialog` - other interactive dialog

**`idle_prompt` is valuable** - it's your "ping me if needed" signal for when Claude is waiting and you haven't noticed.

---

## JSONL structure reference

**Location**: `~/.claude/projects/{encoded-path}/{session-uuid}.jsonl`

Path encoding: slashes become hyphens (`/Users/me/project` → `-Users-me-project`)

### Message types in JSONL

**User message**:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "..." }]
  },
  "uuid": "...",
  "timestamp": "..."
}
```

**Assistant message**:
```json
{
  "type": "assistant", 
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "Bash", "input": {...} }
    ],
    "usage": { "input_tokens": 1234, "output_tokens": 567 }
  },
  "uuid": "...",
  "parentUuid": "...",
  "costUSD": 0.01234,
  "durationMs": 5678
}
```

**Tool result** (appears as user message):
```json
{
  "type": "user",
  "message": {
    "role": "user", 
    "content": [{
      "type": "tool_result",
      "tool_use_id": "toolu_...",
      "content": "Command output here",
      "is_error": false
    }]
  }
}
```

**Result message** (session complete):
```json
{
  "type": "result",
  "subtype": "success",
  "costUSD": 0.05,
  "durationMs": 30000,
  "numTurns": 5
}
```

### What JSONL does NOT capture

- Permission prompt waiting state
- Real-time processing/thinking indicators
- Which permission mode is active
- Rate limiting events
- MCP server connection state
- Pending edit diffs before approval
- Interrupt/cancel requests

**This is why we need hooks** - they fill these gaps.

---

## Terminal responses reference

When Claude shows a permission prompt, these are the standard responses:

| Input | Meaning |
|-------|---------|
| `1` or `y` | Yes, allow this once |
| `2` | Yes, and don't ask again this session |
| `3` | Yes, and trust this tool permanently |
| `n` | No, deny |

For AskUserQuestion, responses are 1-indexed option numbers.

Send via: `tmux send-keys -t {session} "1" Enter`

---

## Critical: Output Capture Method

**IMPORTANT (Jan 2026 discovery):** `tmux capture-pane` does NOT work for capturing Claude's interactive UI. Claude uses the alternate screen buffer which `capture-pane` misses entirely.

### What doesn't work

```bash
# These return empty or minimal output:
tmux capture-pane -t {session} -p           # Misses alternate screen
tmux capture-pane -t {session} -p -a        # Returns "no alternate screen"
```

### What works

```bash
# Set up continuous capture to file
tmux pipe-pane -t {session} "cat > /tmp/claude-output.txt"

# Read captured output (use strings to filter escape codes)
cat /tmp/claude-output.txt | strings | tail -100
```

### Why this matters for Claude Go

- JSONL watching handles conversation history (what happened)
- Hooks handle permission notifications (what's happening now)
- But if you need to **read Claude's current screen state** (e.g., for debugging, for capturing what prompt is showing), you must use `pipe-pane`

### Additional tmux requirements

When running Claude in a tmux session on a remote machine (e.g., sprites):

1. **NVM must be sourced** before running `claude`:
   ```bash
   tmux send-keys -t {session} 'export NVM_DIR="/.sprite/languages/node/nvm" && . "$NVM_DIR/nvm.sh" && nvm use default' Enter
   sleep 3
   tmux send-keys -t {session} "claude" Enter
   ```

2. **TERM should be set** for proper rendering:
   ```bash
   tmux send-keys -t {session} "export TERM=xterm-256color" Enter
   ```

3. **OAuth tokens may expire** — use `CLAUDE_CODE_OAUTH_TOKEN` env var or run `claude setup-token`

---

## Implementation checklist

### Already working
- [ ] JSONL watching for conversation rendering
- [ ] WebSocket push to mobile
- [ ] Session management via tmux
- [ ] PreToolUse hook for permission notifications
- [ ] "Ask + queue" pattern for indefinite wait

### To implement
- [ ] AskUserQuestion rendering with answer tracking
- [ ] ExitPlanMode rendering  
- [ ] Notification hook for `idle_prompt` → push notification
- [ ] Stop hook for "ready for input" indicator
- [ ] Loading states on all interactive buttons
- [ ] Disable buttons after interaction sent

### Edge cases to handle
- [ ] Multiple pending permissions (use tool_use_id Map)
- [ ] Session started outside Claude Go (no session in our tracking)
- [ ] Permission approved on desktop (remove from mobile queue)
- [ ] Network disconnect during pending permission
- [ ] Hook timeout (60s) - should fall back gracefully

---

## Testing scenarios

1. **Basic permission**: Ask Claude to write a file, verify prompt appears in mobile, approve, verify file created

2. **AskUserQuestion**: Ask Claude something that triggers a question (e.g., "help me choose a database"), verify options render, tap one, verify Claude continues

3. **Multiple pending**: Trigger two tool calls rapidly, verify both queue correctly, approve in order

4. **Timeout resilience**: Trigger permission, wait >60s, verify terminal prompt still works

5. **Cross-device**: Start on mobile, approve permission on desktop, verify mobile UI updates

6. **Idle notification**: Leave Claude waiting, verify push notification after 60s
