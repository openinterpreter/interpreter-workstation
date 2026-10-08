import '@testing-library/jest-dom/vitest';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './msw-server';
import en from '../../shared/locales/en.json';

// Never let tests read or write the developer's real app data or shared OIX
// home. Each Vitest worker gets a process-scoped disposable root.
const testRuntimeRoot = path.join(os.tmpdir(), `interpreter-vitest-${process.pid}`);
process.env.INTERPRETER_USER_DATA_DIR = path.join(testRuntimeRoot, 'app-data');
process.env.INTERPRETER_HOME = path.join(testRuntimeRoot, '.openinterpreter');

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

// Motion reads reduced-motion preferences while modules mount, before the
// suite-level beforeAll hook runs. Install the browser primitive eagerly so
// components using layout projection behave like they do in Electron.
if (isBrowserEnvironment && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  if (!isBrowserEnvironment) {
    return;
  }

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
  rmSync(testRuntimeRoot, { recursive: true, force: true });
});
