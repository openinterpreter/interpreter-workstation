import { describe, test, expect } from 'bun:test';
import { detectInternalPromptArtifacts, rejectIfInternalContext } from '../../../utils/contentGuard';
import { createDocxTool } from './createDocxTool';

describe('detectInternalPromptArtifacts', () => {
  test('detects hidden runtime scaffolding markers', () => {
    const leakedContent = [
      '# AGENTS.md instructions for C:\\Users\\Example\\Workspace',
      '<INSTRUCTIONS>',
      '### Available skills',
      '<workstation-context>',
      'Workspace: C:\\Users\\Example\\Workspace',
      '</workstation-context>',
    ].join('\n');

    const markers = detectInternalPromptArtifacts(leakedContent);

    expect(markers).toContain('agents-instructions-header');
    expect(markers).toContain('internal-instructions-block');
    expect(markers).toContain('skills-available-section');
    expect(markers).toContain('workstation-context-tag');
  });

  test('detects marker variants case-insensitively', () => {
    const leakedContent = [
      '# agents.md instructions for /tmp/workspace',
      '### how to use skills',
    ].join('\n');

    const markers = detectInternalPromptArtifacts(leakedContent);

    expect(markers).toContain('agents-instructions-header');
    expect(markers).toContain('skills-usage-section');
  });

  test('does not flag normal user-authored document content', () => {
    const normalContent = [
      '<h1>Meeting Notes</h1>',
      '<p>Action items for Friday release.</p>',
      '<p>Owner: Platform team.</p>',
    ].join('\n');

    expect(detectInternalPromptArtifacts(normalContent)).toEqual([]);
  });
});

describe('rejectIfInternalContext', () => {
  test('returns error response when internal context is detected', () => {
    const result = rejectIfInternalContext('<workstation-context>Workspace: /tmp</workstation-context>');

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain('internal runtime instructions');
  });

  test('returns null for safe content', () => {
    expect(rejectIfInternalContext('<p>Hello world</p>')).toBeNull();
  });
});

describe('createDocxTool schema', () => {
  test('exposes overwrite for in-place revisions', () => {
    expect(createDocxTool.inputSchema.properties).toHaveProperty('overwrite');
    expect(createDocxTool.description).toContain('overwrite=true');
  });

  test('keeps overwrite optional', () => {
    const required = createDocxTool.inputSchema.required ?? [];
    expect(required).not.toContain('overwrite');
  });
});
