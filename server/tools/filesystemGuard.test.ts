import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalManager } from '../approvalManager';
import { clearConfigCache, setConfigOverride } from '../configStore';
import {
  authorizeFileWriteAccess,
  FS_GUARD_CATEGORIES,
  isOutsideWorkspace,
  requestFilesystemApproval,
} from './filesystemGuard';
import { normalizePath } from '../utils/permissions';

describe('isOutsideWorkspace', () => {
  let rootDir = '';
  let workspacePath = '';
  let outsideFile = '';
  let insideFile = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'workspace-boundary-test-'));
    workspacePath = join(rootDir, 'workspace');
    const outsideDir = join(rootDir, 'outside');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    insideFile = join(workspacePath, 'src', 'index.ts');
    outsideFile = join(outsideDir, 'file.txt');
    await writeFile(insideFile, 'inside', 'utf-8');
    await writeFile(outsideFile, 'outside', 'utf-8');
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test('treats non-workspace sandbox-like paths as outside', async () => {
    const sandboxFile = normalizePath(join(rootDir, 'sandbox', 'tool-read_pdf.txt'));
    await mkdir(join(rootDir, 'sandbox'), { recursive: true });
    await writeFile(sandboxFile, 'sandbox', 'utf-8');
    expect(await isOutsideWorkspace(sandboxFile, workspacePath)).toBe(true);
  });

  test('returns false for files inside workspace', async () => {
    expect(await isOutsideWorkspace(insideFile, workspacePath)).toBe(false);
  });

  test('returns true for files outside workspace and outside sandbox', async () => {
    expect(await isOutsideWorkspace(outsideFile, workspacePath)).toBe(true);
  });

  test('returns false when workspace is null', async () => {
    expect(await isOutsideWorkspace(outsideFile, null)).toBe(false);
  });

  test('treats symlink escapes from inside workspace as outside', async () => {
    if (process.platform === 'win32') return;

    const escapedPath = join(workspacePath, 'escape.txt');
    await symlink(outsideFile, escapedPath);

    expect(await isOutsideWorkspace(escapedPath, workspacePath)).toBe(true);
  });
});

describe('requestFilesystemApproval', () => {
  let userDataDir = '';
  let skillFilePath = '';
  let outsideFilePath = '';
  let originalUserDataDir: string | undefined;
  let originalCreateSessionAwareApproval: typeof approvalManager.createSessionAwareApproval;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'skills-approval-test-'));
    const skillsDir = join(userDataDir, 'codex-home', 'skills', 'workstation-app');
    await mkdir(skillsDir, { recursive: true });
    skillFilePath = join(skillsDir, 'SKILL.md');
    outsideFilePath = join(userDataDir, 'outside.txt');
    await writeFile(skillFilePath, '# skill', 'utf-8');
    await writeFile(outsideFilePath, 'outside', 'utf-8');

    originalUserDataDir = process.env.INTERPRETER_USER_DATA_DIR;
    process.env.INTERPRETER_USER_DATA_DIR = userDataDir;
    originalCreateSessionAwareApproval = approvalManager.createSessionAwareApproval;
    approvalManager.clearAll();
    setConfigOverride({
      agents: {},
      codexSandboxMode: 'workspace-write',
      codexReadAccessMode: 'full-system',
      codexApprovalPolicy: 'never',
    } as any);
  });

  afterEach(async () => {
    approvalManager.createSessionAwareApproval = originalCreateSessionAwareApproval;
    approvalManager.clearAll();
    setConfigOverride(null);
    clearConfigCache();
    if (originalUserDataDir === undefined) {
      delete process.env.INTERPRETER_USER_DATA_DIR;
    } else {
      process.env.INTERPRETER_USER_DATA_DIR = originalUserDataDir;
    }
    await rm(userDataDir, { recursive: true, force: true });
  });

  test('auto-approves reads inside global skills folder without prompting', async () => {
    approvalManager.createSessionAwareApproval = async () => {
      throw new Error('should not prompt for trusted skill reads');
    };

    const result = await requestFilesystemApproval({
      category: FS_GUARD_CATEGORIES.READ_OUTSIDE,
      paths: [skillFilePath],
    });

    expect(result).toEqual({ approved: true });
  });

  test('follows the global read scope for non-skill outside reads', async () => {
    let prompted = false;
    approvalManager.createSessionAwareApproval = async () => {
      prompted = true;
      return { approved: true };
    };

    const result = await requestFilesystemApproval({
      category: FS_GUARD_CATEGORIES.READ_OUTSIDE,
      paths: [outsideFilePath],
    });

    expect(result).toEqual({ approved: true });
    expect(prompted).toBe(false);
  });

  test('denies outside reads when global scope is folder-only', async () => {
    setConfigOverride({
      agents: {},
      codexSandboxMode: 'workspace-write',
      codexReadAccessMode: 'workspace-only',
      codexApprovalPolicy: 'never',
    } as any);

    const result = await requestFilesystemApproval({
      category: FS_GUARD_CATEGORIES.READ_OUTSIDE,
      paths: [outsideFilePath],
    });

    expect(result).toEqual({ approved: false });
  });
});

