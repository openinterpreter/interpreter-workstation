import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('BrowserService Reference Mapping', () => {
  let refMappings: Map<string, Map<string, number>>;

  function setup() {
    refMappings = new Map();
  }

  function setRefMapping(id: string, mapping: Map<string, number>): void {
    refMappings.set(id, mapping);
  }

  function getRefMapping(id: string): Map<string, number> | undefined {
    return refMappings.get(id);
  }

  function clearRefMapping(id: string): void {
    refMappings.delete(id);
  }

  it('should store and retrieve reference mappings', () => {
    setup();
    const tabId = 'tab-1';
    const mapping = new Map<string, number>();
    mapping.set('ref_1', 100);
    mapping.set('ref_2', 200);

    setRefMapping(tabId, mapping);

    const retrieved = getRefMapping(tabId);
    assert.ok(retrieved);
    assert.strictEqual(retrieved?.get('ref_1'), 100);
    assert.strictEqual(retrieved?.get('ref_2'), 200);
  });

  it('should return undefined for non-existent tab', () => {
    setup();
    const result = getRefMapping('non-existent');
    assert.strictEqual(result, undefined);
  });

  it('should clear reference mapping for a tab', () => {
    setup();
    const tabId = 'tab-1';
    const mapping = new Map<string, number>();
    mapping.set('ref_1', 100);

    setRefMapping(tabId, mapping);
    assert.ok(getRefMapping(tabId));

    clearRefMapping(tabId);
    assert.strictEqual(getRefMapping(tabId), undefined);
  });

  it('should handle multiple tabs independently', () => {
    setup();
    const mapping1 = new Map<string, number>([['ref_1', 100]]);
    const mapping2 = new Map<string, number>([['ref_1', 999]]);

    setRefMapping('tab-1', mapping1);
    setRefMapping('tab-2', mapping2);

    assert.strictEqual(getRefMapping('tab-1')?.get('ref_1'), 100);
    assert.strictEqual(getRefMapping('tab-2')?.get('ref_1'), 999);

    clearRefMapping('tab-1');
    assert.strictEqual(getRefMapping('tab-1'), undefined);
    assert.strictEqual(getRefMapping('tab-2')?.get('ref_1'), 999);
  });
});

describe('Input Type Detection Logic', () => {
  function detectInputType(tagName: string, inputType: string): string {
    const tag = tagName.toLowerCase();
    const type = inputType?.toLowerCase() || '';

    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' && type === 'radio') return 'radio';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input' && ['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(type)) {
      return 'text-input';
    }
    return 'unknown';
  }

  it('should detect checkbox inputs', () => {
    assert.strictEqual(detectInputType('input', 'checkbox'), 'checkbox');
    assert.strictEqual(detectInputType('INPUT', 'CHECKBOX'), 'checkbox');
  });

  it('should detect radio inputs', () => {
    assert.strictEqual(detectInputType('input', 'radio'), 'radio');
  });

  it('should detect select elements', () => {
    assert.strictEqual(detectInputType('select', ''), 'select');
  });

  it('should detect textarea elements', () => {
    assert.strictEqual(detectInputType('textarea', ''), 'textarea');
  });

  it('should detect various text input types', () => {
    assert.strictEqual(detectInputType('input', 'text'), 'text-input');
    assert.strictEqual(detectInputType('input', 'email'), 'text-input');
    assert.strictEqual(detectInputType('input', 'password'), 'text-input');
    assert.strictEqual(detectInputType('input', 'search'), 'text-input');
    assert.strictEqual(detectInputType('input', 'number'), 'text-input');
  });

  it('should return unknown for unsupported types', () => {
    assert.strictEqual(detectInputType('div', ''), 'unknown');
    assert.strictEqual(detectInputType('input', 'file'), 'unknown');
    assert.strictEqual(detectInputType('button', ''), 'unknown');
  });
});

describe('Error Handling for Invalid References', () => {
  function validateRefId(
    refMappings: Map<string, Map<string, number>>,
    tabId: string,
    refId: string
  ): { error?: string; backendNodeId?: number } {
    const refMapping = refMappings.get(tabId);

    if (!refMapping) {
      return { error: `No page structure found for tab ${tabId}. Call browser_read_page first.` };
    }

    const backendNodeId = refMapping.get(refId);
    if (!backendNodeId) {
      return { error: `Reference ID "${refId}" not found. Call browser_read_page to get valid references.` };
    }

    return { backendNodeId };
  }

  it('should error when no page structure exists', () => {
    const mappings = new Map<string, Map<string, number>>();
    const result = validateRefId(mappings, 'tab-1', 'ref_1');

    assert.ok(result.error?.includes('No page structure found'));
    assert.ok(result.error?.includes('browser_read_page'));
  });

  it('should error when reference ID does not exist', () => {
    const mappings = new Map<string, Map<string, number>>();
    mappings.set('tab-1', new Map([['ref_1', 100]]));

    const result = validateRefId(mappings, 'tab-1', 'ref_999');

    assert.ok(result.error?.includes('Reference ID "ref_999" not found'));
    assert.ok(result.error?.includes('browser_read_page'));
  });

  it('should return backendNodeId when reference is valid', () => {
    const mappings = new Map<string, Map<string, number>>();
    mappings.set('tab-1', new Map([['ref_1', 100]]));

    const result = validateRefId(mappings, 'tab-1', 'ref_1');

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.backendNodeId, 100);
  });
});
