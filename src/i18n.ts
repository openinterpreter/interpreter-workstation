/**
 * Renderer i18n
 *
 * Initializes i18next with react-i18next for the renderer process.
 * Starts with 'en' as default; App.tsx overrides via IPC after mount.
 */

import i18next from 'i18next';
import type { TOptions } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources, type LocaleKey } from '../shared/locales';

export type { LocaleKey };

i18next.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function tr(key: LocaleKey, options?: TOptions): string {
  return i18next.t(key, options);
}

export default i18next;
