import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'OverlaySection.tsx'), 'utf8');

describe('Overlay settings contract', () => {
  test('exposes typed overlay model as its own persisted setting', () => {
    expect(source).toContain('Typed overlay model');
    expect(source).toContain('preferredProfileId: value === OVERLAY_TEXT_DEFAULT_PROFILE_VALUE ? null : value');
    expect(source).toContain("settingKey: 'overlay.preferredProfileId'");
  });
});
