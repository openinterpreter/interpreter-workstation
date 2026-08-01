/**
 * Unit tests for the composer attachment primitive: store, serializer, and
 * paste-classification helpers.
 */

import { describe, expect, test } from 'bun:test';
import { createAttachmentStore } from './attachmentStore';
import { serializeEditorWithAttachments } from './serialize';
import {
  buildPastedTextLabel,
  countLines,
  shouldChipifyPastedText,
} from './composerPaste';

describe('attachmentStore', () => {
  test('mints unique ids and stores records by kind', () => {
    const store = createAttachmentStore();
    const a = store.add('pasted-text', {
      label: 'hello',
      text: 'hello world',
      size: 11,
    });
    const b = store.add('pasted-image', {
      label: 'img.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,abc',
      size: 42,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.kind).toBe('pasted-text');
    expect(b.kind).toBe('pasted-image');
    expect(store.get(a.id)?.text).toBe('hello world');
    expect(store.get(b.id)?.dataUrl).toBe('data:image/png;base64,abc');
    expect(store.snapshot()).toHaveLength(2);
  });

  test('remove and clear drop records', () => {
    const store = createAttachmentStore();
    const a = store.add('pasted-text', { label: 'a', text: 'aa' });
    store.add('pasted-text', { label: 'b', text: 'bb' });
    store.remove(a.id);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.snapshot()).toHaveLength(1);
    store.clear();
    expect(store.snapshot()).toHaveLength(0);
  });
});

describe('shouldChipifyPastedText', () => {
  test('inlines short single-line text', () => {
    expect(shouldChipifyPastedText('hello world')).toBe(false);
    expect(shouldChipifyPastedText('a'.repeat(100))).toBe(false);
  });

  test('chipifies text that contains a newline', () => {
    expect(shouldChipifyPastedText('line 1\nline 2')).toBe(true);
  });

  test('chipifies text longer than the inline max', () => {
    expect(shouldChipifyPastedText('a'.repeat(500))).toBe(true);
  });
});

describe('countLines + buildPastedTextLabel', () => {
  test('counts lines correctly', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('hello')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\nc\n')).toBe(4);
  });

  test('builds multi-line vs single-line labels', () => {
    expect(buildPastedTextLabel('a\nb\nc')).toBe('Pasted (3 lines)');
    expect(buildPastedTextLabel('hello')).toBe('Pasted (5 chars)');
  });
});

describe('serializeEditorWithAttachments', () => {
  test('walks text-only doc', () => {
    const store = createAttachmentStore();
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hi there' }],
        },
      ],
    };
    const result = serializeEditorWithAttachments(doc, store);
    expect(result.text).toBe('hi there');
    expect(result.attachments).toHaveLength(0);
  });

  test('preserves file mentions in serialized text', () => {
    const store = createAttachmentStore();
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'check ' },
            {
              type: 'fileMention',
              attrs: {
                id: '/tmp/example.png',
                label: 'example.png',
                itemType: 'file',
              },
            },
          ],
        },
      ],
    };

    const result = serializeEditorWithAttachments(doc, store);
    expect(result.text).toBe('check [example.png](</tmp/example.png>)');
    expect(result.attachments).toHaveLength(0);
  });

  test('inlines pasted-text attachment body wrapped in pasted-content tags', () => {
    const store = createAttachmentStore();
    const record = store.add('pasted-text', {
      label: 'Pasted (3 lines)',
      text: 'line 1\nline 2\nline 3',
    });
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see this: ' },
            {
              type: 'attachmentChip',
              attrs: {
                id: record.id,
                kind: 'pasted-text',
                label: record.label,
              },
            },
            { type: 'text', text: ' thanks' },
          ],
        },
      ],
    };
    const result = serializeEditorWithAttachments(doc, store);
    expect(result.text).toContain('see this:');
    expect(result.text).toContain('<pasted-content');
    expect(result.text).toContain('line 1\nline 2\nline 3');
    expect(result.text).toContain('</pasted-content>');
    expect(result.text).toContain('thanks');
    expect(result.attachments).toHaveLength(0);
  });

  test('pushes overlay image attachments into attachments array with placeholder text', () => {
    const store = createAttachmentStore();
    const record = store.add('pasted-image', {
      label: 'shot.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA',
      size: 4,
    });
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'look: ' },
            {
              type: 'attachmentChip',
              attrs: {
                id: record.id,
                kind: 'pasted-image',
                label: record.label,
                mimeType: 'image/png',
              },
            },
          ],
        },
      ],
    };
    const result = serializeEditorWithAttachments(doc, store);
    expect(result.text).toBe('look: [image: shot.png]');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      id: record.id,
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA',
    });
  });

  test('falls back to placeholder when chip ref is missing from store', () => {
    const store = createAttachmentStore();
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'attachmentChip',
              attrs: { id: 'nonexistent', kind: 'pasted-text', label: 'X' },
            },
          ],
        },
      ],
    };
    const result = serializeEditorWithAttachments(doc, store);
    expect(result.text).toContain('[attachment: X]');
    expect(result.attachments).toHaveLength(0);
  });

  test('hard breaks render as newlines', () => {
    const store = createAttachmentStore();
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'hardBreak' },
            { type: 'text', text: 'line 2' },
          ],
        },
      ],
    };
    const result = serializeEditorWithAttachments(doc, store);
    expect(result.text).toBe('line 1\nline 2');
  });
});
