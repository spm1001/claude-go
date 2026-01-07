#!/usr/bin/env python3
"""
Exploratory testing REPL for Claude Go.

Lets you drive the fishbowl Claude through various interactions
and observe UI behavior.

Usage:
    python scripts/explore.py              # Interactive REPL
    python scripts/explore.py --session <id>

Commands:
    state, s         - Show current session state
    msg, m <text>    - Send a message
    answer, a <n>    - Answer current question with option n
    multi, x <n,m>   - Multi-select answer (comma-separated)
    plan-yes, py     - Approve ExitPlanMode plan
    plan-no, pn      - Reject ExitPlanMode plan
    screenshot, ss   - Take a screenshot
    inject <json>    - Inject mock content (for testing rendering)
    quit, q          - Exit
"""
import sys
import time
import json
import argparse
import requests
from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:7682"

class Explorer:
    def __init__(self, session_id=None):
        self.session_id = session_id
        self.page = None
        self.browser = None
        self.pw = None

    def start(self):
        print("Starting Playwright browser...")
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(headless=True)
        self.page = self.browser.new_page()
        self.page.goto(BASE_URL)
        self.page.wait_for_load_state('networkidle')
        self.page.wait_for_timeout(500)

        if not self.session_id:
            self.session_id = self._find_alive_session()

        if self.session_id:
            self._open_session(self.session_id)
            print(f"Connected to session: {self.session_id[:12]}...")
        else:
            print("No sessions found!")

    def stop(self):
        if self.browser:
            self.browser.close()
        if self.pw:
            self.pw.stop()

    def _find_alive_session(self):
        sessions = self.page.evaluate('''() => {
            return Array.from(document.querySelectorAll('.session-card')).map(el => ({
                id: el.dataset.id,
                alive: el.querySelector('.status-dot')?.classList.contains('alive')
            }));
        }''')
        alive = [s for s in sessions if s['alive']]
        return alive[0]['id'] if alive else (sessions[0]['id'] if sessions else None)

    def _open_session(self, session_id):
        card = self.page.locator(f'.session-card[data-id="{session_id}"]')
        if card.count() == 0:
            card = self.page.locator(f'.session-card[data-id^="{session_id}"]')
        if card.count() > 0:
            card.click()
            self.page.wait_for_timeout(1500)

    def get_state(self):
        """Get current UI state."""
        return self.page.evaluate('''() => {
            const state = {
                messages: [],
                pendingQuestions: [],
                pendingPlans: [],
                inputValue: document.querySelector('#message-input')?.value || ''
            };

            document.querySelectorAll('.message').forEach((el, i) => {
                const msg = {
                    idx: i,
                    type: el.classList.contains('user') ? 'user' : 'assistant',
                    pending: el.classList.contains('pending'),
                    preview: el.textContent?.substring(0, 60).trim().replace(/\\s+/g, ' ')
                };
                state.messages.push(msg);
            });

            document.querySelectorAll('.ask-user-question:not(.answered)').forEach(q => {
                const options = Array.from(q.querySelectorAll('.question-option')).map(
                    (o, i) => `${i+1}. ${o.textContent.trim().substring(0, 40)}`
                );
                state.pendingQuestions.push({
                    id: q.dataset.questionId,
                    header: q.querySelector('.question-header')?.textContent,
                    question: q.querySelector('.question-text')?.textContent?.substring(0, 60),
                    options,
                    multiSelect: q.classList.contains('multi-select')
                });
            });

            document.querySelectorAll('.exit-plan-mode:not(.answered)').forEach(p => {
                state.pendingPlans.push({
                    id: p.dataset.planId,
                    preview: p.textContent?.substring(0, 100).trim()
                });
            });

            return state;
        }''')

    def print_state(self):
        """Pretty print current state."""
        state = self.get_state()

        print(f"\n{'='*60}")
        print(f"Messages: {len(state['messages'])} total")

        # Show last 5 messages
        for m in state['messages'][-5:]:
            prefix = "👤" if m['type'] == 'user' else "🤖"
            flags = " [PENDING]" if m['pending'] else ""
            print(f"  {m['idx']:2d} {prefix} {m['preview']}{flags}")

        if state['pendingQuestions']:
            print(f"\n🔵 Pending Questions:")
            for q in state['pendingQuestions']:
                ms = " [MULTI]" if q.get('multiSelect') else ""
                print(f"  [{q['header']}]{ms}: {q['question']}")
                for opt in q['options']:
                    print(f"    {opt}")

        if state['pendingPlans']:
            print(f"\n📋 Pending Plans:")
            for p in state['pendingPlans']:
                print(f"  {p['preview']}")
                print("  → Use 'py' to approve, 'pn' to reject")

        if not state['pendingQuestions'] and not state['pendingPlans']:
            print("\n✅ No pending interactions")

        print(f"{'='*60}")

    def send_message(self, text):
        """Send a message to Claude."""
        print(f"Sending: {text[:50]}...")
        self.page.locator('#message-input').fill(text)
        self.page.locator('#send-btn').click()
        self.page.wait_for_timeout(500)
        print("Sent. Waiting for response...")
        # Wait a bit for response to start
        self.page.wait_for_timeout(2000)

    def answer_question(self, option_num):
        """Answer current question with option number (1-indexed)."""
        state = self.get_state()
        if not state['pendingQuestions']:
            print("No pending questions!")
            return

        q = state['pendingQuestions'][0]
        print(f"Answering '{q['header']}' with option {option_num}")

        # Click the option (0-indexed in DOM)
        self.page.locator(f'[data-question-id="{q["id"]}"] .question-option').nth(option_num - 1).click()
        self.page.wait_for_timeout(600)
        print("Answered. Check state with 's'")

    def answer_multi(self, options_str):
        """Answer multi-select with comma-separated options."""
        state = self.get_state()
        if not state['pendingQuestions']:
            print("No pending questions!")
            return

        q = state['pendingQuestions'][0]
        if not q.get('multiSelect'):
            print("Warning: This question is not multi-select")

        options = [int(x.strip()) for x in options_str.split(',')]
        print(f"Selecting options: {options} for '{q['header']}'")

        for opt in options:
            self.page.locator(f'[data-question-id="{q["id"]}"] .question-option').nth(opt - 1).click()
            self.page.wait_for_timeout(200)

        # Now submit (might need Tab+Enter equivalent)
        # For now just wait
        self.page.wait_for_timeout(600)
        print("Selections made. Check state with 's'")

    def approve_plan(self):
        """Approve pending ExitPlanMode."""
        state = self.get_state()
        if not state['pendingPlans']:
            print("No pending plans!")
            return

        p = state['pendingPlans'][0]
        print(f"Approving plan: {p['id']}")
        self.page.locator(f'[data-plan-id="{p["id"]}"] [data-action="approve-plan"]').click()
        self.page.wait_for_timeout(600)

    def reject_plan(self):
        """Reject pending ExitPlanMode."""
        state = self.get_state()
        if not state['pendingPlans']:
            print("No pending plans!")
            return

        p = state['pendingPlans'][0]
        print(f"Rejecting plan: {p['id']}")
        self.page.locator(f'[data-plan-id="{p["id"]}"] [data-action="reject-plan"]').click()
        self.page.wait_for_timeout(600)

    def screenshot(self):
        """Take a screenshot."""
        path = f"/tmp/claude-go-explore-{int(time.time())}.png"
        self.page.screenshot(path=path, full_page=True)
        print(f"Screenshot: {path}")
        return path

    def inject(self, content_json):
        """Inject mock content for testing."""
        try:
            content = json.loads(content_json)
        except:
            print("Invalid JSON!")
            return

        payload = {
            "type": "messages",
            "data": [{
                "type": "assistant",
                "uuid": f"inject-{int(time.time()*1000)}",
                "content": content if isinstance(content, list) else [content]
            }]
        }
        resp = requests.post(f"{BASE_URL}/dev/inject/{self.session_id}", json=payload)
        self.page.wait_for_timeout(500)
        print(f"Injected: {resp.json()}")

    def run_repl(self):
        """Run interactive REPL."""
        print(__doc__)
        print(f"\nSession: {self.session_id[:12]}...")
        self.print_state()

        while True:
            try:
                cmd = input("\n> ").strip()
            except (EOFError, KeyboardInterrupt):
                break

            if not cmd:
                continue

            parts = cmd.split(maxsplit=1)
            verb = parts[0].lower()
            arg = parts[1] if len(parts) > 1 else ""

            if verb in ('q', 'quit', 'exit'):
                break
            elif verb in ('s', 'state'):
                self.print_state()
            elif verb in ('m', 'msg'):
                if arg:
                    self.send_message(arg)
                else:
                    print("Usage: m <message>")
            elif verb in ('a', 'answer'):
                if arg:
                    self.answer_question(int(arg))
                else:
                    print("Usage: a <option_number>")
            elif verb in ('x', 'multi'):
                if arg:
                    self.answer_multi(arg)
                else:
                    print("Usage: x <1,2,3>")
            elif verb in ('py', 'plan-yes'):
                self.approve_plan()
            elif verb in ('pn', 'plan-no'):
                self.reject_plan()
            elif verb in ('ss', 'screenshot'):
                self.screenshot()
            elif verb == 'inject':
                if arg:
                    self.inject(arg)
                else:
                    print("Usage: inject <json>")
            elif verb == 'refresh':
                self.page.reload()
                self.page.wait_for_timeout(1000)
                print("Refreshed")
            elif verb == 'wait':
                secs = int(arg) if arg else 3
                print(f"Waiting {secs}s...")
                self.page.wait_for_timeout(secs * 1000)
            else:
                print(f"Unknown command: {verb}")
                print("Commands: s, m, a, x, py, pn, ss, inject, refresh, wait, q")


def main():
    parser = argparse.ArgumentParser(description='Claude Go Explorer')
    parser.add_argument('--session', help='Session ID to use')
    args = parser.parse_args()

    explorer = Explorer(args.session)
    try:
        explorer.start()
        if explorer.session_id:
            explorer.run_repl()
    finally:
        explorer.stop()
        print("\nBye!")


if __name__ == "__main__":
    main()
