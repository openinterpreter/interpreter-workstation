import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  BROWSER_CONTROL_SKILL_NAME,
  getBundledSkillsDisabledInCurrentApp,
  getStrippedSystemSkillPathsInCurrentApp,
  isBrowserControlSkillEnabled,
  isBundledSkillEnabledInCurrentApp,
  shouldStripSystemSkillInCurrentApp,
  STRIPPED_SYSTEM_SKILL_NAMES,
} from './bundledSkillAvailability';

describe('bundledSkillAvailability', () => {
  test('keeps browser-control enabled in unpackaged app modes', () => {
    expect(isBrowserControlSkillEnabled({ isPackagedApp: false })).toBe(true);
    expect(isBundledSkillEnabledInCurrentApp(BROWSER_CONTROL_SKILL_NAME, { isPackagedApp: false })).toBe(true);
    expect(getBundledSkillsDisabledInCurrentApp({ isPackagedApp: false })).toEqual([]);
  });

  test('keeps browser-control enabled in packaged app modes', () => {
    expect(isBrowserControlSkillEnabled({ isPackagedApp: true })).toBe(true);
    expect(isBundledSkillEnabledInCurrentApp(BROWSER_CONTROL_SKILL_NAME, { isPackagedApp: true })).toBe(true);
    expect(getBundledSkillsDisabledInCurrentApp({ isPackagedApp: true })).toEqual([]);
  });

  test('matches only the stripped bundled system skill paths', () => {
    const systemSkillPath = path.join('/tmp', 'codex-home', 'skills', '.system', 'imagegen', 'SKILL.md');
    const userSkillPath = path.join('/tmp', 'codex-home', 'skills', 'imagegen', 'SKILL.md');

    expect(shouldStripSystemSkillInCurrentApp({
      name: 'imagegen',
      path: systemSkillPath,
      scope: 'system',
    })).toBe(true);
    expect(shouldStripSystemSkillInCurrentApp({
      name: 'imagegen',
      path: userSkillPath,
      scope: 'user',
    })).toBe(false);
    expect(shouldStripSystemSkillInCurrentApp({
      name: 'skill-creator',
      path: path.join('/tmp', 'codex-home', 'skills', '.system', 'skill-creator', 'SKILL.md'),
      scope: 'system',
    })).toBe(false);
  });

  test('builds the exact stripped system skill paths for the current codex home', () => {
    expect(getStrippedSystemSkillPathsInCurrentApp('/tmp/codex-home')).toEqual(
      STRIPPED_SYSTEM_SKILL_NAMES.map((skillName) => (
        path.join('/tmp', 'codex-home', 'skills', '.system', skillName, 'SKILL.md')
      )),
    );
  });
});
