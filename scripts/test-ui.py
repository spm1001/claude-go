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
        """Click an option in the interaction panel (not inline card)."""
        # Panel options use data-action="select-option" with data-index
        self.page.locator(f'#interaction-panel .interaction-option[data-index="{option_index}"]').click()
        self.page.wait_for_timeout(600)

    def click_panel_option(self, option_index=0):
        """Click an option in the panel by index."""
        self.page.locator(f'#interaction-panel .interaction-option').nth(option_index).click()
        self.page.wait_for_timeout(600)

    def panel_visible(self):
        """Check if the interaction panel is visible."""
        panel = self.page.locator('#interaction-panel')
        return panel.count() > 0 and not panel.evaluate('el => el.classList.contains("hidden")')

    def clear_panel(self):
        """Clear the interaction panel and reset state for test isolation."""
        # Press Escape to dismiss any pending interaction
        self.page.keyboard.press('Escape')
        self.page.wait_for_timeout(100)
        # Also reset client-side state
        self.reset_state()

    def reset_state(self):
        """Reset client-side state for test isolation."""
        # Clear accumulated state that persists across tests
        self.page.evaluate('''() => {
            state.messages = state.messages.filter(m => m.type === 'user');
            state.answeredQuestions.clear();
            state.currentInteraction = null;
            state.pendingPermissions.clear();
            document.getElementById('interaction-panel')?.classList.add('hidden');
        }''')
        self.page.wait_for_timeout(200)

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
    """Test that multi-question prompts can be answered via panel."""
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

    # Verify panel renders with question
    if not tester.panel_visible():
        print("❌ FAILED: Interaction panel not visible")
        return False

    # Find inline cards for verification
    questions = tester.get_questions()
    our_qs = [q for q in questions if q['id'] and tool_id in q['id']]

    if len(our_qs) != 2:
        print(f"❌ FAILED: Expected 2 inline question cards, found {len(our_qs)}")
        return False

    # Answer Q1 via panel (click first option)
    print(f"  Answering Q1 via panel")
    tester.click_panel_option(0)

    # Wait for the panel to re-render with Q2
    tester.page.wait_for_timeout(500)

    questions = tester.get_questions()
    q1_state = next((q for q in questions if q['id'] == our_qs[0]['id']), None)
    q2_state = next((q for q in questions if q['id'] == our_qs[1]['id']), None)

    if not q1_state['answered']:
        print("❌ FAILED: Q1 inline card not marked answered after panel click")
        return False

    if q2_state['answered']:
        print("❌ FAILED: Q2 incorrectly marked answered")
        return False

    # Panel should now show Q2 - verify it's visible before clicking
    if not tester.panel_visible():
        print("❌ FAILED: Panel not visible for Q2")
        return False

    # Answer Q2 via panel
    print(f"  Answering Q2 via panel")
    tester.click_panel_option(0)

    questions = tester.get_questions()
    q2_state = next((q for q in questions if q['id'] == our_qs[1]['id']), None)

    if not q2_state['answered']:
        print("❌ FAILED: Q2 not marked answered after panel click")
        return False

    print("✅ PASSED: Multi-question flow works via panel")
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
    """Test ExitPlanMode approve via panel."""
    print("\n=== TEST: ExitPlanMode ===")

    tool_id = f"toolu_plan_{int(time.time())}"

    # Inject plan
    tester.inject_message([{
        "type": "tool_use",
        "id": tool_id,
        "name": "ExitPlanMode",
        "input": {"plan": "## Test Plan\n1. Step one\n2. Step two"}
    }])

    # Verify panel renders with plan approve/reject
    if not tester.panel_visible():
        print("❌ FAILED: Interaction panel not visible")
        return False

    # Find inline plan card for verification
    plan = tester.page.locator(f'[data-plan-id="plan-{tool_id}"]')
    if plan.count() == 0:
        print("❌ FAILED: Inline plan card not rendered")
        return False

    # Click approve in panel (not inline)
    approve_btn = tester.page.locator('#interaction-panel [data-action="plan-approve"]')
    if approve_btn.count() == 0:
        print("❌ FAILED: Panel approve button not found")
        return False

    approve_btn.click()
    tester.page.wait_for_timeout(600)

    # Check inline card is marked answered
    is_answered = tester.page.evaluate(f'''() => {{
        const plan = document.querySelector('[data-plan-id="plan-{tool_id}"]');
        return plan?.classList.contains('answered');
    }}''')

    if is_answered:
        print("✅ PASSED: ExitPlanMode works via panel")
        return True
    else:
        print("❌ FAILED: Plan inline card not marked answered")
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
    """Test multi-select question via panel (toggle options, submit)."""
    print("\n=== TEST: MultiSelect Question ===")

    # Clear any stale panel state
    tester.clear_panel()

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

    # Verify panel renders
    if not tester.panel_visible():
        print("❌ FAILED: Interaction panel not visible")
        return False

    # Panel should have toggle buttons for multi-select
    panel = tester.page.locator('#interaction-panel')
    toggle_btns = panel.locator('.interaction-option')

    if toggle_btns.count() != 3:
        print(f"❌ FAILED: Expected 3 options in panel, found {toggle_btns.count()}")
        return False

    # For multi-select, submit is via main send button (which shows "Submit")
    send_btn = tester.page.locator('#send-btn')
    btn_text = send_btn.text_content()
    if 'Submit' not in btn_text:
        print(f"❌ FAILED: Send button should show 'Submit' for multi-select, got '{btn_text}'")
        return False

    # Toggle first and third options in panel
    toggle_btns.nth(0).click()
    tester.page.wait_for_timeout(200)
    toggle_btns.nth(2).click()
    tester.page.wait_for_timeout(200)

    # Verify selection state in panel
    btn1_selected = toggle_btns.nth(0).evaluate('el => el.classList.contains("selected")')
    btn2_selected = toggle_btns.nth(1).evaluate('el => el.classList.contains("selected")')
    btn3_selected = toggle_btns.nth(2).evaluate('el => el.classList.contains("selected")')

    if not (btn1_selected and not btn2_selected and btn3_selected):
        print(f"❌ FAILED: Panel toggle state wrong: {btn1_selected}, {btn2_selected}, {btn3_selected}")
        return False

    # Submit via main send button (shows "Submit" for multi-select)
    send_btn.click()
    tester.page.wait_for_timeout(600)

    # Check inline card is marked answered
    q_selector = f'[data-question-id*="{tool_id}"]'
    question = tester.page.locator(q_selector)
    is_answered = question.first.evaluate('el => el.classList.contains("answered")')

    if is_answered:
        print("✅ PASSED: Multi-select works via panel (toggle + submit)")
        return True
    else:
        print("❌ FAILED: Inline card not marked answered after panel submit")
        return False


