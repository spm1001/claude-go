#!/usr/bin/env node
/**
 * Keystroke Test Harness for Claude Go
 *
 * Tests tmux keystroke sequences for interacting with Claude Code's TUI.
 * This is a debugging tool, not production code.
 *
 * Usage:
 *   node scripts/keystroke-test.js <session-name> <test-case>
 *   node scripts/keystroke-test.js <session-name> --list
 *   node scripts/keystroke-test.js <session-name> --raw <keys...>
 *
 * Examples:
 *   node scripts/keystroke-test.js claude-abc123 permission-approve
 *   node scripts/keystroke-test.js claude-abc123 --raw "1" Tab Enter
 *   node scripts/keystroke-test.js claude-abc123 --list
 */

const { spawn } = require('child_process');

// ============================================================================
// Terminal Key Encodings Reference
// ============================================================================

const KEYS = {
  // Control characters
  enter: '\r',           // Carriage return
  tab: '\t',             // Horizontal tab
  escape: '\x1b',        // ESC
  backspace: '\x7f',     // DEL (also \x08 for BS)

  // Arrow keys (ANSI escape sequences)
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',

  // Common Ctrl combinations
  'ctrl-c': '\x03',      // ETX - interrupt
  'ctrl-d': '\x04',      // EOT - end of transmission
  'ctrl-z': '\x1a',      // SUB - suspend
  'ctrl-l': '\x0c',      // FF - clear screen

  // Bracketed paste mode
  pasteStart: '\x1b[200~',
  pasteEnd: '\x1b[201~',
};

// tmux send-keys keywords (alternative to raw bytes)
const TMUX_KEYWORDS = {
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  backspace: 'BSpace',
  up: 'Up',
  down: 'Down',
  right: 'Right',
  left: 'Left',
  'ctrl-c': 'C-c',
  'ctrl-d': 'C-d',
  'ctrl-z': 'C-z',
  'ctrl-l': 'C-l',
  space: 'Space',
};

// ============================================================================
// Test Cases
// ============================================================================

