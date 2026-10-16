import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache, setInterpreterHomeDir } from '../configStore';
import { createSimpleProject } from '../simpleProjects';
import { promoteSimpleProjectApp, resetSimpleProjectRuntimeForTest } from './simpleProjectRuntime';

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return last!;
}

describe('full-stack Simple project runtime', () => {
  let temp: string;
  let projectPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'interpreter-simple-runtime-')));
    originalHome = process.env.HOME;
    process.env.HOME = temp;
    setInterpreterHomeDir(join(temp, 'config'));
    projectPath = join(temp, 'Interface');
    mkdirSync(projectPath);
    await createSimpleProject(projectPath);
    mkdirSync(join(projectPath, 'app', 'api', 'health'), { recursive: true });
    writeFileSync(
      join(projectPath, 'app', 'api', 'health', 'route.js'),
      "export function GET(){ return Response.json({ runtime: 'next', backend: true }); }\n",
    );
  });

  afterEach(async () => {
    await resetSimpleProjectRuntimeForTest(projectPath);
    setInterpreterHomeDir(null);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    clearConfigCache();
    rmSync(temp, { recursive: true, force: true });
  });

  test('serves backend routes and refreshes project code at one stable URL', async () => {
    const status = await promoteSimpleProjectApp('http://127.0.0.1:5177');
    expect(status.ready).toBe(true);
    expect(status.runtimeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(readFileSync(join(projectPath, 'next.config.mjs'), 'utf8')).toContain('devIndicators: false');
    const runtimeUrl = status.runtimeUrl!;

    const health = await eventually(
      async () => {
        const response = await fetch(`${runtimeUrl}/api/health`);
        return response.ok ? await response.json() : null;
      },
      (value) => value?.backend === true,
    );
    expect(health).toEqual({ runtime: 'next', backend: true });

    writeFileSync(
      join(projectPath, 'src', 'App.jsx'),
      "export default function App(){ return <main>fast-refresh-marker</main>; }\n",
    );
    const refreshedHtml = await eventually(
      async () => (await fetch(runtimeUrl)).text(),
      (html) => html.includes('fast-refresh-marker'),
    );
    expect(refreshedHtml).toContain('fast-refresh-marker');
    expect((await promoteSimpleProjectApp('http://127.0.0.1:5177')).runtimeUrl).toBe(runtimeUrl);
  }, 60_000);
});
