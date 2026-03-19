#!/usr/bin/env node
// ── Crash Pattern Guard ──────────────────────────────────────────────
// Prevents the var||[].method() operator precedence bug that caused
// 3 production crashes. Run via: npm run check-crashes
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../src/App.jsx');
const code = fs.readFileSync(FILE, 'utf8');
const lines = code.split('\n');
let errors = 0;

// Rule 1: var||[].method() — THE crash pattern
const rule1 = /([a-zA-Z_$][a-zA-Z0-9_$]*)\|\|\[\]\.(length|filter|map|find|forEach|reduce|some|every|includes|slice|sort|join|flat|indexOf|reverse)/g;
let m;
while ((m = rule1.exec(code)) !== null) {
  const lineNum = code.substring(0, m.index).split('\n').length;
  if (!lines[lineNum - 1].trim().startsWith('//')) {
    console.error(`❌  CRASH at L${lineNum}: "${m[0]}"  →  fix: (${m[1]}||[]).${m[2]}(...)`);
    errors++;
  }
}

// Rule 2: React.useState / React.useEffect TDZ crash
const rule2 = /React\.(useState|useEffect|useRef|useCallback|useMemo)\s*\(/g;
while ((m = rule2.exec(code)) !== null) {
  const lineNum = code.substring(0, m.index).split('\n').length;
  if (!lines[lineNum - 1].trim().startsWith('//')) {
    console.error(`❌  TDZ risk at L${lineNum}: React.${m[1]}() — use imported hook`);
    errors++;
  }
}

if (errors === 0) {
  console.log('✅  Crash pattern check passed — ' + lines.length + ' lines clean');
} else {
  console.error(`\n🚨  ${errors} crash pattern(s) found — fix before deploying`);
  process.exit(1);
}
