#!/usr/bin/env python3
"""
Inspect Claude Go session DOM state.

Usage:
    python scripts/inspect-session.py <session-id>
    python scripts/inspect-session.py <session-id> --screenshot
    python scripts/inspect-session.py --list
"""
import sys
import json
from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:7682"

def list_sessions():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(BASE_URL)
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(500)

        sessions = page.evaluate('''() => {
            return Array.from(document.querySelectorAll('.session-card')).map(el => ({
                id: el.dataset.id,
                name: el.querySelector('.name')?.textContent,
                preview: el.querySelector('.preview')?.textContent,
                alive: el.querySelector('.status-dot')?.classList.contains('alive')
            }));
        }''')

        print(f"Found {len(sessions)} sessions:")
        for s in sessions:
            status = "🟢" if s['alive'] else "⚪"
            print(f"  {status} {s['id'][:8]}... - {s['name']} ({s['preview']})")

        browser.close()

def inspect_session(session_id, screenshot=False):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(BASE_URL)
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(500)

        # Click into session
        card = page.locator(f'.session-card[data-id="{session_id}"]')
        if card.count() == 0:
            # Try partial match
            card = page.locator(f'.session-card[data-id^="{session_id}"]')

        if card.count() == 0:
            print(f"Session not found: {session_id}")
            browser.close()
            return

        card.click()
        page.wait_for_timeout(1500)

        if screenshot:
            path = f"/tmp/claude-go-{session_id[:8]}.png"
            page.screenshot(path=path, full_page=True)
            print(f"Screenshot: {path}")

        # Extract DOM state
        messages = page.evaluate('''() => {
            const msgs = [];
            document.querySelectorAll('.message').forEach((el, i) => {
                const questions = [];
                el.querySelectorAll('.ask-user-question').forEach(q => {
                    questions.push({
                        id: q.dataset.questionId,
                        answered: q.classList.contains('answered'),
                        loading: q.querySelector('.loading') !== null,
                        header: q.querySelector('.question-header')?.textContent
                    });
                });

                const plans = [];
                el.querySelectorAll('.exit-plan-mode').forEach(p => {
                    plans.push({
                        id: p.dataset.planId,
                        answered: p.classList.contains('answered')
                    });
                });

                msgs.push({
                    idx: i,
                    uuid: el.dataset.uuid,
                    type: el.classList.contains('user') ? 'user' : 'assistant',
                    pending: el.classList.contains('pending'),
                    preview: el.textContent?.substring(0, 80).trim().replace(/\\s+/g, ' '),
                    questions,
                    plans
                });
            });
            return msgs;
        }''')

        print(f"\n{'='*60}")
        print(f"Session: {session_id}")
        print(f"Messages: {len(messages)}")
        print(f"{'='*60}\n")

        for m in messages:
            prefix = "👤" if m['type'] == 'user' else "🤖"
            flags = []
            if m['pending']:
                flags.append('PENDING')

            extra = ""
            if m['questions']:
                for q in m['questions']:
                    state = "✓" if q['answered'] else ("⏳" if q['loading'] else "?")
                    extra += f"\n     └─ Q: {q['header']} [{state}]"
            if m['plans']:
                for p in m['plans']:
                    state = "✓" if p['answered'] else "?"
                    extra += f"\n     └─ Plan [{state}]"

            flag_str = f" [{', '.join(flags)}]" if flags else ""
            print(f"{m['idx']:2d} {prefix} {m['preview'][:55]}{flag_str}{extra}")

        browser.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if sys.argv[1] == "--list":
        list_sessions()
    else:
        session_id = sys.argv[1]
        screenshot = "--screenshot" in sys.argv
        inspect_session(session_id, screenshot)
