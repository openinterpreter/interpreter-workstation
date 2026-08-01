import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Regression guard for the Linux .deb build (issue #1397, PR #1399/#1401).
//
// app-builder-lib's FpmTarget resolves the Linux maintainer-script templates
// (appArmorProfile / afterInstall / afterRemove) relative to the PROJECT ROOT,
// not buildResources:
//
//   function getResource(value, defaultFile) {
//     if (value == null) return path.join(defaultTemplatesDir, defaultFile);
//     return path.resolve(packager.projectDir, value); // <- projectDir, not resources/
//   }
//
// A value of `apparmor-profile.tpl` therefore resolves to `<root>/apparmor-profile.tpl`,
// which does not exist, and the .deb build dies with `ENOENT ... apparmor-profile.tpl`
// inside FpmTarget.createScripts — long after macOS/AppImage targets succeed. The file
// actually lives at `resources/apparmor-profile.tpl`, so the value must carry that prefix.
//
// These tests parse the real electron-builder.yml and resolve each referenced template
// the same way app-builder-lib does, so a missing or mis-pathed template fails in
// `pnpm run test:unit` on the PR instead of in the release build.

const PROJECT_ROOT = process.cwd();
const requireFromElectronBuilder = createRequire(
  realpathSync(path.join(PROJECT_ROOT, 'node_modules/electron-builder/package.json')),
);
const { load: parseYaml } = requireFromElectronBuilder('js-yaml') as {
  load(source: string): unknown;
};

// LinuxTargetSpecificOptions keys that app-builder-lib feeds through getResource()
// (path.resolve(projectDir, value)) and opens as files.
const TEMPLATE_PATH_KEYS = ['appArmorProfile', 'afterInstall', 'afterRemove'] as const;

// Config sections where those options may be set: the linux: root plus per-target blocks.
const LINUX_SECTIONS = ['linux', 'deb', 'rpm', 'pacman', 'freebsd', 'appImage', 'snap'] as const;

function loadConfig(): Record<string, unknown> {
  const raw = readFileSync(path.join(PROJECT_ROOT, 'electron-builder.yml'), 'utf8');
  return parseYaml(raw) as Record<string, unknown>;
}

function collectTemplateRefs(config: Record<string, unknown>): { section: string; key: string; value: string }[] {
  const refs: { section: string; key: string; value: string }[] = [];
  for (const section of LINUX_SECTIONS) {
    const block = config[section];
    if (block == null || typeof block !== 'object') continue;
    for (const key of TEMPLATE_PATH_KEYS) {
      const value = (block as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) {
        refs.push({ section, key, value });
      }
    }
  }
  return refs;
}

describe('electron-builder Linux packaging templates', () => {
  test('every referenced maintainer-script template resolves to an existing file', () => {
    const refs = collectTemplateRefs(loadConfig());

    for (const { section, key, value } of refs) {
      // Mirror app-builder-lib FpmTarget getResource: path.resolve(projectDir, value).
      const resolved = path.resolve(PROJECT_ROOT, value);
      expect(
        existsSync(resolved),
        `${section}.${key}: "${value}" resolves to ${resolved}, which does not exist. `
          + 'app-builder-lib resolves this relative to the project root, so the value '
          + 'must include the resources/ prefix (e.g. resources/apparmor-profile.tpl).',
      ).toBe(true);
    }
  });

  test('deb ships the pinned AppArmor userns profile for the Ubuntu 24.04 sandbox', () => {
    // The Chromium-sandbox-on-Ubuntu-24.04 fix (#1399) hinges on the .deb shipping this
    // profile. If it is ever dropped or renamed, fail loudly rather than silently
    // regressing the renderer sandbox on .deb installs.
    const config = loadConfig();
    const deb = config.deb as Record<string, unknown> | undefined;
    const appArmorProfile = deb?.appArmorProfile;

    expect(typeof appArmorProfile).toBe('string');
    expect(existsSync(path.resolve(PROJECT_ROOT, appArmorProfile as string))).toBe(true);

    // The template must be a real AppArmor profile granting the userns the renderer needs.
    const body = readFileSync(path.resolve(PROJECT_ROOT, appArmorProfile as string), 'utf8');
    expect(body).toContain('userns');
  });
});
