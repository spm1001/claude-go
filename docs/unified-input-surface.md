# Unified Input Surface Design

Mobile-first design for Claude Go's bottom panel. All interactive elements at the bottom where thumbs can reach.

## Design Principles

1. **Flat, not layered** — No gestures, no swipes, no morphing animations. Just buttons.
2. **One input surface** — The bottom panel handles all interaction types through consistent patterns.
3. **Terminal grammar parity** — Match Claude Code CLI semantics: numbered options, "Type something", Esc to dismiss.
4. **Thumb-friendly** — All tap targets at bottom of screen.

---

## Pattern Reference

### 1. Normal Input (nothing pending)

```
┌─────────────────────────────────────────────┐
│ [Message Claude...]                 [Send]  │
└─────────────────────────────────────────────┘
```

Standard chat input. No header row when nothing to respond to.

---

### 2. AskUserQuestion — Single-select

```
┌─────────────────────────────────────────────┐
│ □ Database                       [Dismiss]  │
│ Which database should we use?               │
├─────────────────────────────────────────────┤
│ [1. PostgreSQL                            ] │
│    Relational, ACID compliant, mature       │
│ [2. MongoDB                               ] │
│    Document store, flexible schema          │
├─────────────────────────────────────────────┤
│ [Type something...]               [Other…]  │
└─────────────────────────────────────────────┘
```