const TEST_CASES = {
  // Permission prompt responses
  'permission-approve': {
    description: 'Approve permission prompt (option 1 - allow once)',
    keys: ['1', 'Enter'],
    notes: 'Standard permission approval. Should be sent when Claude shows numbered options.',
  },
  'permission-approve-session': {
    description: 'Approve and remember for session (option 2)',
    keys: ['2', 'Enter'],
    notes: 'Allows tool for rest of session.',
  },
  'permission-approve-always': {
    description: 'Approve and trust permanently (option 3)',
    keys: ['3', 'Enter'],
    notes: 'Adds to permanent allow list.',
  },
  'permission-deny': {
    description: 'Deny permission with Escape',
    keys: ['Escape'],
    notes: 'Cancels the permission prompt.',
  },
  'permission-deny-n': {
    description: 'Deny permission with n key',
    keys: ['n', 'Enter'],
    notes: 'Alternative denial method.',
  },

  // AskUserQuestion responses
  'ask-option-1': {
    description: 'Select option 1 with Tab+Enter submit pattern',
    keys: ['1', 'Tab', 'Enter'],
    notes: 'Standard pattern: number selects, Tab moves to Submit, Enter confirms.',
  },
  'ask-option-2': {
    description: 'Select option 2 with Tab+Enter',
    keys: ['2', 'Tab', 'Enter'],
    notes: 'Same pattern for option 2.',
  },
  'ask-option-1-direct': {
    description: 'Try option 1 with just Enter (no Tab)',
    keys: ['1', 'Enter'],
    notes: 'Testing if Tab is actually needed.',
  },
  'ask-option-1-right': {
    description: 'Try option 1 with Right arrow to Submit',
    keys: ['1', 'Right', 'Enter'],
    notes: 'Alternative navigation to Submit button.',
  },

  // Multi-select responses
  'multi-1-3': {
    description: 'Multi-select options 1 and 3',
    keys: ['1', { delay: 50 }, '3', { delay: 50 }, 'Right', 'Enter'],
    notes: 'Numbers toggle, Right moves to Submit. 50ms delays for UI processing.',
  },
  'multi-1-2-3': {
    description: 'Multi-select options 1, 2, and 3',
    keys: ['1', { delay: 50 }, '2', { delay: 50 }, '3', { delay: 50 }, 'Right', 'Enter'],
    notes: 'All three options toggled.',
  },

  // ExitPlanMode responses
  'plan-approve': {
    description: 'Approve plan and start implementation',
    keys: ['1', 'Tab', 'Enter'],
    notes: 'Same as AskUserQuestion pattern - select option 1.',
  },
  'plan-reject': {
    description: 'Reject plan / request revision',
    keys: ['2', 'Tab', 'Enter'],
    notes: 'Option 2 typically means revise or reject.',
  },

  // User input
  'simple-message': {
    description: 'Send simple text message',
    keys: [{ literal: 'Hello Claude' }, 'Enter'],
    notes: 'Literal text with Enter to submit.',
  },

  // Control sequences
  'interrupt': {
    description: 'Send Ctrl+C interrupt',
    keys: ['C-c'],
    notes: 'Interrupts current operation.',
  },
  'just-enter': {
    description: 'Just press Enter (continue prompts)',
    keys: ['Enter'],
    notes: 'For simple continue prompts.',
  },

  // Edge case testing
  'y-enter': {
    description: 'Simple y/Enter response',
    keys: ['y', 'Enter'],
    notes: 'For rare y/n prompts (not numbered options).',
  },
  'n-enter': {
    description: 'Simple n/Enter response',
    keys: ['n', 'Enter'],
    notes: 'Denial for y/n prompts.',
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert a key to its hex representation for logging
 */
function toHex(str) {
  if (typeof str !== 'string') return str;
  return [...str].map(c => {
    const code = c.charCodeAt(0);
    if (code < 32 || code > 126) {
      return `\\x${code.toString(16).padStart(2, '0')}`;
    }
    return c;
  }).join('');
}

/**
 * Log a key sequence with hex dump
 */
function logKeySequence(keys) {
  console.log('\n📋 Key sequence to send:');
  for (const key of keys) {
    if (typeof key === 'object' && key.delay) {
      console.log(`   ⏱️  delay(${key.delay}ms)`);
    } else if (typeof key === 'object' && key.literal) {
      console.log(`   📝 literal: "${key.literal}" → ${toHex(key.literal)}`);
    } else if (TMUX_KEYWORDS[key]) {
      const raw = KEYS[key] || key;
      console.log(`   🔤 ${key} → tmux: "${TMUX_KEYWORDS[key]}" (raw: ${toHex(raw)})`);
    } else if (KEYS[key]) {
      console.log(`   🔤 ${key} → raw: ${toHex(KEYS[key])}`);
    } else {
      // Assume it's a tmux keyword or literal
      console.log(`   🔤 "${key}" (tmux keyword or literal)`);
    }
  }
  console.log('');
}

/**
 * Execute tmux send-keys with spawn (safe for special chars)
 */
function tmuxSendKeys(session, ...args) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['send-keys', '-t', session, ...args];
    console.log(`   → tmux ${fullArgs.join(' ')}`);

    const proc = spawn('tmux', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data; });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux send-keys failed (${code}): ${stderr}`));
    });
  });
}

/**
 * Capture current terminal state via pipe-pane (for debugging)
 */
async function captureTerminal(session, outputFile = '/tmp/keystroke-test-capture.txt') {
  const { execSync } = require('child_process');
  try {
    // Set up pipe-pane capture
    execSync(`tmux pipe-pane -t ${session} "cat > ${outputFile}"`, { stdio: 'ignore' });

    // Give it a moment to capture current state
    await new Promise(r => setTimeout(r, 200));

    // Stop capturing
    execSync(`tmux pipe-pane -t ${session}`, { stdio: 'ignore' });

    // Read and display capture
    const fs = require('fs');
    if (fs.existsSync(outputFile)) {
      const content = fs.readFileSync(outputFile, 'utf-8');
      // Filter out escape sequences for readability
      const cleaned = content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      return cleaned;
    }
    return '[No capture available]';
  } catch (err) {
    return `[Capture failed: ${err.message}]`;
  }
}

/**
 * Check if session exists
 */
async function sessionExists(session) {
  const { execSync } = require('child_process');
  try {
    execSync(`tmux has-session -t "${session}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a test sequence to a tmux session
 */
async function sendTestSequence(session, keys, options = {}) {
  const { dryRun = false, verbose = true } = options;

  if (verbose) {
    logKeySequence(keys);
  }

  if (dryRun) {
    console.log('🔸 Dry run - not actually sending keys');
    return;
  }

  console.log(`📤 Sending to session: ${session}`);

  for (const key of keys) {
    // Handle delay objects
    if (typeof key === 'object' && key.delay) {
      console.log(`   ⏱️  Waiting ${key.delay}ms...`);
      await new Promise(r => setTimeout(r, key.delay));
      continue;
    }

    // Handle literal text
    if (typeof key === 'object' && key.literal) {
      await tmuxSendKeys(session, '-l', key.literal);
      continue;
    }

    // Handle tmux keywords (Enter, Tab, etc.)
    // tmux send-keys interprets these directly
    await tmuxSendKeys(session, key);
  }

  console.log('\n✅ Keys sent successfully');
}

/**
 * List all available test cases
 */
function listTestCases() {
  console.log('\n📋 Available Test Cases:\n');

  const categories = {
    'Permission prompts': ['permission-approve', 'permission-approve-session', 'permission-approve-always', 'permission-deny', 'permission-deny-n'],
    'AskUserQuestion': ['ask-option-1', 'ask-option-2', 'ask-option-1-direct', 'ask-option-1-right'],
    'Multi-select': ['multi-1-3', 'multi-1-2-3'],
    'ExitPlanMode': ['plan-approve', 'plan-reject'],
    'User input': ['simple-message'],
    'Control sequences': ['interrupt', 'just-enter'],
    'Edge cases': ['y-enter', 'n-enter'],
  };

  for (const [category, cases] of Object.entries(categories)) {
    console.log(`\n${category}:`);
    for (const name of cases) {
      const tc = TEST_CASES[name];
      console.log(`  ${name.padEnd(26)} - ${tc.description}`);
    }
  }
  console.log('\n');
}

/**
 * Show detailed info about a test case
 */
function showTestCase(name) {
  const tc = TEST_CASES[name];
  if (!tc) {
    console.error(`Unknown test case: ${name}`);
    process.exit(1);
  }

  console.log(`\n📋 Test Case: ${name}`);
  console.log(`   Description: ${tc.description}`);
  console.log(`   Notes: ${tc.notes}`);
  logKeySequence(tc.keys);
}

// ============================================================================
// Main CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(`
Usage:
  node scripts/keystroke-test.js <session-name> <test-case>
  node scripts/keystroke-test.js <session-name> --list
  node scripts/keystroke-test.js <session-name> --info <test-case>
  node scripts/keystroke-test.js <session-name> --raw <keys...>
  node scripts/keystroke-test.js <session-name> --capture

Options:
  --list          List all available test cases
  --info          Show detailed info about a test case (without sending)
  --raw           Send raw tmux keys (e.g., --raw "1" Tab Enter)
  --capture       Capture and display current terminal state
  --dry-run       Show what would be sent without sending

Examples:
  node scripts/keystroke-test.js claude-abc123 permission-approve
  node scripts/keystroke-test.js claude-abc123 --raw "1" Tab Enter
  node scripts/keystroke-test.js claude-abc123 --raw -l "Hello world" Enter
`);
    process.exit(1);
  }

  const session = args[0];

  // Handle --list without session check
  if (args[1] === '--list') {
    listTestCases();
    return;
  }

  // Check session exists
  if (!await sessionExists(session)) {
    console.error(`❌ Session not found: ${session}`);
    console.error('   List sessions with: tmux list-sessions');
    process.exit(1);
  }

  console.log(`🔗 Session verified: ${session}`);

  // Handle --capture
  if (args[1] === '--capture') {
    console.log('\n📺 Capturing terminal state...\n');
    const capture = await captureTerminal(session);
    console.log('--- Terminal Content ---');
    console.log(capture);
    console.log('--- End ---');
    return;
  }

  // Handle --info
  if (args[1] === '--info') {
    if (!args[2]) {
      console.error('Usage: --info <test-case>');
      process.exit(1);
    }
    showTestCase(args[2]);
    return;
  }

  // Handle --raw
  if (args[1] === '--raw') {
    const rawKeys = args.slice(2);
    if (rawKeys.length === 0) {
      console.error('Usage: --raw <keys...>');
      process.exit(1);
    }
    await sendTestSequence(session, rawKeys, { dryRun: args.includes('--dry-run') });
    return;
  }

  // Handle test case
  const testName = args[1];
  const dryRun = args.includes('--dry-run');

  if (!testName) {
    console.error('Please specify a test case or --list');
    process.exit(1);
  }

  const testCase = TEST_CASES[testName];
  if (!testCase) {
    console.error(`❌ Unknown test case: ${testName}`);
    console.error('   Run with --list to see available test cases');
    process.exit(1);
  }

  console.log(`\n🧪 Running test case: ${testName}`);
  console.log(`   ${testCase.description}`);
  console.log(`   Notes: ${testCase.notes}`);

  await sendTestSequence(session, testCase.keys, { dryRun });
}

main().catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
