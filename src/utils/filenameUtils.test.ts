import { describe, test, expect } from 'bun:test';
import { getSelectionRangeWithoutExtension, generateDuplicateName } from './filenameUtils';

describe('getSelectionRangeWithoutExtension', () => {
  test('file with single extension', () => {
    expect(getSelectionRangeWithoutExtension('poem.txt')).toEqual({ start: 0, end: 4 });
  });

  test('file with short extension', () => {
    expect(getSelectionRangeWithoutExtension('readme.md')).toEqual({ start: 0, end: 6 });
  });

  test('file with compound extension', () => {
    expect(getSelectionRangeWithoutExtension('archive.tar.gz')).toEqual({ start: 0, end: 11 });
  });

  test('dotfile', () => {
    expect(getSelectionRangeWithoutExtension('.gitignore')).toEqual({ start: 0, end: 10 });
  });

  test('no extension', () => {
    expect(getSelectionRangeWithoutExtension('Makefile')).toEqual({ start: 0, end: 8 });
  });

  test('empty string', () => {
    expect(getSelectionRangeWithoutExtension('')).toEqual({ start: 0, end: 0 });
  });

  test('file with many dots', () => {
    expect(getSelectionRangeWithoutExtension('my.cool.file.txt')).toEqual({ start: 0, end: 12 });
  });

  test('just a dot', () => {
    expect(getSelectionRangeWithoutExtension('.')).toEqual({ start: 0, end: 1 });
  });
});

describe('generateDuplicateName', () => {
  test('first copy', () => {
    expect(generateDuplicateName('readme', '.md', [])).toBe('readme copy.md');
  });

  test('second copy', () => {
    expect(generateDuplicateName('readme', '.md', ['readme copy.md'])).toBe('readme copy 2.md');
  });

  test('third copy', () => {
    expect(generateDuplicateName('readme', '.md', ['readme copy.md', 'readme copy 2.md'])).toBe('readme copy 3.md');
  });

  test('gap in copies', () => {
    expect(generateDuplicateName('readme', '.md', ['readme copy.md', 'readme copy 3.md'])).toBe('readme copy 2.md');
  });

  test('no extension', () => {
    expect(generateDuplicateName('Makefile', '', [])).toBe('Makefile copy');
  });

  test('no extension second copy', () => {
    expect(generateDuplicateName('Makefile', '', ['Makefile copy'])).toBe('Makefile copy 2');
  });

  test('image file', () => {
    expect(generateDuplicateName('photo', '.jpg', [])).toBe('photo copy.jpg');
  });
});
