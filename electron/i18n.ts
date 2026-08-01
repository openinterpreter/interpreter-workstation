/**
 * Main Process i18n
 *
 * Initializes i18next for the Electron main process (menus, dialogs, context menus).
 * The renderer has its own separate initialization in src/i18n.ts.
 */

import i18next from 'i18next';
import { app } from 'electron';
import { resources, supportedLanguages, type SupportedLanguage } from '../shared/locales';

let initialized = false;

/**
 * Resolve the best locale from OS preferences and config override.
 * Config override takes precedence over OS detection.
 */
export function resolveLocale(configLocale?: string | null): SupportedLanguage {
  if (configLocale && (supportedLanguages as readonly string[]).includes(configLocale)) {
    return configLocale as SupportedLanguage;
  }

  // app.getPreferredSystemLanguages() returns e.g. ['zh-Hans-CN', 'en-US']
  const osLangs = app.getPreferredSystemLanguages();
  for (const lang of osLangs) {
    const normalized = lang.replace('_', '-');

    // Exact match
    if ((supportedLanguages as readonly string[]).includes(normalized)) {
      return normalized as SupportedLanguage;
    }

    // Map zh-Hans variants to zh-CN
    if (normalized.startsWith('zh-Hans')) return 'zh-CN';

    // Base language match (e.g. 'ja' from 'ja-JP')
    const base = normalized.split('-')[0];
    if ((supportedLanguages as readonly string[]).includes(base)) {
      return base as SupportedLanguage;
    }
  }

  return 'en';
}

/**
 * Initialize i18next for the main process.
 * Call after app.whenReady() and config load.
 */
export async function initI18nMain(configLocale?: string | null): Promise<void> {
  if (initialized) return;

  const lng = resolveLocale(configLocale);

  await i18next.init({
    lng,
    resources,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

  initialized = true;
}

/**
 * Translate a key. Use in menu.ts and other main process code.
 */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

/**
 * Change language at runtime (when user changes setting).
 */
export async function changeLanguage(lng: SupportedLanguage): Promise<void> {
  await i18next.changeLanguage(lng);
}

/**
 * Get the current language code.
 */
export function getCurrentLanguage(): string {
  return i18next.language ?? 'en';
}
