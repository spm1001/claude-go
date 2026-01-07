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


def test_multiselect(tester):
    """Test multi-select question (toggle options, submit)."""
    print("\n=== TEST: MultiSelect Question ===")

    tool_id = f"toolu_multi_{int(time.time())}"

    # Inject multi-select question
    tester.inject_message([{
        "type": "tool_use",
        "id": tool_id,
        "name": "AskUserQuestion",
        "input": {
            "questions": [{
                "question": "Which features do you want?",
                "header": "Features",
                "multiSelect": True,
                "options": [
                    {"label": "Auth", "description": "Authentication"},
                    {"label": "API", "description": "REST API"},
                    {"label": "DB", "description": "Database"}
                ]
            }]
        }
    }])

    # Find the question
    q_selector = f'[data-question-id*="{tool_id}"]'
    question = tester.page.locator(q_selector)

    if question.count() == 0:
        print("❌ FAILED: Multi-select question not rendered")
        return False

    # Should have toggle buttons, not select buttons
    toggle_btns = question.locator('[data-action="toggle"]')
    submit_btn = question.locator('[data-action="submit-multi"]')

    if toggle_btns.count() != 3:
        print(f"❌ FAILED: Expected 3 toggle buttons, found {toggle_btns.count()}")
        return False

    if submit_btn.count() != 1:
        print(f"❌ FAILED: Expected 1 submit button, found {submit_btn.count()}")
        return False

    # Toggle first and third options
    toggle_btns.nth(0).click()
    tester.page.wait_for_timeout(200)
    toggle_btns.nth(2).click()
    tester.page.wait_for_timeout(200)

    # Verify selection state
    btn1_selected = toggle_btns.nth(0).evaluate('el => el.classList.contains("selected")')
    btn2_selected = toggle_btns.nth(1).evaluate('el => el.classList.contains("selected")')
    btn3_selected = toggle_btns.nth(2).evaluate('el => el.classList.contains("selected")')

    if not (btn1_selected and not btn2_selected and btn3_selected):
        print(f"❌ FAILED: Toggle state wrong: {btn1_selected}, {btn2_selected}, {btn3_selected}")
        return False

    # Submit
    submit_btn.click()
    tester.page.wait_for_timeout(600)

    # Check answered state
    is_answered = question.first.evaluate('el => el.classList.contains("answered")')

    if is_answered:
        print("✅ PASSED: Multi-select UI works (toggle + submit)")
        return True
    else:
        print("❌ FAILED: Question not marked answered after submit")
        return False


def test_exit_plan_reject(tester):
    """Test ExitPlanMode reject button."""
    print("\n=== TEST: ExitPlanMode Reject ===")

    tool_id = f"toolu_reject_{int(time.time())}"

    # Inject plan
    tester.inject_message([{
        "type": "tool_use",
        "id": tool_id,
        "name": "ExitPlanMode",
        "input": {"plan": "## Plan to Reject\n1. Bad step"}
    }])

    plan_selector = f'[data-plan-id="plan-{tool_id}"]'
    plan = tester.page.locator(plan_selector)

    if plan.count() == 0:
        print("❌ FAILED: Plan not rendered")
        return False

    reject_btn = plan.locator('[data-action="reject-plan"]')
    if reject_btn.count() == 0:
        print("❌ FAILED: Reject button not found")
        return False

    reject_btn.click()
    tester.page.wait_for_timeout(600)

    is_answered = plan.first.evaluate('el => el.classList.contains("answered")')

    if is_answered:
        print("✅ PASSED: ExitPlanMode reject works")
        return True
    else:
        print("❌ FAILED: Plan not marked answered after reject")
        return False