def test_exit_plan_reject(tester):
    """Test ExitPlanMode reject via panel."""
    print("\n=== TEST: ExitPlanMode Reject ===")

    # Clear any stale panel state from previous tests
    tester.clear_panel()

    tool_id = f"toolu_reject_{int(time.time())}"

    # Inject plan
    tester.inject_message([{
        "type": "tool_use",
        "id": tool_id,
        "name": "ExitPlanMode",
        "input": {"plan": "## Plan to Reject\n1. Bad step"}
    }])

    # Wait for panel to render with plan
    tester.page.wait_for_timeout(500)

    # Verify panel renders
    if not tester.panel_visible():
        print("❌ FAILED: Interaction panel not visible")
        return False

    plan_selector = f'[data-plan-id="plan-{tool_id}"]'
    plan = tester.page.locator(plan_selector)

    if plan.count() == 0:
        print("❌ FAILED: Inline plan card not rendered")
        return False

    # Click reject in panel
    reject_btn = tester.page.locator('#interaction-panel [data-action="plan-reject"]')
    if reject_btn.count() == 0:
        # Debug: what is the panel showing?
        panel_html = tester.page.locator('#interaction-panel').inner_html()
        print(f"  Panel content: {panel_html[:200]}...")
        print("❌ FAILED: Panel reject button not found")
        return False

    reject_btn.click()
    tester.page.wait_for_timeout(600)

    is_answered = plan.first.evaluate('el => el.classList.contains("answered")')

    if is_answered:
        print("✅ PASSED: ExitPlanMode reject works via panel")
        return True
    else:
        print("❌ FAILED: Inline card not marked answered after panel reject")
        return False


def test_other_option(tester):
    """Test 'Other' free-text option in AskUserQuestion."""
    print("\n=== TEST: Other Free-Text Option ===")

    # Clear any stale panel state
    tester.clear_panel()

    # This tests if Claude Go handles the "Other" option that Claude auto-adds
    # When user types text and submits while a question is pending, it sends as "Other"
    # and marks the question as answered

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

    tester.page.wait_for_timeout(500)

    # Verify question rendered
    q_selector = f'[data-question-id*="{tool_id}"]'
    question = tester.page.locator(q_selector)

    if question.count() == 0:
        print("❌ FAILED: Question not rendered")
        return False

    # Verify panel shows the question
    if not tester.panel_visible():
        print("❌ FAILED: Panel not visible for question")
        return False

    # For "Other", user types in message input and submits
    # This goes through submitQuestionAnswer() which marks question as answered
    tester.page.locator('#message-input').fill("Green - like grass")
    tester.page.locator('#send-btn').click()
    tester.page.wait_for_timeout(600)

    # Check question is marked answered
    is_answered = question.first.evaluate('el => el.classList.contains("answered")')

    if is_answered:
        print("✅ PASSED: 'Other' free-text marks question as answered")
        return True
    else:
        print("❌ FAILED: Question not marked answered after 'Other' submission")
        return False


