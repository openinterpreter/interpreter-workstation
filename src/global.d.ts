/**
 * Global type declarations
 */

import type { ElectronAPI } from '../electron/preload';
import 'react';

declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
