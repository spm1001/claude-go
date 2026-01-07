#!/usr/bin/env python3
"""
Automated UI testing for Claude Go.

Usage:
    python scripts/test-ui.py                    # Run all tests
    python scripts/test-ui.py --test multi-question
    python scripts/test-ui.py --test button-click
    python scripts/test-ui.py --session <id>    # Use specific session
"""
import sys
import time
import json
import argparse
import subprocess
import requests
from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:7682"
DEFAULT_SESSION = None  # Will use first alive session

class ClaudeGoTester:
    def __init__(self, session_id=None):
        self.session_id = session_id
        self.page = None
        self.browser = None

    def __enter__(self):
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(headless=True)
        self.page = self.browser.new_page()
        self.page.goto(BASE_URL)
        self.page.wait_for_load_state('networkidle')
        self.page.wait_for_timeout(500)

        # Find session
        if not self.session_id:
            self.session_id = self._find_alive_session()

        if self.session_id:
            self._open_session(self.session_id)

        return self

    def __exit__(self, *args):
        self.browser.close()
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
        self.page.locator(f'.session-card[data-id="{session_id}"]').click()
        self.page.wait_for_timeout(1500)

    def inject_message(self, content):
        """Inject a mock message via dev endpoint."""
        payload = {
            "type": "messages",
            "data": [{
                "type": "assistant",
                "uuid": f"test-{int(time.time()*1000)}",
                "content": content
            }]
        }
        resp = requests.post(f"{BASE_URL}/dev/inject/{self.session_id}", json=payload)
        self.page.wait_for_timeout(300)
        return resp.json()

    def get_questions(self):
        """Get all question states from DOM."""
        return self.page.evaluate('''() => {
            return Array.from(document.querySelectorAll('.ask-user-question')).map(q => ({
                id: q.dataset.questionId,
                answered: q.classList.contains('answered'),
                header: q.querySelector('.question-header')?.textContent
            }));
        }''')

    def click_question_option(self, question_id, option_index=0):
        """Click an option on a question."""
        self.page.locator(f'[data-question-id="{question_id}"] .question-option').nth(option_index).click()
        self.page.wait_for_timeout(600)

    def send_message(self, text):
        """Type and send a message."""
        self.page.locator('#message-input').fill(text)
        self.page.locator('#send-btn').click()
        self.page.wait_for_timeout(500)

    def get_message_count(self):
        return self.page.evaluate('() => document.querySelectorAll(".message").length')

    def screenshot(self, name):
        path = f"/tmp/claude-go-test-{name}.png"
        self.page.screenshot(path=path)
        return path


def test_multi_question(tester):
    """Test that multi-question prompts can be answered in sequence."""
    print("\n=== TEST: Multi-Question Flow ===")

    tool_id = f"toolu_test_{int(time.time())}"

    # Inject multi-question
    tester.inject_message([{
        "type": "tool_use",
        "id": tool_id,
        "name": "AskUserQuestion",
        "input": {
            "questions": [
                {
                    "question": "Test Q1",
                    "header": "First",
                    "options": [{"label": "A", "description": "Option A"}, {"label": "B", "description": "Option B"}],
                    "multiSelect": False
                },
                {
                    "question": "Test Q2",
                    "header": "Second",
                    "options": [{"label": "X", "description": "Option X"}, {"label": "Y", "description": "Option Y"}],
                    "multiSelect": False
                }
            ]
        }
    }])

    # Find our questions
    questions = tester.get_questions()
    our_qs = [q for q in questions if q['id'] and tool_id in q['id']]

    if len(our_qs) != 2:
        print(f"❌ FAILED: Expected 2 questions, found {len(our_qs)}")
        return False

    # Answer Q1
    print(f"  Answering Q1: {our_qs[0]['header']}")
    tester.click_question_option(our_qs[0]['id'], 0)

    questions = tester.get_questions()
    q1_state = next((q for q in questions if q['id'] == our_qs[0]['id']), None)
    q2_state = next((q for q in questions if q['id'] == our_qs[1]['id']), None)

    if not q1_state['answered']:
        print("❌ FAILED: Q1 not marked answered after click")
        return False

    if q2_state['answered']:
        print("❌ FAILED: Q2 incorrectly marked answered")
        return False

    # Answer Q2
    print(f"  Answering Q2: {our_qs[1]['header']}")
    tester.click_question_option(our_qs[1]['id'], 0)

    questions = tester.get_questions()
    q2_state = next((q for q in questions if q['id'] == our_qs[1]['id']), None)

    if not q2_state['answered']:
        print("❌ FAILED: Q2 not marked answered after click")
        return False

    print("✅ PASSED: Multi-question flow works")
    return True


