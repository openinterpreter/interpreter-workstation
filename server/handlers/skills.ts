import fs from 'node:fs/promises';
import path from 'node:path';
import type { v2 } from './codex-generated-types/index';
import type { SkillOption, SkillsData, SkillTreeNode } from '../../shared/types/skill';
import { humanizeSkillName } from '../../shared/utils/skillDisplay';
import { broadcastEvent } from './broadcast';
import { getCurrentWorkspace } from '../utils/workspace';
import { getCodexService } from '../utils/codexSkillsBridge';
import { watch, type FSWatcher } from '../utils/fsWatchBridge';
import {
  getGlobalSkillsRoot,
  getInterpreterUserDataDir,
  getProjectSkillsRoot,
} from '../utils/skillsPaths';
import {
  isBundledSkillEnabledInCurrentApp,
  shouldStripSystemSkillInCurrentApp,
} from './bundledSkillAvailabilityBridge';

export { getGlobalSkillsRoot } from '../utils/skillsPaths';

const SKILLS_SUBDIR = 'skills';

const cachedSkillsByWorkspace = new Map<string, SkillsData>();
const workspaceWatchers = new Map<string, FSWatcher>();
const workspaceSkillsWatchers = new Map<string, FSWatcher>();
let globalSkillsWatcher: FSWatcher | null = null;
let watchedGlobalSkillsPath: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function isPathWithin(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function onSkillsChanged(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    invalidateSkillsCache();
    broadcastEvent('skills:changed', {});
  }, 250);
}

function getSkillsCacheKey(workspacePath: string | null): string {
  return workspacePath ?? '__NO_WORKSPACE__';
}

function stopWatchingWorkspace(workspacePath: string): void {
  const watcher = workspaceWatchers.get(workspacePath);
  if (watcher) {
    watcher.close();
    workspaceWatchers.delete(workspacePath);
  }
}

function stopWatchingWorkspaceSkillsDir(skillsDir: string): void {
  const watcher = workspaceSkillsWatchers.get(skillsDir);
  if (watcher) {
    watcher.close();
    workspaceSkillsWatchers.delete(skillsDir);
  }
}

function stopWatchingAllWorkspaceRoots(): void {
  for (const workspacePath of workspaceWatchers.keys()) {
    stopWatchingWorkspace(workspacePath);
  }
  for (const skillsDir of workspaceSkillsWatchers.keys()) {
    stopWatchingWorkspaceSkillsDir(skillsDir);
  }
}

function stopWatchingGlobalSkillsDir(): void {
  if (globalSkillsWatcher) {
    globalSkillsWatcher.close();
    globalSkillsWatcher = null;
  }
  watchedGlobalSkillsPath = null;
}

function startWatchingWorkspace(workspacePath: string): void {
  if (workspaceWatchers.has(workspacePath)) return;

  try {
    const watcher = watch(workspacePath, { recursive: false }, (_eventType, filename) => {
      if (!filename || filename === SKILLS_SUBDIR) {
        const skillsDir = path.join(workspacePath, SKILLS_SUBDIR);
        startWatchingWorkspaceSkillsDir(skillsDir);
        onSkillsChanged();
      }
    });
    watcher.on('error', () => {
      stopWatchingWorkspace(workspacePath);
    });
    workspaceWatchers.set(workspacePath, watcher);
  } catch {
    stopWatchingWorkspace(workspacePath);
  }
}

function startWatchingWorkspaceSkillsDir(skillsDir: string): void {
  if (workspaceSkillsWatchers.has(skillsDir)) return;

  try {
    const watcher = watch(skillsDir, { recursive: true }, onSkillsChanged);
    watcher.on('error', () => {
      stopWatchingWorkspaceSkillsDir(skillsDir);
    });
    workspaceSkillsWatchers.set(skillsDir, watcher);
  } catch {
    stopWatchingWorkspaceSkillsDir(skillsDir);
  }
}

