import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const forbiddenImport = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)['"](?:@earendil-works\/pi-[^'"]*|@openinterpreter\/browser-agent-core(?:\/[^'"]*)?)['"]/;

test('desktop boundary recognizes every supported module import syntax', () => {
  const specifier = '@earendil-works/' + 'pi-ai';
  for (const source of [`import '${specifier}'`, `import { x } from '${specifier}'`,
    `import('${specifier}')`, `require('${specifier}')`])
    expect(forbiddenImport.test(source)).toBe(true);
});

test('desktop root and external source do not import Pi or depend on browser agent core', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect(Object.keys(manifest.dependencies).filter(name =>
    name.startsWith('@earendil-works/pi-') || name === '@openinterpreter/browser-agent-core'))
    .toEqual([]);
  const violations: string[] = [];
  // Git enumerates every tracked source (and nonignored new source) without
  // walking installed dependencies, generated builds or nested submodules.
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  for (const file of files) {
    if (file.startsWith('packages/browser-agent-core/') ||
        file.split('/').some(part => ['node_modules', 'dist', 'dist-electron', 'build', 'out', '.git'].includes(part)) ||
        !/\.[cm]?[jt]sx?$/.test(file)) continue;
    const filename = path.join(root, file);
    if (!statSync(filename).isFile()) continue;
    if (forbiddenImport.test(readFileSync(filename, 'utf8'))) violations.push(file);
  }
  expect(violations).toEqual([]);
});

test('package production source has no executable imports from root application modules', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard',
    'packages/browser-agent-core/src'], { cwd: root }).toString('utf8').split('\0').filter(file =>
    /\.tsx?$/.test(file) && !/\.(?:test|d)\.tsx?$/.test(file));
  const violations: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
          /^\.\.\/\.\.\/\.\.\/(?:src|server)\//.test(node.moduleSpecifier.text)) {
        const binding = node.importClause?.namedBindings;
        if (!node.importClause?.isTypeOnly && !(binding && ts.isNamedImports(binding) &&
            binding.elements.every(element => element.isTypeOnly))) violations.push(file);
      }
      if (ts.isCallExpression(node) && node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]) &&
          /^\.\.\/\.\.\/\.\.\/(?:src|server)\//.test(node.arguments[0].text) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            ts.isIdentifier(node.expression) && node.expression.text === 'require')) violations.push(file);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
