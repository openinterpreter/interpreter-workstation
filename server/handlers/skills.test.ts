import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockListSkills = mock(async ({ cwds }: { cwds: string[] }) => ({
  data: cwds.map((cwd) => ({ cwd, skills: [] })),
}));

const createdWatchers: Array<{
  path: string;
  close: ReturnType<typeof mock>;
}> = [];
const mockIsBundledSkillEnabledInCurrentApp = mock((_skillName: string) => true);
const mockShouldStripSystemSkillInCurrentApp = mock((_skill: {
  name: string;
  path: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
}) => false);

const mockWatch = mock((watchPath: string) => {
  const watcher = {
    close: mock(() => {}),
    on: mock(() => watcher),
  };
  createdWatchers.push({ path: watchPath, close: watcher.close });
  return watcher;
});

mock.module('../utils/codexSkillsBridge', () => ({
  getCodexService: () => ({
    listSkills: mockListSkills,
  }),
}));

mock.module('../utils/fsWatchBridge', () => ({
  watch: mockWatch,
}));

mock.module('./bundledSkillAvailabilityBridge', () => ({
  isBundledSkillEnabledInCurrentApp: mockIsBundledSkillEnabledInCurrentApp,
  shouldStripSystemSkillInCurrentApp: mockShouldStripSystemSkillInCurrentApp,
}));

const {
  getSkills,
  getSkillsWatcherStateForTests,
  onWorkspaceChanged,
  resetSkillsStateForTests,
} = await import('./skills');

