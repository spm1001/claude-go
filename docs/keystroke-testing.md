# Keystroke Testing Guide for Claude Go

This document describes how to test keystroke sequences for interacting with Claude Code's TUI via tmux.

## Quick Start

```bash
# Start dev server
HOST=127.0.0.1 npm run dev

# Create a test session
./scripts/spinup-fishbowl.sh test1

# List available test cases
node scripts/keystroke-test.js claude-<session-id> --list

# Run a test
node scripts/keystroke-test.js claude-<session-id> permission-approve
```

## Terminal Key Encodings Reference

| Key         | Raw Bytes    | tmux Keyword | Notes                     |
|-------------|--------------|--------------|---------------------------|
| Enter       | `\r` (0x0D)  | `Enter`      | Carriage return           |
| Tab         | `\t` (0x09)  | `Tab`        | Horizontal tab            |
| Escape      | `\x1b`       | `Escape`     | ESC character             |
| Backspace   | `\x7f`       | `BSpace`     | DEL (also `\x08` for BS)  |
| Up Arrow    | `\x1b[A`     | `Up`         | ANSI escape sequence      |
| Down Arrow  | `\x1b[B`     | `Down`       |                           |
| Right Arrow | `\x1b[C`     | `Right`      |                           |
| Left Arrow  | `\x1b[D`     | `Left`       |                           |
| Ctrl+C      | `\x03`       | `C-c`        | Interrupt                 |
| Ctrl+D      | `\x04`       | `C-d`        | EOF                       |

**Bracketed paste mode:**
- Start: `\x1b[200~`
- End: `\x1b[201~`
- Used for safe literal text input in modern terminals

## Prompt Types and Expected Sequences

### 1. Permission Prompts

Permission prompts show numbered options:
```
  Allow tool? (1: Yes, 2: Yes for session, 3: Trust always)
```

**How to trigger:**
- Ask Claude to write a file: "Create a file called test.txt with 'hello'"
- Ask Claude to run a command: "Run ls -la"

**Keystroke sequences to test:**

| Action              | Sequence              | Status    |
|---------------------|------------------------|-----------|
| Allow once          | `1` + `Enter`          | Untested  |
| Allow for session   | `2` + `Enter`          | Untested  |
| Trust always        | `3` + `Enter`          | Untested  |
| Deny (escape)       | `Escape`               | Untested  |
| Deny (n key)        | `n` + `Enter`          | Untested  |

**Verification:**
- Check terminal output shows "Allowed" or similar
- Check JSONL for tool_result entry
- For Write tool: verify file was created

### 2. AskUserQuestion Prompts

Claude presents multiple-choice questions with 2-4 options plus "Type something".

**How to trigger:**
- Ask Claude an ambiguous question: "Should I use PostgreSQL or MongoDB?"
- Ask Claude to help choose: "Help me pick a testing framework"

**Keystroke sequences to test:**

| Action              | Sequence                | Status      | Notes                          |
|---------------------|-------------------------|-------------|--------------------------------|
| Option 1 (Tab)      | `1` + `Tab` + `Enter`   | Current     | Number → Tab to Submit → Enter |
| Option 1 (direct)   | `1` + `Enter`           | Untested    | Does Enter alone work?         |
| Option 1 (Right)    | `1` + `Right` + `Enter` | Untested    | Right arrow to Submit?         |
| Option 2            | `2` + `Tab` + `Enter`   | Untested    |                                |
| Type custom         | `N` + `text` + `Tab` + `Enter` | Untested | N = option count + 1     |

**Key question:** Is `Tab` required, or does `Enter` alone submit after selection?

**Verification:**
- Check JSONL for tool_result with selected option index
- Claude should continue with chosen option

### 3. Multi-Select Questions

Questions with `multiSelect: true` allow multiple options to be toggled.

**How to trigger:**
- Ask Claude to help with multiple related tasks
- "Which of these features should I implement first?"

**Keystroke sequences to test:**

| Action                | Sequence                              | Status    | Notes                    |
|-----------------------|---------------------------------------|-----------|--------------------------|
| Select 1 and 3        | `1` → delay → `3` → `Right` → `Enter` | Untested  | Numbers toggle options   |
| Select 1, 2, 3        | `1` → `2` → `3` → `Right` → `Enter`   | Untested  | Multiple toggles         |
| Select all then some  | `1` → `2` → `1` → `Right` → `Enter`   | Untested  | Toggle off option 1      |

**Important:**
- Small delays (50ms) may be needed between number keys
- `Right` arrow navigates to Submit button
- Numbers jump to and toggle that option

**Verification:**
- Check JSONL tool_result contains comma-separated indices
- All selected options should be reflected

### 4. ExitPlanMode Prompts

Claude finished planning and wants approval to start implementing.

**How to trigger:**
- Ask Claude to implement something with the `/plan` command
- Or ask for a complex implementation that triggers planning mode

**Keystroke sequences to test:**

| Action              | Sequence              | Status    |
|---------------------|-----------------------|-----------|
| Approve plan        | `1` + `Tab` + `Enter` | Untested  |
| Reject/revise       | `2` + `Tab` + `Enter` | Untested  |

**Verification:**
- Claude should proceed with implementation (option 1)
- Or ask for revision (option 2)

### 5. Simple Y/N Prompts