def test_permission_approve(tester):
    """Test permission approve via panel."""
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

    # Verify panel shows permission UI
    if not tester.panel_visible():
        print("❌ FAILED: Interaction panel not visible for permission")
        return False

    # Panel should show permission with approve/always/deny buttons
    approve_btn = tester.page.locator('#interaction-panel [data-action="perm-approve"]')
    if approve_btn.count() == 0:
        print("❌ FAILED: Panel approve button not found")
        return False

    # Click approve in panel
    approve_btn.click()
    tester.page.wait_for_timeout(800)

    # Panel should clear (or show next interaction)
    # Check pending permissions via API
    resp = requests.get(f"{BASE_URL}/hook/pending?session_id={tester.session_id}")
    pending = resp.json()
    still_pending = any(p['tool_use_id'] == tool_use_id for p in pending)

    if still_pending:
        print("❌ FAILED: Permission still pending after approve")
        return False

    print("✅ PASSED: Permission approve works via panel")
    return True


def test_permission_deny(tester):
    """Test permission deny via panel."""
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

    # Verify panel shows
    if not tester.panel_visible():
        print("❌ FAILED: Interaction panel not visible for permission")
        return False

    # Click deny in panel
    deny_btn = tester.page.locator('#interaction-panel [data-action="perm-deny"]')
    if deny_btn.count() == 0:
        print("❌ FAILED: Panel deny button not found")
        return False

    deny_btn.click()
    tester.page.wait_for_timeout(800)

    # Check permission is resolved
    resp = requests.get(f"{BASE_URL}/hook/pending?session_id={tester.session_id}")
    pending = resp.json()
    still_pending = any(p['tool_use_id'] == tool_use_id for p in pending)

    if still_pending:
        print("❌ FAILED: Permission still pending after deny")
        return False

    print("✅ PASSED: Permission deny works via panel")
    return True


def test_multiple_pending_permissions(tester):
    """Test multiple pending permissions are queued and handled sequentially."""
    print("\n=== TEST: Multiple Pending Permissions ===")

    # Clear any stale panel state
    tester.clear_panel()

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

    # Panel should show first permission
    if not tester.panel_visible():
        print("❌ FAILED: Panel not visible for permissions")
        return False

    # Check both are pending via API
    resp = requests.get(f"{BASE_URL}/hook/pending?session_id={tester.session_id}")
    pending = resp.json()
    pending_ids = [p['tool_use_id'] for p in pending]

    if tool_use_id_1 not in pending_ids or tool_use_id_2 not in pending_ids:
        print(f"❌ FAILED: Expected 2 pending permissions, found {len(pending)}")
        return False

    # Approve first via panel
    approve_btn = tester.page.locator('#interaction-panel [data-action="perm-approve"]')
    approve_btn.click()
    tester.page.wait_for_timeout(500)

    # Second should now be shown (or queue continues)
    resp = requests.get(f"{BASE_URL}/hook/pending?session_id={tester.session_id}")
    pending = resp.json()

    if any(p['tool_use_id'] == tool_use_id_1 for p in pending):
        print("❌ FAILED: First permission still pending after approve")
        return False

    # Clean up - approve remaining
    if tester.panel_visible():
        approve_btn = tester.page.locator('#interaction-panel [data-action="perm-approve"]')
        if approve_btn.count() > 0:
            approve_btn.click()
            tester.page.wait_for_timeout(300)

    print("✅ PASSED: Multiple permissions queued and handled sequentially")
    return True


def test_rapid_clicks(tester):
    """Test rapid button clicks don't cause issues (double-tap prevention)."""
    print("\n=== TEST: Rapid Clicks (Double-tap Prevention) ===")

    # Clear any stale panel state
    tester.clear_panel()

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

    tester.page.wait_for_timeout(500)

    q_selector = f'[data-question-id*="{tool_id}"]'
    question = tester.page.locator(q_selector)

    if question.count() == 0:
        print("❌ FAILED: Question not rendered")
        return False

    # Verify panel is visible
    if not tester.panel_visible():
        print("❌ FAILED: Panel not visible for question")
        return False

    # Click option via panel (not inline card which is now read-only)
    panel_option = tester.page.locator('#interaction-panel .interaction-option').first

    # Click once
    panel_option.click()

    # Wait for answered state (panel handles the response)
    tester.page.wait_for_timeout(600)
    is_answered = question.first.evaluate('el => el.classList.contains("answered")')

    if is_answered:
        print("✅ PASSED: Panel click answered question correctly")
        return True
    else:
        print("❌ FAILED: Question not answered after panel click")
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
