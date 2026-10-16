import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache, setInterpreterHomeDir } from './configStore';
import { createSimpleProject, getActiveSimpleProject, openSimpleProject, syncSimpleProjectManagedFiles } from './simpleProjects';
import { SIMPLE_INTERFACE_MANAGED_AGENTS_MARKER } from './simpleInterfaceSkill';
import { registerWindowSession, runWithWindowSessionOverride, unregisterWindowSession } from './utils/windowSessions';
import { setSimpleWorkspacePath } from './simpleWorkspace';

describe('standalone Simple interface projects', () => {
  let temp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'interpreter-simple-project-')));
    originalHome = process.env.HOME;
    process.env.HOME = temp;
    setInterpreterHomeDir(join(temp, 'config'));
  });

  afterEach(() => {
    setInterpreterHomeDir(null);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    clearConfigCache();
    rmSync(temp, { recursive: true, force: true });
  });

  test('creates a standalone Next.js project with durable metadata and agent guidance', async () => {
    const projectPath = join(temp, 'My Interface');
    mkdirSync(projectPath);
    const project = await createSimpleProject(projectPath);

    expect(project.path).toBe(realpathSync(projectPath));
    expect(project.legacy).toBe(false);
    expect(existsSync(join(projectPath, '.interpreter', 'project.json'))).toBe(true);
    const packageManifest = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      interpreter?: { runtime?: string; version?: number };
    };
    expect(packageManifest.scripts).toEqual({
      dev: 'next dev --hostname 127.0.0.1',
      start: 'next dev --hostname 127.0.0.1',
    });
    expect(packageManifest.interpreter).toEqual({ runtime: 'next', version: 2 });
    expect(packageManifest.dependencies).toMatchObject({
      '@interpreter/interface': 'file:.interpreter/packages/interface',
      '@interpreter/motion': 'file:.interpreter/packages/motion',
      next: '16.4.0',
    });
    expect(readFileSync(join(projectPath, 'AGENTS.md'), 'utf8')).toContain('full-stack Next.js interface project');
    const skill = readFileSync(join(projectPath, '.interpreter', 'skills', 'interface-design', 'SKILL.md'), 'utf8');
    const projectGuidance = readFileSync(join(projectPath, 'AGENTS.md'), 'utf8');
    expect(projectGuidance).toContain('respond in voice when the request came from GPT Live');
    expect(projectGuidance).toContain(SIMPLE_INTERFACE_MANAGED_AGENTS_MARKER);
    expect(projectGuidance).toContain('Do not search Interpreter app\ntools');
    expect(projectGuidance).not.toContain('WhatsApp');
    expect(skill).not.toContain('WhatsApp');
    expect(skill).toContain('Motion Primitives by Julian');
    expect(skill).toContain('There is no separate task inbox or polling protocol');
    expect(skill).toContain('a live answer, not a web page');
    expect(skill).toContain("Workstation's real editor");
    expect(skill).toContain('the same editable Markdown surface');
    expect(skill).toContain('Keep critical controls');
    expect(skill).toContain('visible without scrolling');
    expect(skill).toContain('app/api/');
    expect(skill).toContain('any ordinary npm dependency');
    expect(skill).toContain('copy an external image into `public/`');
    expect((await openSimpleProject(projectPath)).metadata.id).toBe(project.metadata.id);
  });

  test('refreshes managed and legacy guidance while preserving Next rules', async () => {
    const projectPath = join(temp, 'Legacy Interface');
    mkdirSync(projectPath);
    await createSimpleProject(projectPath);
    const agentsPath = join(projectPath, 'AGENTS.md');
    const nextRules = `<!-- BEGIN:nextjs-agent-rules -->\n\n## Current Next guidance\n\n<!-- END:nextjs-agent-rules -->`;
    writeFileSync(agentsPath, `# Interpreter interface project\n\nThis folder is one standalone Simple-mode React interface project. It is not a\nroute inside another interface. Work under \`src/\`; keep static assets under\n\`public/\`. Interpreter owns hidden \`.interpreter/\` metadata and runtime files.\n\n${nextRules}\n`);

    syncSimpleProjectManagedFiles(projectPath);

    const refreshed = readFileSync(agentsPath, 'utf8');
    expect(refreshed).toContain(SIMPLE_INTERFACE_MANAGED_AGENTS_MARKER);
    expect(refreshed).toContain('full-stack Next.js interface project');
    expect(refreshed).not.toContain('Simple-mode React interface project');
    expect(refreshed).toContain(nextRules);
  });

  test('never overwrites user-authored project guidance', async () => {
    const projectPath = join(temp, 'Custom Interface');
    mkdirSync(projectPath);
    await createSimpleProject(projectPath);
    const agentsPath = join(projectPath, 'AGENTS.md');
    writeFileSync(agentsPath, '# My project rules\n\nKeep this exact custom guidance.\n');

    syncSimpleProjectManagedFiles(projectPath);

    expect(readFileSync(agentsPath, 'utf8')).toBe('# My project rules\n\nKeep this exact custom guidance.\n');
  });

  test('first launch creates a standalone sibling project, never a nested legacy interface', async () => {
    const controlPath = join(temp, 'Documents', 'Interpreter');
    mkdirSync(controlPath, { recursive: true });
    await setSimpleWorkspacePath(controlPath);
    const project = await getActiveSimpleProject();
    expect(project.legacy).toBe(false);
    expect(project.path).toBe(join(temp, 'Documents', 'Interpreter Interface'));
    expect(project.path.startsWith(`${controlPath}/`)).toBe(false);
    expect(existsSync(join(controlPath, 'interface'))).toBe(false);
    expect(existsSync(join(project.path, '.interpreter', 'project.json'))).toBe(true);
  });

  test('rejects nonempty and nested project folders', async () => {
    const nonempty = join(temp, 'Nonempty');
    mkdirSync(nonempty);
    writeFileSync(join(nonempty, 'existing.txt'), 'keep me');
    expect(createSimpleProject(nonempty)).rejects.toThrow('empty folder');

    const parent = join(temp, 'Parent');
    mkdirSync(parent);
    await createSimpleProject(parent);
    const nested = join(parent, 'Nested');
    mkdirSync(nested);
    expect(createSimpleProject(nested)).rejects.toThrow('outside the existing project');
  });

  test('resolves independent active projects for concurrent interface windows', async () => {
    const firstPath = join(temp, 'First');
    const secondPath = join(temp, 'Second');
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const first = await createSimpleProject(firstPath, { activate: false });
    const second = await createSimpleProject(secondPath, { activate: false });
    registerWindowSession({ sessionKey: 'project-first', windowId: 501, workspacePath: temp, simpleProjectPath: first.path });
    registerWindowSession({ sessionKey: 'project-second', windowId: 502, workspacePath: temp, simpleProjectPath: second.path });
    try {
      expect((await runWithWindowSessionOverride('project-first', getActiveSimpleProject)).path).toBe(first.path);
      expect((await runWithWindowSessionOverride('project-second', getActiveSimpleProject)).path).toBe(second.path);
    } finally {
      unregisterWindowSession(501);
      unregisterWindowSession(502);
    }
  });
});
