import path from 'node:path';
import { resolveDefaultCodexHome } from '../../src/lib/codex/app-server-client';

const SKILLS_SUBDIR = 'skills';
const AGENTS_DIR = '.agents';

export function getInterpreterUserDataDir(): string {
  const userDataDir = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (userDataDir) {
    return path.resolve(userDataDir);
  }

  return path.dirname(resolveDefaultCodexHome());
}

export function getGlobalSkillsRoot(): string {
  return path.join(getInterpreterUserDataDir(), 'codex-home', SKILLS_SUBDIR);
}

export function getProjectSkillsRoot(workspacePath: string | null): string | null {
  if (!workspacePath) {
    return null;
  }

  return path.join(workspacePath, AGENTS_DIR, SKILLS_SUBDIR);
}