describe('authorizeFileWriteAccess', () => {
  let originalCreateSessionAwareApproval: typeof approvalManager.createSessionAwareApproval;
  let rootDir = '';
  let workspacePath = '';

  beforeEach(async () => {
    originalCreateSessionAwareApproval = approvalManager.createSessionAwareApproval;
    approvalManager.clearAll();
    rootDir = await mkdtemp(join(tmpdir(), 'workspace-write-approval-test-'));
    workspacePath = join(rootDir, 'workspace');
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    approvalManager.createSessionAwareApproval = originalCreateSessionAwareApproval;
    approvalManager.clearAll();
    setConfigOverride(null);
    clearConfigCache();
    await rm(rootDir, { recursive: true, force: true });
  });

  test('prompts for workspace writes when change-files is ask-first', async () => {
    let capturedCategory: string | undefined;
    let capturedPaths: string[] | undefined;
    approvalManager.createSessionAwareApproval = async (toolName, _serverId, context) => {
      capturedCategory = toolName;
      capturedPaths = context.paths as string[];
      return { approved: true };
    };
    setConfigOverride({
      agents: {},
      codexSandboxMode: 'workspace-write',
      codexReadAccessMode: 'workspace-only',
      codexApprovalPolicy: 'untrusted',
      codexMacosTempAccess: false,
      codexMacosScreenshotAccess: false,
    } as any);

    const filePath = join(workspacePath, 'note.md');
    const result = await authorizeFileWriteAccess({
      agentId: 'agent-1',
      filePath,
      workspace: workspacePath,
      toolCallId: 'tc-ask-write',
    });

    expect(result).toEqual({ allowed: true });
    expect(capturedCategory).toBe(FS_GUARD_CATEGORIES.WRITE);
    expect(capturedPaths).toEqual([filePath]);
  });

  test('denies outside-workspace writes in ask-first mode without prompting', async () => {
    let prompted = false;
    approvalManager.createSessionAwareApproval = async () => {
      prompted = true;
      return { approved: true };
    };
    setConfigOverride({
      agents: {},
      codexSandboxMode: 'workspace-write',
      codexReadAccessMode: 'workspace-only',
      codexApprovalPolicy: 'untrusted',
      codexMacosTempAccess: false,
      codexMacosScreenshotAccess: false,
    } as any);

    const outsidePath = join(rootDir, 'outside.md');
    const result = await authorizeFileWriteAccess({
      agentId: 'agent-1',
      filePath: outsidePath,
      workspace: workspacePath,
      toolCallId: 'tc-outside-write',
    });

    expect(result.allowed).toBe(false);
    expect(result.deniedByUser).toBeUndefined();
    expect(result.message).toContain(outsidePath);
    expect(prompted).toBe(false);
  });

  test('allows workspace writes without prompting in current-folder mode', async () => {
    let prompted = false;
    approvalManager.createSessionAwareApproval = async () => {
      prompted = true;
      return { approved: true };
    };
    setConfigOverride({
      agents: {},
      codexSandboxMode: 'workspace-write',
      codexReadAccessMode: 'workspace-only',
      codexApprovalPolicy: 'never',
      codexMacosTempAccess: false,
      codexMacosScreenshotAccess: false,
    } as any);

    const filePath = join(workspacePath, 'note.md');
    const result = await authorizeFileWriteAccess({
      agentId: 'agent-1',
      filePath,
      workspace: workspacePath,
      toolCallId: 'tc-workspace-write',
    });

    expect(result).toEqual({ allowed: true });
    expect(prompted).toBe(false);
  });
});
