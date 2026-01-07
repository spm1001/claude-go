#!/bin/bash
# Claude Go Permission Hook
#
# Called by Claude Code before tool execution. POSTs the request to the
# Claude Go server for mobile notification, then returns "ask" to surface
# the terminal prompt (which waits indefinitely for user response).
#
# The server URL can be configured via CLAUDE_GO_URL environment variable.
# Default: http://localhost:7682

CLAUDE_GO_URL="${CLAUDE_GO_URL:-http://localhost:7682}"

# Read hook input from stdin
INPUT=$(cat)

# Extract tool name - skip tools with inline UI rendering
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)
case "$TOOL_NAME" in
  AskUserQuestion|TodoWrite)
    # These have proper inline rendering, don't show permission card
    exit 0
    ;;
esac

# POST to Claude Go server (fire and forget - don't block on response)
# Use timeout to ensure we don't hang if server is unreachable
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$INPUT" \
  --max-time 2 \
  "${CLAUDE_GO_URL}/hook/permission" \
  >/dev/null 2>&1 &

# Return "ask" immediately to surface terminal prompt
# This decouples notification from approval - user can respond whenever
cat << 'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Awaiting approval via Claude Go"}}
EOF
