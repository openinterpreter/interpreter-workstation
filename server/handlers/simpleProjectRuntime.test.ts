import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache, setInterpreterHomeDir } from '../configStore';
import { createSimpleProject } from '../simpleProjects';
import { promoteSimpleProjectApp, readSimpleProjectAppStatus, resetSimpleProjectRuntimeForTest } from './simpleProjectRuntime';
import { stopSimpleAssetWatchersForTest } from './simpleAssetRevision';

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
  let originalRegistry: string | undefined;
  let originalOffline: string | undefined;

  beforeEach(async () => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'interpreter-simple-runtime-')));
    originalHome = process.env.HOME;
    originalRegistry = process.env.npm_config_registry;
    originalOffline = process.env.npm_config_offline;
    process.env.HOME = temp;
    process.env.npm_config_registry = 'http://127.0.0.1:1';
    process.env.npm_config_offline = 'true';
    setInterpreterHomeDir(join(temp, 'config'));
    projectPath = join(temp, 'Interface');
    mkdirSync(projectPath);
    await createSimpleProject(projectPath);
    const legacyManifest = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8'));
    legacyManifest.dependencies.next = '16.4.0';
    writeFileSync(join(projectPath, 'package.json'), `${JSON.stringify(legacyManifest, null, 2)}\n`);
    mkdirSync(join(projectPath, 'app', 'api', 'health'), { recursive: true });
    writeFileSync(
      join(projectPath, 'app', 'api', 'health', 'route.js'),
      "export function GET(){ return Response.json({ runtime: 'next', backend: true }); }\n",
    );
  });

  afterEach(async () => {
    await resetSimpleProjectRuntimeForTest(projectPath);
    stopSimpleAssetWatchersForTest();
    setInterpreterHomeDir(null);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = originalRegistry;
    if (originalOffline === undefined) delete process.env.npm_config_offline;
    else process.env.npm_config_offline = originalOffline;
    clearConfigCache();
    rmSync(temp, { recursive: true, force: true });
  });

  test('starts cold without registry access, serves backend routes, and refreshes at one URL', async () => {
    const status = await promoteSimpleProjectApp('http://127.0.0.1:5177');
    expect(status.ready, status.diagnostic ?? 'No runtime diagnostic').toBe(true);
    expect(status.runtimeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(readFileSync(join(projectPath, 'next.config.mjs'), 'utf8')).toContain('devIndicators: false');
    const projectDependencies = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')).dependencies;
    const bundledDependencies = JSON.parse(readFileSync(join(process.cwd(), 'resources', 'simple-interface-runtime', 'package.json'), 'utf8')).dependencies;
    for (const [name, version] of Object.entries(bundledDependencies)) {
      expect(projectDependencies[name]).toBe(version);
    }
    const runtimeUrl = status.runtimeUrl!;

    const health = await eventually(
      async () => {
        try {
          const response = await fetch(`${runtimeUrl}/api/health`);
          return response.ok ? await response.json() : null;
        } catch {
          return null;
        }
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

    const beforeAssetChange = status.assetRevision ?? 0;
    mkdirSync(join(projectPath, 'public'), { recursive: true });
    writeFileSync(join(projectPath, 'public', 'photo.png'), 'new image bytes');
    const changed = await eventually(
      () => readSimpleProjectAppStatus(),
      (value) => (value.assetRevision ?? 0) > beforeAssetChange,
    );
    expect(changed.runtimeUrl).toBe(runtimeUrl);
  }, 60_000);
});