def test_other_option(tester):
    """Test 'Other' free-text option in AskUserQuestion."""
    print("\n=== TEST: Other Free-Text Option ===")

    # This tests if Claude Go handles the "Other" option that Claude auto-adds
    # Currently we don't render an explicit "Other" button - users type in input
    # This test verifies input works when question is present

    tool_id = f"toolu_other_{int(time.time())}"

    tester.inject_message([{
        "type": "tool_use",
        "id": tool_id,
        "name": "AskUserQuestion",
        "input": {
            "questions": [{
                "question": "Pick a color?",
                "header": "Color",
                "multiSelect": False,
                "options": [
                    {"label": "Red", "description": "Like blood"},
                    {"label": "Blue", "description": "Like sky"}
                ]
            }]
        }
    }])

    # Verify question rendered
    q_selector = f'[data-question-id*="{tool_id}"]'
    question = tester.page.locator(q_selector)

    if question.count() == 0:
        print("❌ FAILED: Question not rendered")
        return False

    # For "Other", user types in message input
    # Verify input is available and works
    initial_count = tester.get_message_count()
    tester.send_message("Green - like grass")
    tester.page.wait_for_timeout(500)

    new_count = tester.get_message_count()
    if new_count > initial_count:
        print("✅ PASSED: Can send custom 'Other' text via input")
        print("  ⚠️  NOTE: This doesn't mark question as answered (by design)")
        return True
    else:
        print("❌ FAILED: Could not send message while question is pending")
        return False


def test_permission_approve(tester):
    """Test permission card approve button."""
    print("\n=== TEST: Permission Approve ===")

    tool_use_id = f"toolu_perm_{int(time.time())}"

    # Inject permission request via dev endpoint
    payload = {
        "type": "permission_request",
        "data": {
            "tool_use_id": tool_use_id,
            "session_id": tester.session_id,
            "tool_name": "Bash",
            "tool_input": {"command": "echo test"},
            "received_at": int(time.time() * 1000)
        }
    }
    resp = requests.post(f"{BASE_URL}/dev/inject/{tester.session_id}", json=payload)
    if resp.status_code != 200:
        print(f"❌ FAILED: Could not inject permission: {resp.text}")
        return False

    tester.page.wait_for_timeout(500)

    # Find permission card
    card = tester.page.locator(f'.permission-card[data-tool-use-id="{tool_use_id}"]')
    if card.count() == 0:
        print("❌ FAILED: Permission card not rendered")
        return False

    # Verify tool name shown
    tool_name = card.locator('.permission-tool').text_content()
    if 'Bash' not in tool_name:
        print(f"❌ FAILED: Expected 'Bash' in tool name, got '{tool_name}'")
        return False

    # Click approve
    approve_btn = card.locator('[data-action="approve"]')
    approve_btn.click()
    tester.page.wait_for_timeout(800)

    # Card should be gone (permission resolved)
    remaining = tester.page.locator(f'.permission-card[data-tool-use-id="{tool_use_id}"]')
    if remaining.count() > 0:
        print("❌ FAILED: Permission card still visible after approve")
        return False

    print("✅ PASSED: Permission approve works")
    return True


def test_permission_deny(tester):
    """Test permission card deny button."""
    print("\n=== TEST: Permission Deny ===")

    tool_use_id = f"toolu_deny_{int(time.time())}"

    # Inject permission
    payload = {
        "type": "permission_request",
        "data": {
            "tool_use_id": tool_use_id,
            "session_id": tester.session_id,
            "tool_name": "Write",
            "tool_input": {"file_path": "/tmp/test.txt", "content": "test"},
            "received_at": int(time.time() * 1000)
        }
    }
    requests.post(f"{BASE_URL}/dev/inject/{tester.session_id}", json=payload)
    tester.page.wait_for_timeout(500)

    card = tester.page.locator(f'.permission-card[data-tool-use-id="{tool_use_id}"]')
    if card.count() == 0:
        print("❌ FAILED: Permission card not rendered")
        return False

    # Click deny
    deny_btn = card.locator('[data-action="deny"]')
    deny_btn.click()
    tester.page.wait_for_timeout(800)

    # Card should be gone
    remaining = tester.page.locator(f'.permission-card[data-tool-use-id="{tool_use_id}"]')
    if remaining.count() > 0:
        print("❌ FAILED: Permission card still visible after deny")
        return False

    print("✅ PASSED: Permission deny works")
    return True


