import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './msw-server';
import en from '../../shared/locales/en.json';

function translate(key: string, options?: Record<string, unknown>): string {
  const template = en[key as keyof typeof en];
  if (typeof template !== 'string') {
    return options?.defaultValue as string ?? key;
  }

  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = options?.[name];
    return value == null ? '' : String(value);
  });
}

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
  Trans: ({ children }: { children: unknown }) => children,
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translate(key, options),
    i18n: {
      changeLanguage: async () => undefined,
      language: 'en',
    },
  }),
}));

// Server-side tests run in the node environment (see environmentMatchGlobs in
// vitest.config.ts); the jsdom-only globals below are skipped there.
const isBrowserEnvironment = typeof window !== 'undefined';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  if (!isBrowserEnvironment) {
    return;
  }

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  Object.defineProperty(window, 'scrollTo', {
    writable: true,
    value: vi.fn(),
  });

  Object.defineProperty(window, 'requestAnimationFrame', {
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  });

  Object.defineProperty(window, 'cancelAnimationFrame', {
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });

  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });

  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    value: class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  });

  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  if (isBrowserEnvironment) {
    localStorage.clear();
  }
});

afterAll(() => {
  server.close();
});
