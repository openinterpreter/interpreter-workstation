import en from './en.json';
import zhCN from './zh-CN.json';
import ja from './ja.json';
import es from './es.json';
import ko from './ko.json';
import it from './it.json';
import ru from './ru.json';

export const resources = {
  en: { translation: en },
  'zh-CN': { translation: zhCN },
  ja: { translation: ja },
  es: { translation: es },
  ko: { translation: ko },
  it: { translation: it },
  ru: { translation: ru },
} as const;

export type LocaleKey = keyof typeof resources.en.translation;
export const supportedLanguages = ['en', 'zh-CN', 'ja', 'es', 'ko', 'it', 'ru'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const languageNames: Record<SupportedLanguage, string> = {
  'en': 'English',
  'zh-CN': '中文 (简体)',
  'ja': '日本語',
  'es': 'Español',
  'ko': '한국어',
  'it': 'Italiano',
  'ru': 'Русский',
};