def test_multiple_pending_permissions(tester):
    """Test multiple pending permissions render and resolve independently."""
    print("\n=== TEST: Multiple Pending Permissions ===")

    tool_use_id_1 = f"toolu_multi1_{int(time.time())}"
    tool_use_id_2 = f"toolu_multi2_{int(time.time())}"

    # Inject two permissions
    for tool_id, tool_name in [(tool_use_id_1, "Bash"), (tool_use_id_2, "Write")]:
        payload = {
            "type": "permission_request",
            "data": {
                "tool_use_id": tool_id,
                "session_id": tester.session_id,
                "tool_name": tool_name,
                "tool_input": {"command": "test"} if tool_name == "Bash" else {"file_path": "/tmp/x"},
                "received_at": int(time.time() * 1000)
            }
        }
        requests.post(f"{BASE_URL}/dev/inject/{tester.session_id}", json=payload)

    tester.page.wait_for_timeout(500)

    # Both should be visible
    card1 = tester.page.locator(f'.permission-card[data-tool-use-id="{tool_use_id_1}"]')
    card2 = tester.page.locator(f'.permission-card[data-tool-use-id="{tool_use_id_2}"]')

    if card1.count() == 0 or card2.count() == 0:
        print(f"❌ FAILED: Expected 2 cards, found {card1.count()} and {card2.count()}")
        return False

    # Approve first, verify second remains
    card1.locator('[data-action="approve"]').click()
    tester.page.wait_for_timeout(500)

    card1_after = tester.page.locator(f'.permission-card[data-tool-use-id="{tool_use_id_1}"]')
    card2_after = tester.page.locator(f'.permission-card[data-tool-use-id="{tool_use_id_2}"]')

    if card1_after.count() > 0:
        print("❌ FAILED: First card not removed after approve")
        return False

    if card2_after.count() == 0:
        print("❌ FAILED: Second card incorrectly removed")
        return False

    # Clean up - approve second
    card2_after.locator('[data-action="approve"]').click()
    tester.page.wait_for_timeout(300)

    print("✅ PASSED: Multiple permissions handled independently")
    return True


def test_rapid_clicks(tester):
    """Test rapid button clicks don't cause issues (double-tap prevention)."""
    print("\n=== TEST: Rapid Clicks (Double-tap Prevention) ===")

    tool_id = f"toolu_rapid_{int(time.time())}"

    # Inject question
    tester.inject_message([{
        "type": "tool_use",
        "id": tool_id,
        "name": "AskUserQuestion",
        "input": {
            "questions": [{
                "question": "Rapid test?",
                "header": "Rapid",
                "multiSelect": False,
                "options": [
                    {"label": "A", "description": "Option A"},
                    {"label": "B", "description": "Option B"}
                ]
            }]
        }
    }])

    q_selector = f'[data-question-id*="{tool_id}"]'
    question = tester.page.locator(q_selector)

    if question.count() == 0:
        print("❌ FAILED: Question not rendered")
        return False

    option = question.locator('.question-option').first

    # Click once
    option.click()

    # Immediately check if button is disabled (double-tap prevention)
    tester.page.wait_for_timeout(100)
    is_disabled = option.evaluate('el => el.disabled || el.classList.contains("loading")')

    if not is_disabled:
        print("❌ FAILED: Button not disabled after click (double-tap prevention broken)")
        return False

    # Wait for answered state
    tester.page.wait_for_timeout(600)
    is_answered = question.first.evaluate('el => el.classList.contains("answered")')

    if is_answered:
        print("✅ PASSED: Double-tap prevention works (button disabled, question answered)")
        return True
    else:
        print("❌ FAILED: Question not answered after click")
        return False


TESTS = {
    'multi-question': test_multi_question,
    'send-message': test_send_message,
    'exit-plan-mode': test_exit_plan_mode,
    'button-click': test_button_click,
    'multiselect': test_multiselect,
    'exit-plan-reject': test_exit_plan_reject,
    'other-option': test_other_option,
    'permission-approve': test_permission_approve,
    'permission-deny': test_permission_deny,
    'multiple-permissions': test_multiple_pending_permissions,
    'rapid-clicks': test_rapid_clicks,
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