**Behavior:**
- Tap option 1 or 2 → immediate send (that option's index)
- Type + tap "Other…" → sends custom text
- Dismiss → sends Escape (user declined to answer)

**Terminal equivalent:**
- Option tap = `1` or `2` + Enter
- Other = typed text + Tab + Enter
- Dismiss = Escape

---

### 3. AskUserQuestion — Multi-select

```
┌─────────────────────────────────────────────┐
│ □ Features                       [Dismiss]  │
│ Which features should we enable?            │
├─────────────────────────────────────────────┤
│ [1. [ ] Dark mode                         ] │
│    Toggle between light and dark themes     │
│ [2. [✓] Notifications                     ] │
│    Push alerts when Claude needs attention  │
│ [3. [ ] Auto-save                         ] │
│ [4. [ ] Keyboard nav                      ] │
├─────────────────────────────────────────────┤
│ [Type something...]              [Submit]   │
└─────────────────────────────────────────────┘
```

**Behavior:**
- Tap option → toggles checkbox, doesn't send
- Type something (optional) → adds freeform to selection
- Submit → sends all selected indices (+ typed text if any)
- Dismiss → Escape

**Visual distinction from single-select:**
- Checkboxes `[ ]` / `[✓]` visible
- Button says "Submit" not "Other…"

---

### 4. AskUserQuestion — Multi-question (sequential)

```
┌─────────────────────────────────────────────┐
│ □ Language (1/2)                 [Dismiss]  │
│ Which programming language?                 │
├─────────────────────────────────────────────┤
│ [1. TypeScript                            ] │
│ [2. Python                                ] │
├─────────────────────────────────────────────┤
│ [Type something...]               [Other…]  │
└─────────────────────────────────────────────┘

        ↓ user answers ↓

┌─────────────────────────────────────────────┐
│ □ Framework (2/2)                [Dismiss]  │
│ Which web framework?                        │
├─────────────────────────────────────────────┤
│ [1. Express                               ] │
│ [2. FastAPI                               ] │
├─────────────────────────────────────────────┤
│ [Type something...]              [Submit]   │
└─────────────────────────────────────────────┘
```

**Behavior:**
- Progress indicator "(1/2)" in header
- Answering Q1 → panel replaces with Q2 (no animation)
- On last question, button changes from "Other…" to "Submit"
- Tap option on last question → immediate submit of all answers
- Dismiss at any point → Escape, cancels entire batch

**Note:** No back navigation. Sequential only. Rare to need to change earlier answer.

---

### 5. Permission Prompt

```
┌─────────────────────────────────────────────┐
│ ⚠ Write                          [Dismiss]  │
│ /Users/modha/Repos/claude-go/server.js      │
├─────────────────────────────────────────────┤
│ [Approve]     [Always]       [Deny]         │
├─────────────────────────────────────────────┤
│ [Instructions...]                   [Send]  │
└─────────────────────────────────────────────┘
```

**Behavior:**
- Approve → sends `1` (allow once)
- Always → sends `3` (trust tool permanently)
- Deny → sends `n`
- Type + Send → sends Escape, then types instructions as follow-up message
- Dismiss → sends Escape

**Note:** Approve/Always/Deny in a row (not numbered). Instructions are for guiding Claude after denial.

---

### 6. ExitPlanMode (Plan Approval)

```
┌─────────────────────────────────────────────┐
│ □ Plan Ready                     [Dismiss]  │
│ (tap to scroll to plan above)               │
├─────────────────────────────────────────────┤
│ [Approve]                       [Reject]    │
├─────────────────────────────────────────────┤
│ [Feedback on plan...]             [Edit…]   │
└─────────────────────────────────────────────┘
```

**Behavior:**
- Approve → sends `y`
- Reject → sends `n`
- Type + Edit… → sends feedback for revision
- Dismiss → Escape

**Note:** Plan content stays inline in messages (scrollable). Bottom panel just has the controls.

---

## State Management

### Interaction Priority

When multiple interactions are pending, show in order:
1. Permission prompts (most urgent — Claude is blocked)
2. AskUserQuestion
3. ExitPlanMode

Only one interaction visible at a time. Others queue.

### Tracking Answered State

- Track by `tool_use_id` for AskUserQuestion/ExitPlanMode
- Track by `tool_use_id` for permissions
- Once answered, interaction disappears from bottom panel
- Inline cards in messages get grayed out / "(answered)" indicator

### Button States

- Default: enabled, normal color
- Loading: disabled, spinner, after user taps while waiting for confirmation
- Answered: removed from panel (interaction complete)

---

## Terminal Grammar Reference

| UI Action | Terminal Equivalent |
|-----------|---------------------|
| Tap numbered option | Send index + Enter |
| Other… (single-select) | Type text + Tab + Enter |
| Submit (multi-select) | Tab to Submit + Enter |
| Dismiss | Escape |
| Approve (permission) | `1` + Enter |
| Always (permission) | `3` + Enter |
| Deny (permission) | `n` + Enter |
| Approve (plan) | `y` + Enter |
| Reject (plan) | `n` + Enter |

---

## Migration from Current UI

### What Changes

| Current | New |
|---------|-----|
| AskUserQuestion renders inline only | Moves to bottom panel (inline becomes reference) |
| ExitPlanMode renders inline only | Controls move to bottom panel |
| Permission banner at top of screen | Moves to bottom panel |
| Quick actions row (Approve/Reject/Stop) | Replaced by contextual bottom panel |
| Send button always says "Send" | Label changes based on context |

### What Stays

- Normal input textarea + Send (when nothing pending)
- Inline message rendering (for context/history)
- WebSocket updates
- Session management

---

## Implementation Notes

### Bottom Panel Component Structure

```
BottomPanel
├── InteractionHeader (when pending)
│   ├── Chip (□ Database)
│   ├── Progress ((1/2)) — multi-question only
│   └── DismissButton
├── QuestionText (when pending)
├── Options (when pending)
│   └── OptionButton[] or PermissionButtons
└── InputRow
    ├── Textarea
    └── SubmitButton (Send / Other… / Submit / Edit…)
```

### State Shape

```javascript
const bottomPanelState = {
  mode: 'normal' | 'question' | 'permission' | 'plan',
  pending: {
    type: 'AskUserQuestion' | 'Permission' | 'ExitPlanMode',
    tool_use_id: string,
    questions: [...],        // for AskUserQuestion
    currentQuestionIndex: 0, // for multi-question
    answers: [],             // accumulated answers
    tool_name: string,       // for permissions
    tool_input: {...},       // for permissions
  } | null
};
```

---

## Open Questions (Resolved)

1. ~~Priority/stacking for multiple pending~~ → Show most urgent only, queue others
2. ~~Inline card fate~~ → Gray out with "(answered)" after response
3. ~~Escape vs Deny semantics~~ → Keep both, Dismiss = Escape, Deny = `n`
4. ~~Multi-question navigation~~ → Sequential only, no back button
5. ~~"Other" always available?~~ → Yes, textarea row always present