function startWatchingGlobalSkillsDir(skillsDir: string): void {
  if (watchedGlobalSkillsPath === skillsDir && globalSkillsWatcher) return;

  stopWatchingGlobalSkillsDir();

  try {
    globalSkillsWatcher = watch(skillsDir, { recursive: true }, onSkillsChanged);
    globalSkillsWatcher.on('error', () => {
      stopWatchingGlobalSkillsDir();
    });
    watchedGlobalSkillsPath = skillsDir;
  } catch {
    watchedGlobalSkillsPath = null;
  }
}

function sortSkillTreeNodes(nodes: SkillTreeNode[]): SkillTreeNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });
}

async function buildSkillDirectoryChildren(dirPath: string): Promise<SkillTreeNode[]> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const children = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: fullPath,
          type: 'directory' as const,
          children: await buildSkillDirectoryChildren(fullPath),
        } satisfies SkillTreeNode;
      }

      return {
        name: entry.name,
        path: fullPath,
        type: 'file' as const,
      } satisfies SkillTreeNode;
    }));

  return sortSkillTreeNodes(children);
}

async function buildSkillTreeFromSkills(skills: SkillOption[]): Promise<SkillTreeNode[]> {
  const uniqueDirectories: string[] = [];
  const seenDirectories = new Set<string>();

  // The native skill list is the source of truth; the tree only expands
  // directories for skills that Codex reported for this scope.
  for (const skill of skills) {
    if (seenDirectories.has(skill.dirPath)) {
      continue;
    }

    seenDirectories.add(skill.dirPath);
    uniqueDirectories.push(skill.dirPath);
  }

  return Promise.all(uniqueDirectories.map(async (dirPath) => ({
    name: path.basename(dirPath) || dirPath,
    path: dirPath,
    type: 'directory' as const,
    children: await buildSkillDirectoryChildren(dirPath),
  } satisfies SkillTreeNode)));
}

function mapSkillOption(
  skill: {
    name: string;
    description: string;
    path: string;
    scope: 'user' | 'repo' | 'system' | 'admin';
    enabled: boolean;
  },
  source: 'project' | 'global',
): SkillOption {
  const dirPath = path.dirname(skill.path);
  return {
    id: `${source}:${skill.name}:${skill.path}`,
    name: skill.name,
    title: humanizeSkillName(skill.name),
    description: skill.description,
    source,
    scope: skill.scope,
    dirPath,
    filePath: skill.path,
    enabled: skill.enabled,
  };
}

export function isNativeGlobalSkillScope(scope: SkillOption['scope']): boolean {
  return scope === 'user' || scope === 'system';
}

function getSkillScopePriority(scope: SkillOption['scope']): number {
  switch (scope) {
    case 'repo':
      return 3;
    case 'user':
      return 2;
    case 'system':
      return 1;
    case 'admin':
      return 0;
  }
}

function dedupeVisibleSkills(skills: SkillOption[]): SkillOption[] {
  const dedupedSkills = new Map<string, SkillOption>();

  for (const skill of skills) {
    const existingSkill = dedupedSkills.get(skill.name);
    if (!existingSkill) {
      dedupedSkills.set(skill.name, skill);
      continue;
    }

    if (getSkillScopePriority(skill.scope) > getSkillScopePriority(existingSkill.scope)) {
      dedupedSkills.set(skill.name, skill);
    }
  }

  return Array.from(dedupedSkills.values());
}

async function loadNativeSkills(workspacePath: string | null): Promise<{
  globalSkills: SkillOption[];
  projectSkills: SkillOption[];
}> {
  const cwd = workspacePath || getInterpreterUserDataDir();
  const result = await getCodexService().listSkills({
    cwds: [cwd],
    forceReload: true,
  });
  const entry = result.data.find((item) => item.cwd === cwd) ?? result.data[0];
  const skills = entry?.skills ?? [];

  const globalSkills = dedupeVisibleSkills(
    skills
      .filter((skill) => (
        isNativeGlobalSkillScope(skill.scope)
        && isBundledSkillEnabledInCurrentApp(skill.name)
        && !shouldStripSystemSkillInCurrentApp(skill)
      ))
      .map((skill) => mapSkillOption(skill, 'global')),
  )
    .sort((a, b) => a.title.localeCompare(b.title));

  const projectSkills = dedupeVisibleSkills(
    skills
      .filter((skill) => skill.scope === 'repo')
      .map((skill) => mapSkillOption(skill, 'project')),
  )
    .sort((a, b) => a.title.localeCompare(b.title));

  return { globalSkills, projectSkills };
}

