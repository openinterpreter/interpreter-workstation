import { describe, expect, test } from 'bun:test';
import {
  filterSelectedFilesByCallerScopeForTest,
  formatCurrentSelectionSnapshotAsJsonForTest,
  formatCurrentSelectionSnapshotForTest,
  selectionServerDefinition,
} from './index';
import { SELECTION_SOURCE_KINDS } from '../../../../shared/types/selectionSource';

describe('selection tool contract', () => {
  test('exposes one read-only current-selection tool', () => {
    expect(selectionServerDefinition.id).toBe('builtin-selection');
    expect(selectionServerDefinition.tools.map((tool) => ({
      name: tool.name,
      mode: tool.mode,
      readOnlyHint: tool.annotations?.readOnlyHint,
      required: tool.inputSchema.required,
      properties: Object.keys(tool.inputSchema.properties ?? {}),
    }))).toEqual([{
      name: 'read_current_selection',
      mode: 'read',
      readOnlyHint: true,
      required: undefined,
      properties: ['format'],
    }]);
  });

  test('defines the planned selection source taxonomy', () => {
    expect(SELECTION_SOURCE_KINDS).toEqual([
      'app-ui-selection',
      'os-selected-text',
      'os-selected-children',
      'os-focused-element',
      'os-selection-unknown',
      'os-selected-file',
      'overlay-region',
      'browser-selection',
      'office-selection',
    ]);
  });
});

describe('selection tool output formatting', () => {
  test('formats selected text with observed source metadata', () => {
    const formatted = formatCurrentSelectionSnapshotForTest({
      text: {
        text: 'Need the selected paragraph.',
        sourceKind: 'os-selected-text',
        sourceAppName: 'TextEdit',
        sourceAppBundleIdentifier: 'com.apple.TextEdit',
        sourceAppPid: 4242,
        bounds: { x: 10, y: 20, width: 300, height: 40 },
      },
      files: [],
      deniedFiles: [],
    });

    expect(formatted).toContain('<selected_text>');
    expect(formatted).toContain('source_kind=os-selected-text');
    expect(formatted).toContain('source_app="TextEdit"');
    expect(formatted).toContain('source_bundle="com.apple.TextEdit"');
    expect(formatted).toContain('source_pid=4242');
    expect(formatted).toContain('bounds={x=10, y=20, width=300, height=40}');
    expect(formatted).toContain('Need the selected paragraph.');
    expect(formatted).toContain('No selected files visible to this caller.');
  });

  test('formats permitted and denied selected file refs without leaking denied paths', () => {
    const formatted = formatCurrentSelectionSnapshotForTest({
      text: null,
      files: [{
        path: '/Users/example/Projects/interpreter-workstation/README.md',
        name: 'README.md',
        sourceKind: 'os-selected-file',
        bounds: { x: 50, y: 60, width: 100, height: 30 },
      }],
      deniedFiles: [{
        name: 'private.txt',
        reason: 'read permission denied by agent file scope',
      }],
    });

    expect(formatted).toContain('selected_text=null');
    expect(formatted).toContain('file source_kind=os-selected-file name="README.md" path="/Users/example/Projects/interpreter-workstation/README.md" bounds={x=50, y=60, width=100, height=30}');
    expect(formatted).toContain('<denied_selected_files>');
    expect(formatted).toContain('file name="private.txt" reason="read permission denied by agent file scope"');
    expect(formatted).not.toContain('/private.txt');
  });

  test('formats an empty selection explicitly', () => {
    const formatted = formatCurrentSelectionSnapshotForTest({
      text: null,
      files: [],
      deniedFiles: [],
    });

    expect(formatted).toBe([
      'Current selection',
      'selected_text=null',
      '<selected_files>',
      'No selected files visible to this caller.',
      '</selected_files>',
    ].join('\n'));
  });

  test('formats structured json without denied file paths', () => {
    const formatted = formatCurrentSelectionSnapshotAsJsonForTest({
      text: {
        text: 'Selected text',
        sourceKind: 'os-focused-element',
        sourceAppName: 'Notes',
        sourceAppBundleIdentifier: 'com.apple.Notes',
        sourceAppPid: 123,
        bounds: null,
      },
      files: [{
        path: '/workspace/allowed.pdf',
        name: 'allowed.pdf',
        sourceKind: 'os-selected-file',
        bounds: null,
      }],
      deniedFiles: [{
        name: 'secret.pdf',
        reason: 'read permission denied by agent file scope',
      }],
    });
    const parsed = JSON.parse(formatted);

    expect(parsed.text.sourceKind).toBe('os-focused-element');
    expect(parsed.files).toEqual([{
      path: '/workspace/allowed.pdf',
      name: 'allowed.pdf',
      sourceKind: 'os-selected-file',
      bounds: null,
    }]);
    expect(parsed.deniedFiles).toEqual([{
      name: 'secret.pdf',
      reason: 'read permission denied by agent file scope',
    }]);
    expect(formatted).not.toContain('/private/secret.pdf');
  });
});

describe('selection file permission filtering', () => {
  const selectedFiles = [
    {
      path: '/workspace/allowed.txt',
      name: 'allowed.txt',
      sourceKind: 'os-selected-file' as const,
      bounds: null,
    },
    {
      path: '/private/denied.txt',
      name: 'denied.txt',
      sourceKind: 'os-selected-file' as const,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    },
  ];

  test('denies all selected file paths when caller identity is missing', () => {
    const result = filterSelectedFilesByCallerScopeForTest(
      selectedFiles,
      { workspace: '/workspace' },
      () => true,
    );

    expect(result.files).toEqual([]);
    expect(result.deniedFiles).toEqual([
      { name: 'allowed.txt', reason: 'caller identity is required before returning selected file paths' },
      { name: 'denied.txt', reason: 'caller identity is required before returning selected file paths' },
    ]);
  });

  test('returns only selected file paths allowed by the caller file scope', () => {
    const checks: Array<{ requesterId: string; filePath: string; workspace: string | null }> = [];
    const result = filterSelectedFilesByCallerScopeForTest(
      selectedFiles,
      { agentId: 'agent-1', workspace: '/workspace' },
      (requesterId, filePath, mode, workspace) => {
        expect(mode).toBe('read');
        checks.push({ requesterId, filePath, workspace });
        return filePath.startsWith('/workspace/');
      },
    );

    expect(checks).toEqual([
      { requesterId: 'agent-1', filePath: '/workspace/allowed.txt', workspace: '/workspace' },
      { requesterId: 'agent-1', filePath: '/private/denied.txt', workspace: '/workspace' },
    ]);
    expect(result.files).toEqual([selectedFiles[0]]);
    expect(result.deniedFiles).toEqual([
      { name: 'denied.txt', reason: 'read permission denied by agent file scope' },
    ]);
  });
});
