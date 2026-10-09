import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { getSimpleProjectSetting, setSimpleProjectSetting } from './configStore';
import {
  getCurrentWindowSessionKey,
  getWindowSessionSimpleProject,
  updateWindowSessionSimpleProject,
} from './utils/windowSessions';
import { getSimpleWorkspacePath, validateSimpleWorkspacePath } from './simpleWorkspace';
import { SIMPLE_INTERFACE_DESIGN_SKILL, SIMPLE_INTERFACE_MANAGED_AGENTS } from './simpleInterfaceSkill';

export const SIMPLE_PROJECT_METADATA = join('.interpreter', 'project.json');

export type SimpleProjectMetadata = {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
};

export type SimpleProject = {
  path: string;
  metadata: SimpleProjectMetadata;
  legacy: boolean;
};

function isChild(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function canonicalDirectory(inputPath: string): string {
  if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.includes('\0') || !isAbsolute(inputPath)) {
    throw new Error('Choose an absolute project folder.');
  }
  const requested = resolve(inputPath);
  if (!existsSync(requested)) throw new Error('The selected project folder does not exist.');
  if (lstatSync(requested).isSymbolicLink()) throw new Error('A symlink cannot be an interface project.');
  if (!statSync(requested).isDirectory()) throw new Error('An interface project must be a folder.');
  return realpathSync(requested);
}

function readMetadata(projectPath: string): SimpleProjectMetadata | null {
  const metadataPath = join(projectPath, SIMPLE_PROJECT_METADATA);
  if (!existsSync(metadataPath)) return null;
  const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<SimpleProjectMetadata>;
  if (parsed.version !== 1 || typeof parsed.id !== 'string' || typeof parsed.name !== 'string' || typeof parsed.createdAt !== 'string') {
    throw new Error('This folder has invalid Interpreter project metadata.');
  }
  return { version: 1, id: parsed.id, name: parsed.name, createdAt: parsed.createdAt };
}

function findContainingProject(candidatePath: string): string | null {
  let cursor = dirname(candidatePath);
  while (cursor !== parse(cursor).root) {
    if (existsSync(join(cursor, SIMPLE_PROJECT_METADATA))) return cursor;
    cursor = dirname(cursor);
  }
  return null;
}

export async function validateSimpleProjectPath(inputPath: string, options?: { forCreation?: boolean }): Promise<string> {
  const projectPath = canonicalDirectory(inputPath);
  const controlPath = validateSimpleWorkspacePath(await getSimpleWorkspacePath());
  if (projectPath === controlPath || isChild(controlPath, projectPath)) {
    throw new Error('Interface projects must be separate from the Interpreter control workspace.');
  }
  if (options?.forCreation) {
    const parentProject = findContainingProject(projectPath);
    if (parentProject) throw new Error(`Start the interface outside the existing project at ${parentProject}.`);
    const existing = readdirSync(projectPath).filter((name) => name !== '.DS_Store');
    if (existing.length > 0) throw new Error('Choose an empty folder for a new interface.');
  } else if (!readMetadata(projectPath)) {
    throw new Error('This folder is not an Interpreter interface project.');
  }
  return projectPath;
}

export function assertSimpleProjectChildPath(projectPath: string, candidatePath: string): string {
  const root = canonicalDirectory(projectPath);
  if (typeof candidatePath !== 'string' || !candidatePath || candidatePath.includes('\0')) {
    throw new Error('Invalid interface project path.');
  }
  const target = resolve(root, candidatePath);
  if (!isChild(root, target)) throw new Error('Path escapes the interface project.');
  let cursor = root;
  for (const part of relative(root, target).split(sep)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error('Symlinks are not allowed in an interface project.');
    }
  }
  return target;
}

