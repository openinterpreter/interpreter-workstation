import i18next from 'i18next';
import type { TOptions } from 'i18next';

import { resources, type LocaleKey } from './index';

const serverI18n = i18next.createInstance();

serverI18n.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  initImmediate: false,
  interpolation: { escapeValue: false },
});

export function trEn(key: LocaleKey, options?: TOptions): string {
  return serverI18n.t(key, options);
}
