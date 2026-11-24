import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appRoot = new URL('../../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, appRoot), 'utf8');
const runtimeImports = (text: string) => [...text.matchAll(/^import\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)]
  .map(match => match[1]);

describe('browser embedding boundary', () => {
  test('generic composer and browser entry points do not import native voice or app onboarding', () => {
    const composer = source('agent/components/ComposerArea.tsx');
    const shell = source('src/components/simple/SimpleShell.tsx');
    const browser = source('src/browser-project/SimpleBrowserProject.tsx');
    const banned = /voiceCapture|qwenVoiceStreamBridge|moonshine|voiceLatency|nativeComposerVoiceAdapter|OnboardingOverlay/;
    for (const text of [composer, shell, browser]) {
      expect(runtimeImports(text).filter(specifier => banned.test(specifier))).toEqual([]);
    }
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
