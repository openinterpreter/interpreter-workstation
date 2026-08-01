import { describe, test, expect } from 'bun:test';
import { buildX2tPaths, getX2tBinaryName } from './x2tPaths';

describe('getX2tBinaryName', () => {
  test('uses .exe suffix on Windows', () => {
    expect(getX2tBinaryName('win32')).toBe('x2t.exe');
  });

  test('uses no suffix on non-Windows platforms', () => {
    expect(getX2tBinaryName('darwin')).toBe('x2t');
    expect(getX2tBinaryName('linux')).toBe('x2t');
  });
});

describe('buildX2tPaths', () => {
  test('builds Windows converter binary path with .exe', () => {
    const paths = buildX2tPaths('C:\\Users\\tester\\AppData\\Roaming\\interpreter', 'win32');
    expect(paths.x2tBinary.replace(/\\/g, '/').endsWith('/oo-editors/converter/x2t.exe')).toBeTrue();
    expect(paths.systemFontsDir).toBe('C:\\Windows\\Fonts');
  });

  test('builds non-Windows converter binary path without extension', () => {
    const paths = buildX2tPaths('/Users/tester/Library/Application Support/interpreter', 'darwin');
    expect(paths.x2tBinary.replace(/\\/g, '/').endsWith('/oo-editors/converter/x2t')).toBeTrue();
    expect(paths.systemFontsDir).toBe('/System/Library/Fonts');
  });

  test('prefers dedicated desktop font metadata when present', () => {
    const userDataPath = '/Users/tester/Library/Application Support/interpreter';
    const paths = buildX2tPaths(userDataPath, 'darwin', (candidate) =>
      candidate === `${userDataPath}/office-extension-fontdata/AllFonts.js`
    );

    expect(paths.allFontsPath).toBe(`${userDataPath}/office-extension-fontdata/AllFonts.js`);
  });

  test('falls back to bundled sdkjs AllFonts.js when dedicated font metadata is missing', () => {
    const userDataPath = '/Users/tester/Library/Application Support/interpreter';
    const bundledAllFonts = `${userDataPath}/oo-editors/editors/sdkjs/common/AllFonts.js`;
    const paths = buildX2tPaths(userDataPath, 'darwin', (candidate) => candidate === bundledAllFonts);

    expect(paths.allFontsPath).toBe(bundledAllFonts);
  });
});
