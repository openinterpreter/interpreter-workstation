import { describe, test, expect } from 'bun:test';
import { getConversionTargets } from './convertibleFormats';

describe('getConversionTargets', () => {
  test('.docx returns pdf, odt, rtf, txt, html, epub, fb2', () => {
    expect(getConversionTargets('report.docx')).toEqual(['pdf', 'odt', 'rtf', 'txt', 'html', 'epub', 'fb2']);
  });

  test('.xlsx returns the formats supported by the community document pipeline', () => {
    expect(getConversionTargets('data.xlsx')).toEqual(['pdf', 'ods', 'csv']);
  });

  test('.pptx returns pdf, odp', () => {
    expect(getConversionTargets('slides.pptx')).toEqual(['pdf', 'odp']);
  });

  test('case insensitive: .DOCX works', () => {
    expect(getConversionTargets('REPORT.DOCX')).toEqual(['pdf', 'odt', 'rtf', 'txt', 'html', 'epub', 'fb2']);
  });

  test('unknown extension returns null', () => {
    expect(getConversionTargets('image.bmp')).toBeNull();
  });

  test('no extension returns null', () => {
    expect(getConversionTargets('README')).toBeNull();
  });
});
