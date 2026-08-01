'use strict';

let addon = null;
let loadError = null;

try {
  // Built by node-gyp during install / electron-rebuild.
  addon = require('./build/Release/window_pin.node');
} catch (err) {
  loadError = err;
  addon = {
    platform: 'unavailable',
    pinAbove: () => false,
    setWindowLevelNormal: () => false,
    getWindowNumber: () => 0,
  };
}

const wrapper = {
  isAvailable: () => addon && addon.platform !== 'unavailable' && addon.platform !== 'stub',
  loadError: () => loadError,
  platform: addon.platform,
  pinAbove: (handleBuffer, targetCgWindowId) => addon.pinAbove(handleBuffer, targetCgWindowId),
  setWindowLevelNormal: (handleBuffer) => addon.setWindowLevelNormal(handleBuffer),
  getWindowNumber: (handleBuffer) => addon.getWindowNumber(handleBuffer),
};

// describeZOrder is present on both the macOS and Windows native builds; the
// stub falls back to undefined.
if (typeof addon.describeZOrder === 'function') {
  wrapper.describeZOrder = (handleBuffer) => addon.describeZOrder(handleBuffer);
}

// Windows-only enumeration / watcher surface. macOS uses a separate Swift CLI
// for these (see apps/interpreter-overlay/runtime/infra/window-tracker/), so
// we only expose them when the addon platform is win32.
if (addon.platform === 'win32') {
  wrapper.windowAtPoint = (x, y, opts) => addon.windowAtPoint(x, y, opts);
  wrapper.frontmostByPid = (pid) => addon.frontmostByPid(pid);
  wrapper.windowBoundsByHwnd = (hwnd) => addon.windowBoundsByHwnd(hwnd);
  wrapper.postButtonClick = (hwnd) => addon.postButtonClick(hwnd);
  wrapper.postLeftClick = (hwnd, x, y) => addon.postLeftClick(hwnd, x, y);
  wrapper.WindowWatcher = addon.WindowWatcher;
}

module.exports = wrapper;
