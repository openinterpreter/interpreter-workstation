#!/usr/bin/env npx ts-node

/**
 * Selector Lint - Enforces Type-Safe Test Selectors
 *
 * FOUR CHECKS:
 * 1. Tests must use sel() or sel.xxx() instead of raw strings
 * 2. selectors.ts methods must reference ELEMENT_IDS, not hardcoded strings
 * 3. Components must use constants for data-testid, not raw strings
 * 4. Every ID in element-ids.ts must be used in at least one component
 *
 * Architecture: shared/element-ids.ts defines all IDs. Components and tests
 * import FROM it. No hardcoded strings anywhere in the chain.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

/** Recursively find files matching extension */
function findFiles(dir: string, ext: string): string[] {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith(ext))
    .map(e => path.join(e.parentPath || e.path, e.name));
}

interface Violation {
  file: string;
  line: number;
  context: string;
  type: 'raw-selector' | 'hardcoded-method' | 'raw-testid';
}

/**
 * Extract all exported ID constants from element-ids.ts
 * Returns constant names like EXPLORER_ID, FILE_TREE_ID, etc.
 */
function getExportedIds(elementIdsPath: string): string[] {
  const content = fs.readFileSync(elementIdsPath, 'utf-8');
  const ids: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    // Skip comments
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Match: export const SOME_ID = 'value' as const;
    // Match: export const SOME_ID = (param) => `value-${param}` as const;
    const idMatch = line.match(/^export\s+const\s+([A-Z][A-Z0-9_]*_ID)\s*=/);
    if (idMatch) {
      ids.push(idMatch[1]);
    }

    // Also match CLASS constants like SOME_CLASS
    const classMatch = line.match(/^export\s+const\s+([A-Z][A-Z0-9_]*_CLASS)\s*=/);
    if (classMatch) {
      ids.push(classMatch[1]);
    }
  }

  return ids;
}

/**
 * Check if an ID constant is used in any component file
 * Looks for: data-testid={ID}, testId={ID}, id={ID}, or spread patterns
 */
