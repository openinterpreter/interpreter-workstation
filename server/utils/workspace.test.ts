import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  getCurrentWorkspace,
  requireExistingWorkspacePath,
  setCurrentWorkspace,
  setWorkspace,
} from './workspace';

describe('setWorkspace', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let originalWorkspace: string | null = null;
  let createdWorkspace: string | null = null;

  beforeEach(() => {
    originalWorkspace = getCurrentWorkspace();
  });

  afterEach(() => {
    setCurrentWorkspace(originalWorkspace);
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (createdWorkspace) {
      rmSync(createdWorkspace, { recursive: true, force: true });
      createdWorkspace = null;
    }
  });

  test('expands tilde paths when HOME is unset', () => {
    createdWorkspace = mkdtempSync(join(homedir(), '.workspace-tilde-test-'));
    const tildePath = `~/${basename(createdWorkspace)}`;

    delete process.env.HOME;

    setWorkspace(tildePath);

    expect(getCurrentWorkspace()).toBe(createdWorkspace);
  });
});

describe('requireExistingWorkspacePath', () => {
  test('returns an existing directory path', () => {
    const workspace = mkdtempSync(join(homedir(), '.workspace-existing-test-'));

    try {
      expect(requireExistingWorkspacePath(workspace)).toBe(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('throws a recovery message for a missing directory', () => {
    const workspace = mkdtempSync(join(homedir(), '.workspace-missing-test-'));

    try {
      rmSync(workspace, { recursive: true, force: true });
      expect(() => requireExistingWorkspacePath(workspace)).toThrow(
        'The selected folder no longer exists. Pick a new folder and try again.',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('throws the empty-workspace message when no path is set', () => {
    expect(() => requireExistingWorkspacePath(null)).toThrow(
      'No workspace set. Open a folder first.',
    );
  });
});