describe('skills watcher lifecycle', () => {
  let workspaceA: string;
  let workspaceB: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'skills-watch-'));
    workspaceA = join(root, 'workspace-a');
    workspaceB = join(root, 'workspace-b');
    mkdirSync(join(workspaceA, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(workspaceB, '.agents', 'skills'), { recursive: true });
    mockListSkills.mockClear();
    mockWatch.mockClear();
    mockIsBundledSkillEnabledInCurrentApp.mockClear();
    mockIsBundledSkillEnabledInCurrentApp.mockImplementation((_skillName: string) => true);
    mockShouldStripSystemSkillInCurrentApp.mockClear();
    mockShouldStripSystemSkillInCurrentApp.mockImplementation((_skill) => false);
    createdWatchers.length = 0;
  });

  afterEach(() => {
    const root = join(workspaceA, '..');
    resetSkillsStateForTests();
    rmSync(root, { recursive: true, force: true });
  });

  test('drops watchers from the previous workspace before reloading', async () => {
    await getSkills(workspaceA);
    expect(getSkillsWatcherStateForTests().workspaceRoots).toEqual([workspaceA]);
    expect(getSkillsWatcherStateForTests().workspaceSkillRoots).toEqual([join(workspaceA, '.agents', 'skills')]);

    onWorkspaceChanged();

    expect(getSkillsWatcherStateForTests().workspaceRoots).toEqual([]);
    expect(getSkillsWatcherStateForTests().workspaceSkillRoots).toEqual([]);
    expect(createdWatchers.find((watcher) => watcher.path === workspaceA)?.close).toHaveBeenCalledTimes(1);
    expect(createdWatchers.find((watcher) => watcher.path === join(workspaceA, '.agents', 'skills'))?.close).toHaveBeenCalledTimes(1);

    await getSkills(workspaceB);

    expect(getSkillsWatcherStateForTests().workspaceRoots).toEqual([workspaceB]);
    expect(getSkillsWatcherStateForTests().workspaceSkillRoots).toEqual([join(workspaceB, '.agents', 'skills')]);
  });

  test('builds the visible tree from listed skill directories', async () => {
    const skillDir = join(workspaceA, '.agents', 'skills', 'remotion-best-practices');
    const referenceDir = join(skillDir, 'references');
    const skillFile = join(skillDir, 'SKILL.md');
    const referenceFile = join(referenceDir, 'clip.md');
    const helperFile = join(skillDir, 'notes.txt');

    mkdirSync(referenceDir, { recursive: true });
    writeFileSync(skillFile, '# Remotion skill\n', 'utf-8');
    writeFileSync(referenceFile, 'clip guidance\n', 'utf-8');
    writeFileSync(helperFile, 'notes\n', 'utf-8');

    mockListSkills.mockImplementationOnce(async ({ cwds }: { cwds: string[] }) => ({
      data: cwds.map((cwd) => ({
        cwd,
        skills: [{
          name: 'remotion-best-practices',
          description: 'Use Remotion well',
          path: skillFile,
          scope: 'repo',
          enabled: true,
        }],
      })),
    }));

    const data = await getSkills(workspaceA);

    expect(data.project.skills.map((skill) => skill.name)).toEqual(['remotion-best-practices']);
    expect(data.project.tree).toEqual([{
      name: 'remotion-best-practices',
      path: skillDir,
      type: 'directory',
      children: [
        {
          name: 'references',
          path: referenceDir,
          type: 'directory',
          children: [{
            name: 'clip.md',
            path: referenceFile,
            type: 'file',
          }],
        },
        {
          name: 'notes.txt',
          path: helperFile,
          type: 'file',
        },
        {
          name: 'SKILL.md',
          path: skillFile,
          type: 'file',
        },
      ],
    }]);
  });

  test('dedupes same-name visible skills and prefers the user-installed global skill', async () => {
    const globalSkillDir = join(workspaceA, '..', 'global-skills', 'skill-creator');
    const systemSkillDir = join(workspaceA, '..', 'global-skills', '.system', 'skill-creator');
    const installerSkillDir = join(workspaceA, '..', 'global-skills', '.system', 'skill-installer');
    const globalSkillFile = join(globalSkillDir, 'SKILL.md');
    const systemSkillFile = join(systemSkillDir, 'SKILL.md');
    const installerSkillFile = join(installerSkillDir, 'SKILL.md');

    mkdirSync(globalSkillDir, { recursive: true });
    mkdirSync(systemSkillDir, { recursive: true });
    mkdirSync(installerSkillDir, { recursive: true });
    writeFileSync(globalSkillFile, '# User skill creator\n', 'utf-8');
    writeFileSync(systemSkillFile, '# System skill creator\n', 'utf-8');
    writeFileSync(installerSkillFile, '# System skill installer\n', 'utf-8');

    mockListSkills.mockImplementationOnce(async ({ cwds }: { cwds: string[] }) => ({
      data: cwds.map((cwd) => ({
        cwd,
        skills: [
          {
            name: 'skill-creator',
            description: 'User-installed skill creator',
            path: globalSkillFile,
            scope: 'user',
            enabled: true,
          },
          {
            name: 'skill-creator',
            description: 'Bundled system skill creator',
            path: systemSkillFile,
            scope: 'system',
            enabled: true,
          },
          {
            name: 'skill-installer',
            description: 'Bundled system skill installer',
            path: installerSkillFile,
            scope: 'system',
            enabled: true,
          },
        ],
      })),
    }));

    const data = await getSkills(workspaceA);

    expect(data.global.skills.map((skill) => skill.name)).toEqual(['skill-creator', 'skill-installer']);
    expect(data.global.skills.find((skill) => skill.name === 'skill-creator')?.scope).toBe('user');
    expect(data.global.skills.find((skill) => skill.name === 'skill-creator')?.filePath).toBe(globalSkillFile);
  });

  test('hides browser-control from global skills when the current app mode disables it', async () => {
    const browserSkillDir = join(workspaceA, '..', 'global-skills', 'browser-control');
    const skillCreatorDir = join(workspaceA, '..', 'global-skills', 'skill-creator');
    const browserSkillFile = join(browserSkillDir, 'SKILL.md');
    const skillCreatorFile = join(skillCreatorDir, 'SKILL.md');

    mkdirSync(browserSkillDir, { recursive: true });
    mkdirSync(skillCreatorDir, { recursive: true });
    writeFileSync(browserSkillFile, '# Browser control\n', 'utf-8');
    writeFileSync(skillCreatorFile, '# Skill creator\n', 'utf-8');

    mockIsBundledSkillEnabledInCurrentApp.mockImplementation((skillName: string) => skillName !== 'browser-control');
    mockListSkills.mockImplementationOnce(async ({ cwds }: { cwds: string[] }) => ({
      data: cwds.map((cwd) => ({
        cwd,
        skills: [
          {
            name: 'browser-control',
            description: 'Bundled browser control',
            path: browserSkillFile,
            scope: 'user',
            enabled: true,
          },
          {
            name: 'skill-creator',
            description: 'Bundled skill creator',
            path: skillCreatorFile,
            scope: 'user',
            enabled: true,
          },
        ],
      })),
    }));

    const data = await getSkills(workspaceA);

    expect(data.global.skills.map((skill) => skill.name)).toEqual(['skill-creator']);
    expect(data.global.tree.map((node) => node.name)).toEqual(['skill-creator']);
  });

  test('hides stripped system skills from global skills even when native Codex reports them', async () => {
    const openaiDocsDir = join(workspaceA, '..', 'global-skills', '.system', 'openai-docs');
    const openaiDocsFile = join(openaiDocsDir, 'SKILL.md');
    const skillCreatorDir = join(workspaceA, '..', 'global-skills', 'skill-creator');
    const skillCreatorFile = join(skillCreatorDir, 'SKILL.md');

    mkdirSync(openaiDocsDir, { recursive: true });
    mkdirSync(skillCreatorDir, { recursive: true });
    writeFileSync(openaiDocsFile, '# OpenAI docs\n', 'utf-8');
    writeFileSync(skillCreatorFile, '# Skill creator\n', 'utf-8');

    mockShouldStripSystemSkillInCurrentApp.mockImplementation((skill) => skill.name === 'openai-docs');
    mockListSkills.mockImplementationOnce(async ({ cwds }: { cwds: string[] }) => ({
      data: cwds.map((cwd) => ({
        cwd,
        skills: [
          {
            name: 'openai-docs',
            description: 'Bundled OpenAI docs helper',
            path: openaiDocsFile,
            scope: 'system',
            enabled: false,
          },
          {
            name: 'skill-creator',
            description: 'Bundled skill creator',
            path: skillCreatorFile,
            scope: 'user',
            enabled: true,
          },
        ],
      })),
    }));

    const data = await getSkills(workspaceA);

    expect(data.global.skills.map((skill) => skill.name)).toEqual(['skill-creator']);
    expect(data.global.tree.map((node) => node.name)).toEqual(['skill-creator']);
  });
});
