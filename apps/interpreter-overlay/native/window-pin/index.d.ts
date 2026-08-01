declare const _default: {
  isAvailable: () => boolean;
  loadError: () => Error | null;
  platform: string;
  pinAbove: (handleBuffer: Buffer, targetCgWindowId: number) => boolean;
  setWindowLevelNormal: (handleBuffer: Buffer) => boolean;
  getWindowNumber: (handleBuffer: Buffer) => number;
  postButtonClick?: (hwnd: number) => boolean;
  postLeftClick?: (hwnd: number, x: number, y: number) => boolean;
};
export = _default;
