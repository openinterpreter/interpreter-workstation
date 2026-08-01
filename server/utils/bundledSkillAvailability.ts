import path from 'node:path';

export const BROWSER_CONTROL_SKILL_NAME = 'browser-control';
export const STRIPPED_SYSTEM_SKILL_NAMES = [
  'imagegen',
  'openai-docs',
  'plugin-creator',
] as const;

const DISABLED_BUNDLED_SKILL_NAMES = new Set<string>();
const STRIPPED_SYSTEM_SKILL_NAME_SET = new Set<string>(STRIPPED_SYSTEM_SKILL_NAMES);
const SKILLS_DIR_NAME = 'skills';
const SYSTEM_SKILLS_DIR_NAME = '.system';
const SKILL_DOC_FILENAME = 'SKILL.md';

export function isPackagedElectronApp(): boolean {
  if (!process.versions.electron) {
    return false;
  }

  try {
    return require('electron').app.isPackaged;
  } catch {
    return false;
  }
}

export function isBundledSkillEnabledInCurrentApp(
  skillName: string,
  options: { isPackagedApp?: boolean } = {},
): boolean {
  void options;
  return !DISABLED_BUNDLED_SKILL_NAMES.has(skillName);
}

export function getBundledSkillsDisabledInCurrentApp(
  options: { isPackagedApp?: boolean } = {},
): string[] {
  void options;
  return [];
}

function isSystemSkillDocPath(skillPath: string, skillName: string): boolean {
  if (path.basename(skillPath) !== SKILL_DOC_FILENAME) {
    return false;
  }

  const skillDir = path.dirname(skillPath);
  if (path.basename(skillDir) !== skillName) {
    return false;
  }

  const systemDir = path.dirname(skillDir);
  if (path.basename(systemDir) !== SYSTEM_SKILLS_DIR_NAME) {
    return false;
  }

  return path.basename(path.dirname(systemDir)) === SKILLS_DIR_NAME;
}

export function shouldStripSystemSkillInCurrentApp(
  skill: {
    name: string;
    path: string;
    scope: 'user' | 'repo' | 'system' | 'admin';
  },
  options: { isPackagedApp?: boolean } = {},
): boolean {
  void options;

  return skill.scope === 'system'
    && STRIPPED_SYSTEM_SKILL_NAME_SET.has(skill.name)
    && isSystemSkillDocPath(skill.path, skill.name);
}

export function getStrippedSystemSkillPathsInCurrentApp(
  codeHome: string,
  options: { isPackagedApp?: boolean } = {},
): string[] {
  void options;

  return STRIPPED_SYSTEM_SKILL_NAMES.map((skillName) => (
    path.join(codeHome, SKILLS_DIR_NAME, SYSTEM_SKILLS_DIR_NAME, skillName, SKILL_DOC_FILENAME)
  ));
}

export function isBrowserControlSkillEnabled(
  options: { isPackagedApp?: boolean } = {},
): boolean {
  return isBundledSkillEnabledInCurrentApp(BROWSER_CONTROL_SKILL_NAME, options);
}