def test_send_message(tester):
    """Test sending a message via the input box."""
    print("\n=== TEST: Send Message ===")

    initial_count = tester.get_message_count()
    test_msg = f"Test message {int(time.time())}"

    tester.send_message(test_msg)

    new_count = tester.get_message_count()

    if new_count > initial_count:
        print("✅ PASSED: Message sent and appeared")
        return True
    else:
        print("❌ FAILED: Message not detected")
        return False


def test_exit_plan_mode(tester):
    """Test ExitPlanMode approve/reject."""
    print("\n=== TEST: ExitPlanMode ===")

    tool_id = f"toolu_plan_{int(time.time())}"

    # Inject plan
    tester.inject_message([{
        "type": "tool_use",
        "id": tool_id,
        "name": "ExitPlanMode",
        "input": {"plan": "## Test Plan\n1. Step one\n2. Step two"}
    }])

    # Find and click approve
    plan = tester.page.locator(f'[data-plan-id="plan-{tool_id}"]')
    if plan.count() == 0:
        print("❌ FAILED: Plan not rendered")
        return False

    tester.page.locator(f'[data-plan-id="plan-{tool_id}"] [data-action="approve-plan"]').click()
    tester.page.wait_for_timeout(600)

    is_answered = tester.page.evaluate(f'''() => {{
        const plan = document.querySelector('[data-plan-id="plan-{tool_id}"]');
        return plan?.classList.contains('answered');
    }}''')

    if is_answered:
        print("✅ PASSED: ExitPlanMode works")
        return True
    else:
        print("❌ FAILED: Plan not marked answered")
        return False


def get_tmux_pane(session_id):
    """Capture current tmux pane content."""
    result = subprocess.run(
        ["tmux", "capture-pane", "-t", f"claude-{session_id}", "-p"],
        capture_output=True, text=True
    )
    return result.stdout


def test_button_click(tester):
    """Test that clicking a real question button sends keystroke to tmux."""
    print("\n=== TEST: Button Click (End-to-End) ===")

    # Check if there's a real unanswered question
    questions = tester.page.locator('.ask-user-question:not(.answered)')
    if questions.count() == 0:
        print("⚠️  SKIPPED: No real unanswered questions (need live fishbowl)")
        return True  # Skip, not fail

    q_id = questions.first.get_attribute('data-question-id')
    print(f"  Found question: {q_id[:30]}...")

    # Check tmux before
    tmux_before = get_tmux_pane(tester.session_id)
    has_prompt = "Enter to select" in tmux_before
    print(f"  Tmux has prompt: {has_prompt}")

    if not has_prompt:
        print("⚠️  SKIPPED: Tmux not showing selection prompt")
        return True

    # Click the button
    option = questions.first.locator('.question-option').first
    print(f"  Clicking option...")
    option.click()
    tester.page.wait_for_timeout(2000)

    # Check tmux after
    tmux_after = get_tmux_pane(tester.session_id)
    prompt_gone = "Enter to select" not in tmux_after

    # Check UI
    updated_q = tester.page.locator(f'[data-question-id="{q_id}"]')
    is_answered = updated_q.evaluate('el => el.classList.contains("answered")')

    print(f"  UI answered: {is_answered}, Tmux cleared: {prompt_gone}")

    if is_answered and prompt_gone:
        print("✅ PASSED: Button click sent keystroke to Claude")
        return True
    else:
        print("❌ FAILED: Button click didn't work end-to-end")
        return False


TESTS = {
    'multi-question': test_multi_question,
    'send-message': test_send_message,
    'exit-plan-mode': test_exit_plan_mode,
    'button-click': test_button_click,
}


def main():
    parser = argparse.ArgumentParser(description='Claude Go UI Tests')
    parser.add_argument('--test', choices=list(TESTS.keys()), help='Run specific test')
    parser.add_argument('--session', help='Session ID to use')
    args = parser.parse_args()

    with ClaudeGoTester(args.session) as tester:
        if not tester.session_id:
            print("❌ No sessions found")
            return 1

        print(f"Using session: {tester.session_id[:8]}...")

        tests_to_run = [args.test] if args.test else list(TESTS.keys())
        results = {}

        for test_name in tests_to_run:
            try:
                results[test_name] = TESTS[test_name](tester)
            except Exception as e:
                print(f"❌ {test_name} ERRORED: {e}")
                results[test_name] = False

        print(f"\n{'='*40}")
        passed = sum(results.values())
        total = len(results)
        print(f"Results: {passed}/{total} passed")

        return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
