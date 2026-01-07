#!/bin/bash
# Spin up a fishbowl Claude for testing Claude Go UI
#
# Usage:
#   ./scripts/spinup-fishbowl.sh [sandbox-name]
#
# Example:
#   ./scripts/spinup-fishbowl.sh test1

set -e

SANDBOX_NAME="${1:-fishbowl-$(date +%s)}"
SANDBOX_DIR="/Users/modha/Repos/fishbowl-sandboxes/$SANDBOX_NAME"

# Check dev server is running
if ! curl -s http://127.0.0.1:7682/ > /dev/null 2>&1; then
    echo "❌ Dev server not running. Start with: HOST=127.0.0.1 npm run dev"
    exit 1
fi

# Create sandbox in ~/Repos (not /tmp, which has symlink issues)
echo "Creating sandbox: $SANDBOX_DIR"
mkdir -p "$SANDBOX_DIR"

# Create session
echo "Creating Claude session..."
RESPONSE=$(curl -s -X POST http://127.0.0.1:7682/api/sessions \
    -H "Content-Type: application/json" \
    -d "{\"cwd\":\"$SANDBOX_DIR\"}")

SESSION_ID=$(echo "$RESPONSE" | jq -r '.id')
if [ "$SESSION_ID" = "null" ] || [ -z "$SESSION_ID" ]; then
    echo "❌ Failed to create session"
    echo "$RESPONSE"
    exit 1
fi

echo "✅ Session created: $SESSION_ID"
echo ""
echo "Useful commands:"
echo "  # Check session state"
echo "  tmux capture-pane -t claude-$SESSION_ID -p | tail -30"
echo ""
echo "  # Send a message"
echo "  curl -X POST http://127.0.0.1:7682/api/sessions/$SESSION_ID/input \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"text\":\"Hello fishbowl!\"}'"
echo ""
echo "  # Inspect via Playwright"
echo "  ~/.claude/.venv/bin/python scripts/inspect-session.py $SESSION_ID"
echo ""
echo "  # Open in browser"
echo "  open http://127.0.0.1:7682"
echo ""
echo "JSONL will be at:"
echo "  ~/.claude/projects/-Users-modha-Repos-fishbowl-sandboxes-$SANDBOX_NAME/$SESSION_ID.jsonl"
