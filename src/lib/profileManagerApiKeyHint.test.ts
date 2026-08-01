import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resources, supportedLanguages } from '../../shared/locales';

describe('Settings API key location hint wiring', () => {
  test('ProfileManager references the apiKeyLocationHint translation key', () => {
    const profileManagerPath = join(process.cwd(), 'src', 'components', 'ProfileManager.tsx');
    const source = readFileSync(profileManagerPath, 'utf-8');

    expect(source.includes("t('settings.models.apiKeyLocationHint')")).toBe(true);
  });

  test('all locales define settings.models.apiKeyLocationHint', () => {
    for (const lang of supportedLanguages) {
      const value = resources[lang].translation['settings.models.apiKeyLocationHint'];
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });
});