Rare prompts that just ask yes/no without numbered options.

**Keystroke sequences to test:**

| Action              | Sequence        | Status    |
|---------------------|-----------------|-----------|
| Yes                 | `y` + `Enter`   | Untested  |
| No                  | `n` + `Enter`   | Untested  |

**Note:** These are rare. Most prompts use numbered options.

### 6. Continue Prompts

Simple prompts that just need Enter to continue.

**Keystroke sequences to test:**

| Action              | Sequence   | Status    |
|---------------------|------------|-----------|
| Continue            | `Enter`    | Works     |

## Testing Procedure

### Manual Testing

1. **Set up test session:**
   ```bash
   HOST=127.0.0.1 npm run dev
   ./scripts/spinup-fishbowl.sh test1
   # Note the session ID
   ```

2. **Trigger the prompt:**
   ```bash
   # Send a message that triggers the prompt type
   curl -X POST http://127.0.0.1:7682/api/sessions/<id>/input \
     -H 'Content-Type: application/json' \
     -d '{"text":"Write a file called hello.txt"}'
   ```

3. **Wait for prompt to appear:**
   - Check terminal state:
     ```bash
     node scripts/keystroke-test.js claude-<id> --capture
     ```

4. **Send test keystroke:**
   ```bash
   node scripts/keystroke-test.js claude-<id> permission-approve
   # Or with --dry-run to see what would be sent:
   node scripts/keystroke-test.js claude-<id> permission-approve --dry-run
   ```

5. **Verify result:**
   - Check JSONL for tool_result
   - Check file was created/command was run
   - Check Claude continues responding

### Using Raw Keys

For experimentation, use `--raw` to send arbitrary key sequences:

```bash
# Try different sequences
node scripts/keystroke-test.js claude-<id> --raw "1" Enter
node scripts/keystroke-test.js claude-<id> --raw "1" Tab Enter
node scripts/keystroke-test.js claude-<id> --raw "1" Right Enter

# Send literal text
node scripts/keystroke-test.js claude-<id> --raw -l "Hello world" Enter
```

## Debugging Tips

### Capture Terminal State

The test harness can capture terminal output via `pipe-pane`:

```bash
node scripts/keystroke-test.js claude-<id> --capture
```

**Important:** Standard `tmux capture-pane` doesn't work with Claude's TUI because it uses the alternate screen buffer. The `pipe-pane` method captures actual output.

### Direct tmux Commands

For quick debugging:

```bash
# List sessions
tmux list-sessions

# Send single key
tmux send-keys -t claude-<id> "1"
tmux send-keys -t claude-<id> Enter

# Send literal text
tmux send-keys -t claude-<id> -l "hello world"
tmux send-keys -t claude-<id> Enter

# Attach for interactive debugging
tmux attach -t claude-<id>
```

### View JSONL Output

```bash
tail -f ~/.claude/projects/-home-user-Repos-fishbowl-sandboxes-test1/<session-id>.jsonl | jq .
```

## Known Issues and Open Questions

### Open Questions

1. **Tab vs Enter for AskUserQuestion:** The current implementation uses `number` + `Tab` + `Enter`. Is `Tab` actually needed, or does `Enter` alone work after selecting an option?

2. **Right arrow for multi-select:** Does `Right` reliably navigate to Submit? What about different terminal sizes?

3. **Timing for multi-select:** How much delay is needed between keystrokes for the TUI to process them? Currently using 50ms.

4. **Escape vs n for denial:** Does `Escape` always work for denying permissions, or is `n` + `Enter` more reliable?

### Tested Behaviors

| Behavior                      | Status      | Notes                          |
|-------------------------------|-------------|--------------------------------|
| Literal text + Enter          | Works       | User messages                  |
| Ctrl+C for interrupt          | Works       | Via `C-c` tmux keyword         |
| Enter for continue            | Works       | Simple continue prompts        |

### Untested Behaviors

| Behavior                      | Priority    | Notes                          |
|-------------------------------|-------------|--------------------------------|
| Permission prompts            | High        | Core interaction               |
| AskUserQuestion               | High        | Core interaction               |
| Multi-select                  | Medium      | Less common but needed         |
| ExitPlanMode                  | Medium      | Only in planning mode          |

## Test Matrix

Use this matrix to track testing progress:

| Prompt Type     | Sequence           | Linux | macOS | Notes      |
|-----------------|---------------------|-------|-------|------------|
| Permission (1)  | `1` + `Enter`       | [ ]   | [ ]   |            |
| Permission (2)  | `2` + `Enter`       | [ ]   | [ ]   |            |
| Permission (Esc)| `Escape`            | [ ]   | [ ]   |            |
| Ask (Tab)       | `1` + `Tab` + `Enter`| [ ]  | [ ]   |            |
| Ask (direct)    | `1` + `Enter`       | [ ]   | [ ]   |            |
| Multi (1,3)     | `1` → `3` → `Right` → `Enter` | [ ] | [ ] |   |
| Plan approve    | `1` + `Tab` + `Enter`| [ ]  | [ ]   |            |

## Related Files

- `scripts/keystroke-test.js` - Test harness
- `lib/sessions.js` - Production keystroke handling
- `claude-go-interaction-reference.md` - Interaction types reference
- `CLAUDE.md` - Overall project documentation
