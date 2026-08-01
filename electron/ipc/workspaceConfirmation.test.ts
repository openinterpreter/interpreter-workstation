import { describe, expect, test } from 'bun:test';

import { resolveSpecialFolderAlias } from './workspacePathAliases';

describe('resolveSpecialFolderAlias', () => {
  test('maps English special folder aliases', () => {
    expect(resolveSpecialFolderAlias('desktop')).toBe('desktop');
    expect(resolveSpecialFolderAlias('DOCUMENTS')).toBe('documents');
    expect(resolveSpecialFolderAlias('  downloads  ')).toBe('downloads');
  });

  test('maps Spanish special folder aliases', () => {
    expect(resolveSpecialFolderAlias('escritorio')).toBe('desktop');
    expect(resolveSpecialFolderAlias('documentos')).toBe('documents');
    expect(resolveSpecialFolderAlias('descargas')).toBe('downloads');
  });

  test('does not treat normal paths as special aliases', () => {
    expect(resolveSpecialFolderAlias('C:\\Users\\alice\\Desktop')).toBeNull();
    expect(resolveSpecialFolderAlias('/Users/alice/Desktop')).toBeNull();
    expect(resolveSpecialFolderAlias('Desktop/Interpreter')).toBeNull();
  });
});
