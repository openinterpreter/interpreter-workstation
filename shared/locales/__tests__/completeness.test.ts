import { readFileSync } from 'node:fs';
import { describe, test, expect } from 'bun:test';
import { resources, supportedLanguages } from '../index';

const enKeys = Object.keys(resources.en.translation).sort();
const localeFileUrl = (lang: string) => new URL(`../${lang}.json`, import.meta.url);
const criticalLocalizedKeys = [
  'errors.turn.insufficientTokens',
  'settings.plan.billingLoadError',
  'settings.plan.checkoutError',
  'settings.plan.portalError',
  'tokenUsage.warningRemaining',
  'threadError.interpreterCreditsExhausted.title',
  'threadError.interpreterCreditsExhausted.freeMessage',
  'threadError.interpreterCreditsExhausted.paidMessage',
  'threadError.interpreterCreditsExhausted.paidMessageWithRefresh',
  'threadError.interpreterCreditsExhausted.unknownMessage',
  'threadError.interpreterCreditsExhausted.suggestion',
] as const;

function findDuplicateKeys(lang: string): string[] {
  const raw = readFileSync(localeFileUrl(lang), 'utf8');
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const keyPattern = /^  "([^"]+)":/gm;
  let match: RegExpExecArray | null;

  while ((match = keyPattern.exec(raw)) !== null) {
    const key = match[1]!;
    if (seen.has(key)) {
      duplicates.push(key);
    } else {
      seen.add(key);
    }
  }

  return duplicates;
}

function findPlaceholderTranslations(lang: string): string[] {
  const raw = readFileSync(localeFileUrl(lang), 'utf8');
  return Array.from(raw.matchAll(/^  "([^"]+)": "\[[A-Z-]+\]/gm), (match) => match[1]!);
}

describe('locale completeness', () => {
  test('en.json has keys', () => {
    expect(enKeys.length).toBeGreaterThan(0);
  });

  for (const lang of supportedLanguages) {
    test(`${lang}.json has no duplicate keys`, () => {
      expect(findDuplicateKeys(lang)).toEqual([]);
    });

    test(`${lang}.json has no placeholder translations`, () => {
      expect(findPlaceholderTranslations(lang)).toEqual([]);
    });

    if (lang === 'en') continue;

    test(`${lang}.json contains every en.json key`, () => {
      const localeKeys = new Set(Object.keys(resources[lang].translation));
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing).toEqual([]);
    });

    test(`${lang}.json has no extra keys beyond en.json`, () => {
      const enKeySet = new Set(enKeys);
      const localeKeys = Object.keys(resources[lang].translation).sort();
      const extra = localeKeys.filter((k) => !enKeySet.has(k));
      expect(extra).toEqual([]);
    });

    test(`${lang}.json localizes token and billing messages`, () => {
      for (const key of criticalLocalizedKeys) {
        expect(resources[lang].translation[key]).not.toBe(resources.en.translation[key]);
      }
    });
  }
});