export function invalidateSkillsCache(): void {
  cachedSkillsByWorkspace.clear();
}

export async function writeSkillConfig(
  params: v2.SkillsConfigWriteParams,
): Promise<v2.SkillsConfigWriteResponse> {
  const response = await getCodexService().writeSkillConfig(params);
  invalidateSkillsCache();
  broadcastEvent('skills:changed', {});
  return response;
}

export function reconcileCustomFolderWatchers(_folders: string[]): void {
  // Deprecated. Skills are now sourced from native Codex scopes only.
}

export async function getSkills(workspacePathOverride?: string | null): Promise<SkillsData> {
  const workspacePath = workspacePathOverride === undefined ? getCurrentWorkspace() : workspacePathOverride;
  const cacheKey = getSkillsCacheKey(workspacePath);
  const cachedSkills = cachedSkillsByWorkspace.get(cacheKey);
  if (cachedSkills) return cachedSkills;

  const globalRoot = getGlobalSkillsRoot();
  const projectRoot = getProjectSkillsRoot(workspacePath);

  if (workspacePath) {
    startWatchingWorkspace(workspacePath);
    if (projectRoot) {
      startWatchingWorkspaceSkillsDir(projectRoot);
    }
  }
  startWatchingGlobalSkillsDir(globalRoot);

  const { globalSkills, projectSkills } = await loadNativeSkills(workspacePath);
  const [globalTree, projectTree] = await Promise.all([
    buildSkillTreeFromSkills(globalSkills),
    buildSkillTreeFromSkills(projectSkills),
  ]);

  const data: SkillsData = {
    global: {
      rootPath: globalRoot,
      skills: globalSkills,
      tree: globalTree,
    },
    project: {
      rootPath: projectRoot,
      skills: projectSkills,
      tree: projectTree,
    },
  };

  cachedSkillsByWorkspace.set(cacheKey, data);
  return data;
}

export async function deleteSkillDir(dirPath: string): Promise<{ success: boolean; error?: string }> {
  if (!dirPath) {
    return { success: false, error: 'No path provided' };
  }

  const workspacePath = getCurrentWorkspace();
  const allowedRoots = [
    getProjectSkillsRoot(workspacePath),
    getGlobalSkillsRoot(),
  ].filter((root): root is string => Boolean(root));

  const resolvedDir = path.resolve(dirPath);
  const allowedRoot = allowedRoots.find((root) => isPathWithin(root, resolvedDir));
  if (!allowedRoot) {
    return { success: false, error: 'Path is not within a managed skills folder' };
  }

  let realDir: string;
  try {
    realDir = await fs.realpath(resolvedDir);
  } catch (err: any) {
    if (err.code === 'ENOENT') return { success: false, error: 'Path does not exist' };
    return { success: false, error: err.message };
  }

  const realAllowedRoot = await fs.realpath(allowedRoot).catch(() => allowedRoot);
  if (!isPathWithin(realAllowedRoot, realDir)) {
    return { success: false, error: 'Path resolves outside managed skills folder' };
  }

  try {
    await fs.rm(resolvedDir, { recursive: true });
    invalidateSkillsCache();
    broadcastEvent('skills:changed', {});
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function onWorkspaceChanged(): void {
  stopWatchingAllWorkspaceRoots();
  invalidateSkillsCache();
  broadcastEvent('skills:changed', {});
}

export function getSkillsWatcherStateForTests(): {
  workspaceRoots: string[];
  workspaceSkillRoots: string[];
  globalSkillsPath: string | null;
} {
  return {
    workspaceRoots: Array.from(workspaceWatchers.keys()),
    workspaceSkillRoots: Array.from(workspaceSkillsWatchers.keys()),
    globalSkillsPath: watchedGlobalSkillsPath,
  };
}

export function resetSkillsStateForTests(): void {
  stopWatchingAllWorkspaceRoots();
  stopWatchingGlobalSkillsDir();
  invalidateSkillsCache();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
