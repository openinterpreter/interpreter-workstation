import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const source = (path: string) => readFileSync(join(appRoot, path), 'utf8');
const runtimeImports = (text: string) => [...text.matchAll(/^import\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)]
  .map(match => match[1]);

function runtimeGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const pending = entries.map(entry => join(appRoot, entry));
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
      const candidate = specifier.startsWith('@/')
        ? join(appRoot, 'src', specifier.slice(2))
        : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
      if (!candidate) continue;
      const resolved = [candidate, `${candidate}.ts`, `${candidate}.tsx`,
        join(candidate, 'index.ts'), join(candidate, 'index.tsx')]
        .find(path => existsSync(path) && statSync(path).isFile() && !path.includes('/node_modules/'));
      if (resolved) pending.push(resolved);
    }
  }
  return [...seen];
}

describe('browser embedding boundary', () => {
  test('generic composer and browser entry points do not import native voice or app onboarding', () => {
    const graph = runtimeGraph([
      'agent/components/ComposerArea.tsx',
      'src/components/simple/SimpleShell.tsx',
      'src/browser-project/SimpleBrowserProject.tsx',
    ]);
    const banned = /\/(voiceCapture|qwenVoiceStreamBridge|moonshine|voiceLatency|nativeComposerVoiceAdapter|OnboardingOverlay)\.[jt]sx?$/;
    expect(graph.filter(path => banned.test(path))).toEqual([]);
    expect(graph.length).toBeGreaterThan(100);
  });

  test('desktop app call sites explicitly supply voice; onboarding wrapper supplies its screen', () => {
    const app = source('src/App.tsx');
    const layer = source('src/components/layout/PersistentLayer.tsx');
    const wrapper = source('src/browser-project/AppSimpleBrowserProject.tsx');
    expect(app).toContain('voiceAdapter={nativeComposerVoiceAdapter}');
    expect(layer).toContain('voiceAdapter={nativeComposerVoiceAdapter}');
    expect(wrapper).toContain('renderOnboarding={renderAppOnboarding}');
    expect(runtimeImports(wrapper)).toContain('../components/onboarding/OnboardingOverlay');
  });
});
