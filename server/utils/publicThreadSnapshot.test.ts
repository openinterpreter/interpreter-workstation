import { describe, expect, test } from 'bun:test';
import type { v2 } from '../handlers/codex-generated-types';
import {
  buildPublicThreadSnapshot,
  matchesPublicThreadToken,
  sanitizePublicThreadText,
} from './publicThreadSnapshot';

describe('public thread snapshots', () => {
  test('compares relay tokens without exposing them', () => {
    expect(matchesPublicThreadToken('correct', 'correct')).toBe(true);
    expect(matchesPublicThreadToken('wrong', 'correct')).toBe(false);
    expect(matchesPublicThreadToken(undefined, 'correct')).toBe(false);
  });

  test('redacts common credentials from displayable text', () => {
    expect(sanitizePublicThreadText('Authorization: Bearer secret-value')).toBe('[redacted]');
    expect(sanitizePublicThreadText('api_key=sk_examplelongsecret')).toBe('[redacted]');
  });

  test('removes private filesystem paths while preserving public links', () => {
    const sanitized = sanitizePublicThreadText([
      '[Translation](/workspace/projects/science/translation.md)',
      'Saved another copy at /Users/example/private/result.md.',
      'Windows copy: C:\\Users\\example\\result.md',
      '[Open paper](https://example.org/paper)',
    ].join('\n'));

    expect(sanitized).toContain('Translation (saved in the workspace)');
    expect(sanitized).toContain('Saved another copy at [private path omitted]');
    expect(sanitized).toContain('Windows copy: [private path omitted]');
    expect(sanitized).toContain('[Open paper](https://example.org/paper)');
    expect(sanitized).not.toContain('/workspace/');
    expect(sanitized).not.toContain('/Users/');
    expect(sanitized).not.toContain('C:\\Users\\');
  });

  test('replaces internal citation tokens with a public-safe label', () => {
    expect(sanitizePublicThreadText('Finding. citeturn123search0')).toBe(
      'Finding. [source citation]',
    );
  });

  test('reports active OIX threads as working and omits reasoning details', () => {
    const thread = {
      id: 'thread-1',
      name: 'Long task',
      updatedAt: 100,
      status: { type: 'active', activeFlags: [] },
      turns: [{
        id: 'turn-1',
        status: 'inProgress',
        error: null,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'keep going' }] },
          { id: 'reason-1', type: 'reasoning', summary: ['private chain'], content: null },
          {
            id: 'command-1',
            type: 'commandExecution',
            command: 'curl -H "Authorization: Bearer secret-value" https://private.invalid',
            status: 'completed',
          },
          {
            id: 'files-1',
            type: 'fileChange',
            status: 'completed',
            changes: [
              { path: '/workspace/translations/paper.md', kind: { type: 'add' } },
              { path: '/workspace/index.json', kind: { type: 'update' } },
            ],
          },
          { id: 'agent-1', type: 'agentMessage', text: 'Public result' },
        ],
      }],
    } as unknown as v2.Thread;
    const snapshot = buildPublicThreadSnapshot({
      thread,
      goal: null,
      title: 'Long task',
      nextCursor: null,
      hasMore: false,
    });

    expect(snapshot.status).toBe('working');
    expect(JSON.stringify(snapshot)).not.toContain('private chain');
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
    expect(JSON.stringify(snapshot)).not.toContain('private.invalid');
    expect(JSON.stringify(snapshot)).toContain('Ran a command');
    expect(JSON.stringify(snapshot)).toContain('Created paper.md and 1 more');
    expect(JSON.stringify(snapshot)).not.toContain('/workspace/translations');
    expect(JSON.stringify(snapshot)).toContain('Public result');
  });
});
