import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const SOURCE_PATH = new URL('./InputPanel.tsx', import.meta.url);
const STYLES_PATH = new URL('./styles.css', import.meta.url);

describe('InputPanel layout contract', () => {
  test('renders context chips after the text editor area', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const editorIndex = source.indexOf('data-overlay-editor-area="true"');
    const contextChipIndex = source.indexOf('contextAttachments.map');

    expect(editorIndex).toBeGreaterThan(-1);
    expect(contextChipIndex).toBeGreaterThan(-1);
    expect(contextChipIndex).toBeGreaterThan(editorIndex);
  });

  test('uses soft context highlights instead of disappearing flash animations', () => {
    const inputPanelSource = readFileSync(SOURCE_PATH, 'utf8');
    const stylesSource = readFileSync(STYLES_PATH, 'utf8');

    expect(inputPanelSource).toContain('overlay-input-context-chip-highlight');
    expect(inputPanelSource).not.toContain('overlay-input-context-chip-flash');
    expect(inputPanelSource).not.toContain('opacity: 0;');

    expect(stylesSource).toContain('overlay-context-source-highlight');
    expect(stylesSource).not.toContain('overlay-context-source-flash');
    expect(stylesSource).not.toContain('steps(2');
  });

  test('does not render workspace or model dispatch pickers in the main overlay composer', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');

    expect(source).not.toContain('data-overlay-workspace-trigger');
    expect(source).not.toContain('data-overlay-profile-trigger');
    expect(source).not.toContain('ariaLabel="Choose workspace"');
    expect(source).not.toContain('ariaLabel="Choose profile"');
  });
});
