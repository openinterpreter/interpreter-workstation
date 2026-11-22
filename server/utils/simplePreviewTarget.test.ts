import { describe, expect, test } from 'bun:test';
import { reportedSimplePreviewTarget, resolveSimplePreviewTargetPort } from './simplePreviewTarget';

const running = (port: number) => ({ status: 'running', url: `http://127.0.0.1:${port}` });

describe('Simple preview target', () => {
  test('forwards to the reported project while it is still selected and running', async () => {
    const target = reportedSimplePreviewTarget('/projects/a', true, 'ws_1');
    expect(target).toEqual({ path: '/projects/a', sessionKey: 'ws_1' });
    const seen: Array<string | null> = [];
    const result = await resolveSimplePreviewTargetPort(target, {
      selectedPath: async (sessionKey) => { seen.push(sessionKey); return '/projects/a'; },
      status: async () => running(43811),
    });
    expect(result).toEqual({ port: 43811, stale: false });
    expect(seen).toEqual(['ws_1']);
  });

  test('refuses the previous project when another is selected, even though the previous one still runs', async () => {
    const target = reportedSimplePreviewTarget('/projects/old', true, null);
    let statusReads = 0;
    const result = await resolveSimplePreviewTargetPort(target, {
      // The newly selected project is stopped or still starting.
      selectedPath: async () => '/projects/new',
      status: async (projectPath) => {
        statusReads += 1;
        return projectPath === '/projects/old' ? running(43800) : { status: 'stopped', url: null };
      },
    });
    expect(result).toEqual({ port: null, stale: true });
    expect(statusReads).toBe(0);
  });

  test('refuses when nothing is selected or the selection cannot be resolved', async () => {
    const target = reportedSimplePreviewTarget('/projects/a', true, null);
    const result = await resolveSimplePreviewTargetPort(target, {
      selectedPath: async () => null,
      status: async () => running(43800),
    });
    expect(result).toEqual({ port: null, stale: true });
  });

  test('a report about a project that is not running clears the target', async () => {
    expect(reportedSimplePreviewTarget('/projects/new', false, null)).toBeNull();
    const result = await resolveSimplePreviewTargetPort(null, {
      selectedPath: async () => '/projects/old',
      status: async () => running(43800),
    });
    expect(result).toEqual({ port: null, stale: false });
  });

  test('answers no port when the selected project is not running or its address is unusable', async () => {
    const target = reportedSimplePreviewTarget('/projects/a', true, null);
    const selectedPath = async () => '/projects/a';
    expect(await resolveSimplePreviewTargetPort(target, { selectedPath, status: async () => ({ status: 'stopped', url: null }) }))
      .toEqual({ port: null, stale: false });
    expect(await resolveSimplePreviewTargetPort(target, { selectedPath, status: async () => ({ status: 'running', url: 'not a url' }) }))
      .toEqual({ port: null, stale: false });
    expect(await resolveSimplePreviewTargetPort(target, { selectedPath, status: async () => ({ status: 'running', url: 'http://127.0.0.1' }) }))
      .toEqual({ port: null, stale: false });
  });
});
