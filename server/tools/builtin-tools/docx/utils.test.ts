import { describe, test, expect } from 'bun:test';
import { generateParagraphId, decodeXmlEntities, extractMarkedParagraphs, removeMarkersFromText } from './utils';

describe('generateParagraphId', () => {
  test('deterministic for same input', () => {
    const a = generateParagraphId('hello', 0);
    const b = generateParagraphId('hello', 0);
    expect(a).toBe(b);
  });

  test('different for different content', () => {
    const a = generateParagraphId('hello', 0);
    const b = generateParagraphId('world', 0);
    expect(a).not.toBe(b);
  });

  test('different for different index', () => {
    const a = generateParagraphId('hello', 0);
    const b = generateParagraphId('hello', 1);
    expect(a).not.toBe(b);
  });

  test('returns 16-char hex string', () => {
    const id = generateParagraphId('test', 5);
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('decodeXmlEntities', () => {
  test('decodes &amp;', () => {
    expect(decodeXmlEntities('&amp;')).toBe('&');
  });

  test('decodes &lt;', () => {
    expect(decodeXmlEntities('&lt;')).toBe('<');
  });

  test('decodes &gt;', () => {
    expect(decodeXmlEntities('&gt;')).toBe('>');
  });

  test('decodes &quot;', () => {
    expect(decodeXmlEntities('&quot;')).toBe('"');
  });

  test('decodes &apos;', () => {
    expect(decodeXmlEntities('&apos;')).toBe("'");
  });

  test('decodes &nbsp;', () => {
    expect(decodeXmlEntities('&nbsp;')).toBe(' ');
  });

  test('handles multiple entities in one string', () => {
    expect(decodeXmlEntities('&lt;div class=&quot;test&quot;&gt;A &amp; B&lt;/div&gt;'))
      .toBe('<div class="test">A & B</div>');
  });
});

describe('extractMarkedParagraphs', () => {
  test('extracts text between markers', () => {
    const id1 = generateParagraphId('First paragraph', 0);
    const id2 = generateParagraphId('Second paragraph', 1);
    const text = `[DOCX-MARKER:${id1}]First paragraph\n[DOCX-MARKER:${id2}]Second paragraph`;

    const result = extractMarkedParagraphs(text);

    expect(result[id1].text).toBe('First paragraph');
    expect(result[id2].text).toBe('Second paragraph');
  });

  test('handles consecutive markers', () => {
    const id1 = generateParagraphId('A', 0);
    const id2 = generateParagraphId('B', 1);
    const text = `[DOCX-MARKER:${id1}]A\n[DOCX-MARKER:${id2}]B`;

    const result = extractMarkedParagraphs(text);

    expect(result[id1].text).toBe('A');
    expect(result[id2].text).toBe('B');
  });

  test('handles last marker to end of document', () => {
    const id = generateParagraphId('Final text', 0);
    const text = `[DOCX-MARKER:${id}]Final text and more content here.`;

    const result = extractMarkedParagraphs(text);

    expect(result[id].text).toBe('Final text and more content here.');
  });
});

describe('removeMarkersFromText', () => {
  test('strips all markers', () => {
    const id1 = generateParagraphId('a', 0);
    const id2 = generateParagraphId('b', 1);
    const text = `[DOCX-MARKER:${id1}]Hello [DOCX-MARKER:${id2}]World`;

    expect(removeMarkersFromText(text)).toBe('Hello World');
  });

  test('preserves text without markers', () => {
    expect(removeMarkersFromText('No markers here')).toBe('No markers here');
  });
});