function isIdUsedInComponents(idName: string, componentFiles: string[]): boolean {
  for (const file of componentFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    // Check for various usage patterns:
    // data-testid={EXPLORER_ID}
    // testId={EXPLORER_ID}
    // id={EXPLORER_ID}
    // 'data-testid': EXPLORER_ID (spread syntax)
    // className={EXPLORER_CLASS}
    // Also check if it's used in a function call like SOME_ID(param)
    const patterns = [
      new RegExp(`data-testid=\\{${idName}[\\s}(]`),
      new RegExp(`testId=\\{${idName}[\\s}(]`),
      new RegExp(`\\bid=\\{${idName}[\\s}(]`),
      new RegExp(`['"]data-testid['"]:\\s*${idName}`),  // 'data-testid': ID
      new RegExp(`className=\\{${idName}[\\s}]`),  // For CLASS constants
      new RegExp(`className=\\{[^}]*${idName}`),   // className={`${SOME_CLASS} other`}
      new RegExp(`className=["'][^"']*\\$\\{${idName}\\}`),  // className="${ID}"
      new RegExp(`\\?\\s*${idName}\\s*:`),  // ternary: condition ? ID : other
      new RegExp(`:\\s*${idName}[\\s})]`),  // ternary: condition ? other : ID
    ];

    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Find IDs that are exported but never used in any component
 */
function findUnusedIds(elementIdsPath: string, componentFiles: string[]): string[] {
  const exportedIds = getExportedIds(elementIdsPath);
  const unusedIds: string[] = [];

  // Some IDs are only used in selectors.ts for prefix matching or tests, not in components
  // These are okay to skip
  const allowedUnused = new Set([
    // Selector-only patterns (used in tests to match any element of a type)
    'AGENT_TAB_ANY_SELECTOR',
    'APPROVAL_ITEM_ANY_SELECTOR',
    // Complex selectors that combine multiple attributes (test-only)
    'ACTIVE_AGENT_THREAD_ID',  // Generates [data-testid="..."][data-active="true"]
    // Simple ID passthrough for tests
    'MESSAGE_ID',  // Just returns the messageId as-is for test matching
  ]);

  for (const idName of exportedIds) {
    if (allowedUnused.has(idName)) continue;
    if (!isIdUsedInComponents(idName, componentFiles)) {
      unusedIds.push(idName);
    }
  }

  return unusedIds;
}

const ALLOWED_IN_TESTS = [
  /\.locator\s*\(\s*sel\s*[\.(]/,
  /\.getByTestId\s*\(\s*testId\s*\(/,
];

/**
 * Check test files for raw string selectors
 */
function checkTestFile(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Raw string in locator()
    if (/\.locator\s*\(\s*['"`]/.test(line) && !ALLOWED_IN_TESTS.some(p => p.test(line))) {
      violations.push({ file, line: i + 1, context: trimmed, type: 'raw-selector' });
    }

    // Template literal without sel
    if (/\.locator\s*\(\s*`(?!\$\{sel)/.test(line)) {
      violations.push({ file, line: i + 1, context: trimmed, type: 'raw-selector' });
    }

    // Raw string in getByTestId
    if (/\.getByTestId\s*\(\s*['"`]/.test(line) && !/testId\s*\(/.test(line)) {
      violations.push({ file, line: i + 1, context: trimmed, type: 'raw-selector' });
    }
  }

  return violations;
}

/**
 * Check selectors.ts for hardcoded strings that don't reference ELEMENT_IDS
 */
function checkSelectorsFile(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  let inSelObject = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/export const sel = Object\.assign/.test(line)) {
      inSelObject = true;
      continue;
    }
    if (inSelObject && /^\}\);/.test(trimmed)) {
      inSelObject = false;
      continue;
    }

    if (!inSelObject) continue;
    if (trimmed.startsWith('//')) continue;

    const arrowMatch = line.match(/^\s*(\w+):\s*\([^)]*\)\s*=>\s*(.+),?\s*$/);
    if (!arrowMatch) continue;

    const [, methodName, returnValue] = arrowMatch;
    const rv = returnValue.replace(/,\s*$/, '').trim();

    if (/ELEMENT_IDS/.test(rv)) continue;
    if (/selStatic/.test(rv)) continue;

    if (/^['"`]/.test(rv) || /^`/.test(rv)) {
      violations.push({
        file,
        line: i + 1,
        context: `${methodName}: ${rv}`,
        type: 'hardcoded-method',
      });
    }
  }

  return violations;
}

/**
 * Check component files for raw strings in data-testid
 *
 * Valid: data-testid={MY_CONSTANT} or data-testid={SOME_FUNC(id)}
 * Invalid: data-testid="raw-string" or data-testid={`template-${x}`}
 */
function checkComponentFile(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Skip selector constant definitions in element-ids.ts (they contain data-testid in CSS selector strings)
    if (/const\s+\w+_SELECTOR\s*=/.test(line)) continue;
    if (/const\s+\w+_ID\s*=.*\[data-testid/.test(line)) continue;

    // Check for data-testid="raw-string" (raw string, not a variable)
    const rawStringMatch = line.match(/data-testid\s*=\s*["']([^"']+)["']/);
    if (rawStringMatch) {
      violations.push({
        file,
        line: i + 1,
        context: `data-testid="${rawStringMatch[1]}"`,
        type: 'raw-testid',
      });
      continue;
    }

    // Check for data-testid={`template-literal`} without using a constant
    // Valid: data-testid={`${SOME_ID}-${x}`} where SOME_ID is a constant
    // Invalid: data-testid={`raw-${x}`}
    const templateMatch = line.match(/data-testid\s*=\s*\{`([^`]+)`\}/);
    if (templateMatch) {
      const template = templateMatch[1];
      // If it doesn't reference an UPPER_CASE constant, it's probably raw
      // Look for patterns like ${SOME_CONSTANT} or ${SOME_FUNC(
      if (!/\$\{[A-Z][A-Z0-9_]*[\s(}]/.test(template) && !/\$\{[A-Z][A-Z0-9_]*\(/.test(template)) {
        violations.push({
          file,
          line: i + 1,
          context: `data-testid={\`${template}\`}`,
          type: 'raw-testid',
        });
      }
    }
  }

  return violations;
}

function main() {
  const testFiles = findFiles(path.join(ROOT, 'tests'), '.spec.ts');
  const selectorsFile = path.join(ROOT, 'tests/selectors.ts');
  const elementIdsFile = path.join(ROOT, 'shared/element-ids.ts');

  // Component files (tsx files in src/ and agent/)
  const componentFiles = [
    ...findFiles(path.join(ROOT, 'src'), '.tsx'),
    ...findFiles(path.join(ROOT, 'agent'), '.tsx'),
  ];

  const all: Violation[] = [];

  // Check test files
  for (const f of testFiles) {
    const content = fs.readFileSync(f, 'utf-8');
    all.push(...checkTestFile(path.relative(ROOT, f), content));
  }

  // Check selectors.ts for hardcoded methods
  if (fs.existsSync(selectorsFile)) {
    const content = fs.readFileSync(selectorsFile, 'utf-8');
    all.push(...checkSelectorsFile('tests/selectors.ts', content));
  }

  // Check component files for raw data-testid
  for (const f of componentFiles) {
    const content = fs.readFileSync(f, 'utf-8');
    const relPath = path.relative(ROOT, f);
    all.push(...checkComponentFile(relPath, content));
  }

  // Check for unused IDs (defined in element-ids.ts but not used in any component)
  const unusedIds = findUnusedIds(elementIdsFile, componentFiles);

  if (all.length === 0 && unusedIds.length === 0) {
    console.log('✓ All selectors are type-safe.');
    process.exit(0);
  }

  // Group by type
  const rawSelectors = all.filter(v => v.type === 'raw-selector');
  const hardcodedMethods = all.filter(v => v.type === 'hardcoded-method');
  const rawTestIds = all.filter(v => v.type === 'raw-testid');

  if (rawSelectors.length > 0) {
    console.log(`\n${rawSelectors.length} raw selector(s) in tests:\n`);
    const byFile = new Map<string, Violation[]>();
    for (const v of rawSelectors) {
      if (!byFile.has(v.file)) byFile.set(v.file, []);
      byFile.get(v.file)!.push(v);
    }
    for (const [file, vs] of byFile) {
      console.log(`${file}:`);
      for (const v of vs) console.log(`  L${v.line}: ${v.context}`);
    }
    console.log('\n→ Use sel() or sel.xxx() from tests/selectors.ts');
  }

  if (hardcodedMethods.length > 0) {
    console.log(`\n${hardcodedMethods.length} hardcoded method(s) in selectors.ts:\n`);
    for (const v of hardcodedMethods) {
      console.log(`  L${v.line}: ${v.context}`);
    }
    console.log('\n→ These must reference ELEMENT_IDS, not hardcoded strings.');
  }

  if (rawTestIds.length > 0) {
    console.log(`\n${rawTestIds.length} raw data-testid(s) in components:\n`);
    const byFile = new Map<string, Violation[]>();
    for (const v of rawTestIds) {
      if (!byFile.has(v.file)) byFile.set(v.file, []);
      byFile.get(v.file)!.push(v);
    }
    for (const [file, vs] of byFile) {
      console.log(`${file}:`);
      for (const v of vs) console.log(`  L${v.line}: ${v.context}`);
    }
    console.log('\n→ Use a constant imported from shared/element-ids.ts');
    console.log('→ Example: import { MY_ID } from "../../shared/element-ids";');
  }

  if (unusedIds.length > 0) {
    console.log(`\n${unusedIds.length} unused ID(s) in element-ids.ts:\n`);
    for (const id of unusedIds) {
      console.log(`  ${id}`);
    }
    console.log('\n→ These IDs are exported but never used in any component.');
    console.log('→ Either use them with data-testid={ID} or testId={ID}, or remove them.');
  }

  process.exit(1);
}

main();
