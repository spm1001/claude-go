#!/usr/bin/env python3
"""
End-to-end UI button test.

Tests that clicking buttons in the web UI actually sends the right
keystrokes to Claude via tmux.

Usage:
    python scripts/test-ui-buttons.py --session <id>
"""
import sys
import time
import subprocess
import argparse
from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:7682"


def get_tmux_pane(session_id):
    """Capture current tmux pane content."""
    result = subprocess.run(
        ["tmux", "capture-pane", "-t", f"claude-{session_id}", "-p"],
        capture_output=True, text=True
    )
    return result.stdout


def test_question_button_click(session_id):
    """Test that clicking a question option in the UI sends the right answer."""
    print(f"\n=== TEST: Question Button Click ===")
    print(f"Session: {session_id[:12]}...")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Open the session
        page.goto(BASE_URL)
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(500)

        # Click into the session
        card = page.locator(f'.session-card[data-id^="{session_id[:8]}"]')
        if card.count() == 0:
            print(f"❌ Session not found in UI")
            browser.close()
            return False

        card.click()
        page.wait_for_timeout(2000)

        # Find unanswered questions
        questions = page.locator('.ask-user-question:not(.answered)')
        if questions.count() == 0:
            print("❌ No unanswered questions found in UI")
            browser.close()
            return False

        print(f"  Found {questions.count()} unanswered question(s)")

        # Get the first question's ID
        first_q = questions.first
        q_id = first_q.get_attribute('data-question-id')
        print(f"  Question ID: {q_id}")

        # Check tmux state before clicking
        tmux_before = get_tmux_pane(session_id)
        has_prompt_before = "Enter to select" in tmux_before
        print(f"  Tmux has prompt before: {has_prompt_before}")

        # Click the first option
        option = first_q.locator('.question-option').first
        option_text = option.text_content()[:30]
        print(f"  Clicking option: {option_text}...")

        option.click()
        page.wait_for_timeout(1500)

        # Re-query the question (element may have been replaced during re-render)
        updated_q = page.locator(f'[data-question-id="{q_id}"]')
        is_answered = updated_q.evaluate('el => el.classList.contains("answered")')
        print(f"  UI shows answered: {is_answered}")

        # Check tmux state after clicking
        page.wait_for_timeout(2000)
        tmux_after = get_tmux_pane(session_id)
        prompt_gone = "Enter to select" not in tmux_after
        print(f"  Tmux prompt cleared: {prompt_gone}")

        browser.close()

        if is_answered and prompt_gone:
            print("✅ PASSED: Button click sent answer to Claude")
            return True
        elif is_answered and not prompt_gone:
            print("⚠️  PARTIAL: UI updated but tmux prompt still showing")
            return False
        else:
            print("❌ FAILED: Button click didn't work")
            return False


def main():
    parser = argparse.ArgumentParser(description='UI Button Test')
    parser.add_argument('--session', required=True, help='Session ID')
    args = parser.parse_args()

    success = test_question_button_click(args.session)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