function seedProject(projectPath: string, metadata: SimpleProjectMetadata): void {
  mkdirSync(join(projectPath, '.interpreter', 'runtime'), { recursive: true });
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  mkdirSync(join(projectPath, 'public'), { recursive: true });
  writeFileSync(join(projectPath, SIMPLE_PROJECT_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  writeFileSync(join(projectPath, 'package.json'), `${JSON.stringify({
    name: metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'interpreter-interface',
    private: true,
    version: '0.0.0',
    interpreter: { runtime: 'workstation', version: 1 },
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  writeFileSync(join(projectPath, '.interpreter', 'state.json'), '{}\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  syncSimpleProjectManagedFiles(projectPath, { createAgents: true });
}

export function syncSimpleProjectManagedFiles(projectPath: string, options?: { createAgents?: boolean }): void {
  const skillPath = join(projectPath, '.interpreter', 'skills', 'interface-design', 'SKILL.md');
  mkdirSync(dirname(skillPath), { recursive: true });
  if (!existsSync(skillPath) || readFileSync(skillPath, 'utf8') !== SIMPLE_INTERFACE_DESIGN_SKILL) {
    writeFileSync(skillPath, SIMPLE_INTERFACE_DESIGN_SKILL, { encoding: 'utf8', mode: 0o600 });
  }
  const agentsPath = join(projectPath, 'AGENTS.md');
  if (options?.createAgents && !existsSync(agentsPath)) {
    writeFileSync(agentsPath, SIMPLE_INTERFACE_MANAGED_AGENTS, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
}

async function activateSimpleProject(projectPath: string): Promise<void> {
  await setSimpleProjectSetting(projectPath);
  const sessionKey = getCurrentWindowSessionKey();
  if (sessionKey) updateWindowSessionSimpleProject(sessionKey, projectPath);
}

export async function createSimpleProject(inputPath: string, options?: { activate?: boolean }): Promise<SimpleProject> {
  const projectPath = await validateSimpleProjectPath(inputPath, { forCreation: true });
  const metadata: SimpleProjectMetadata = {
    version: 1,
    id: randomUUID(),
    name: basename(projectPath),
    createdAt: new Date().toISOString(),
  };
  seedProject(projectPath, metadata);
  if (options?.activate !== false) await activateSimpleProject(projectPath);
  else await setSimpleProjectSetting(projectPath, { activate: false });
  return { path: projectPath, metadata, legacy: false };
}

export async function openSimpleProject(inputPath: string, options?: { activate?: boolean }): Promise<SimpleProject> {
  const projectPath = await validateSimpleProjectPath(inputPath);
  const metadata = readMetadata(projectPath);
  if (!metadata) throw new Error('This folder is not an Interpreter interface project.');
  syncSimpleProjectManagedFiles(projectPath);
  if (options?.activate !== false) await activateSimpleProject(projectPath);
  else await setSimpleProjectSetting(projectPath, { activate: false });
  return { path: projectPath, metadata, legacy: false };
}

function readSimpleProject(inputPath: string): SimpleProject {
  const projectPath = canonicalDirectory(inputPath);
  const metadata = readMetadata(projectPath);
  if (!metadata) throw new Error('This folder is not an Interpreter interface project.');
  syncSimpleProjectManagedFiles(projectPath);
  return { path: projectPath, metadata, legacy: false };
}

function nextDefaultProjectPath(controlPath: string): string {
  const parent = dirname(controlPath);
  const base = `${basename(controlPath)} Interface`;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = join(parent, suffix === 0 ? base : `${base} ${suffix + 1}`);
    if (!existsSync(candidate)) return candidate;
    const metadata = readMetadata(candidate);
    if (metadata) return candidate;
  }
  throw new Error('Could not choose a folder for the default Interpreter interface.');
}

async function getOrCreateDefaultProject(): Promise<SimpleProject> {
  const controlPath = await getSimpleWorkspacePath();
  const projectPath = nextDefaultProjectPath(controlPath);
  const metadata = readMetadata(projectPath);
  if (metadata) {
    syncSimpleProjectManagedFiles(projectPath);
    await setSimpleProjectSetting(projectPath);
    return { path: projectPath, metadata, legacy: false };
  }
  mkdirSync(projectPath, { recursive: false });
  return createSimpleProject(projectPath);
}

/** Resolve the project owned by this window, or create a standalone first-run project. */
export async function getActiveSimpleProject(): Promise<SimpleProject> {
  const sessionProjectPath = getWindowSessionSimpleProject(getCurrentWindowSessionKey());
  if (sessionProjectPath && existsSync(sessionProjectPath)) {
    try {
      return readSimpleProject(sessionProjectPath);
    } catch { /* fall through to the global launch default */ }
  }
  const setting = await getSimpleProjectSetting();
  if (setting.activePath && existsSync(setting.activePath)) {
    try {
      const project = readSimpleProject(setting.activePath);
      const controlPath = validateSimpleWorkspacePath(await getSimpleWorkspacePath());
      if (project.path !== controlPath && !isChild(controlPath, project.path)) return project;
    } catch { /* fall through to preserved legacy prototype */ }
  }
  return getOrCreateDefaultProject();
}

export async function listSimpleProjects(): Promise<{ active: SimpleProject; recent: SimpleProject[] }> {
  const active = await getActiveSimpleProject();
  const setting = await getSimpleProjectSetting();
  const recent: SimpleProject[] = [];
  for (const path of setting.recentPaths) {
    try {
      const projectPath = canonicalDirectory(path);
      const metadata = readMetadata(projectPath);
      if (metadata) recent.push({ path: projectPath, metadata, legacy: false });
    } catch { /* Missing projects disappear from recents without blocking startup. */ }
  }
  return { active, recent };
}
