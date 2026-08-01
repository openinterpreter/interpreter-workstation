// Unit tests for permission resolution logic

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canAccess, canAccessAsync, FileAccessPolicy, normalizePath, resolvePathWithWorkspace } from './permissions';

describe('canAccess', () => {
  // Use platform-appropriate absolute paths so tests pass on Windows and Unix
  const isWin = process.platform === 'win32';
  const workspacePath = isWin ? 'C:\\Users\\test\\project' : '/Users/test/project';
  const p = (unixPath: string) => isWin ? unixPath.replace(/\//g, '\\').replace(/^\\/, 'C:\\') : unixPath;

  test('system read allows reading anywhere', () => {
    const permissions: FileAccessPolicy = {
      system: 'read',
      workspace: 'write',
      customPaths: new Map(),
    };

    expect(canAccess(p('/Users/test/file.txt'), 'read', permissions, workspacePath)).toBe(true);
    expect(canAccess(p('/etc/hosts'), 'read', permissions, workspacePath)).toBe(true);
  });

  test('system read denies writing outside workspace', () => {
    const permissions: FileAccessPolicy = {
      system: 'read',
      workspace: 'write',
      customPaths: new Map(),
    };

    expect(canAccess(p('/Users/test/file.txt'), 'write', permissions, workspacePath)).toBe(false);
    expect(canAccess(p('/etc/hosts'), 'write', permissions, workspacePath)).toBe(false);
  });

  test('workspace write allows writing in workspace', () => {
    const permissions: FileAccessPolicy = {
      system: 'read',
      workspace: 'write',
      customPaths: new Map(),
    };

    expect(canAccess(p('/Users/test/project/file.txt'), 'write', permissions, workspacePath)).toBe(true);
    expect(canAccess(p('/Users/test/project/src/index.ts'), 'write', permissions, workspacePath)).toBe(true);
  });

  test('custom path blacklist denies access', () => {
    const permissions: FileAccessPolicy = {
      system: 'read',
      workspace: 'write',
      customPaths: new Map([[p('/Users/test/secrets'), 'none']]),
    };

    expect(canAccess(p('/Users/test/secrets/key.pem'), 'read', permissions, workspacePath)).toBe(false);
    expect(canAccess(p('/Users/test/secrets/key.pem'), 'write', permissions, workspacePath)).toBe(false);
  });

  test('custom path read-only restricts writes', () => {
    const permissions: FileAccessPolicy = {
      system: 'none',
      workspace: 'none',
      customPaths: new Map([[p('/Users/test/readonly'), 'read']]),
    };

    expect(canAccess(p('/Users/test/readonly/file.txt'), 'read', permissions, workspacePath)).toBe(true);
    expect(canAccess(p('/Users/test/readonly/file.txt'), 'write', permissions, workspacePath)).toBe(false);
  });

  test('custom paths have highest precedence', () => {
    const permissions: FileAccessPolicy = {
      system: 'write',
      workspace: 'write',
      customPaths: new Map([[p('/Users/test/project/secrets'), 'none']]),
    };

    // Can write to workspace
    expect(canAccess(p('/Users/test/project/file.txt'), 'write', permissions, workspacePath)).toBe(true);
    // But not to blacklisted subfolder
    expect(canAccess(p('/Users/test/project/secrets/key.pem'), 'write', permissions, workspacePath)).toBe(false);
  });

  test('workspace has precedence over system', () => {
    const permissions: FileAccessPolicy = {
      system: 'none',
      workspace: 'write',
      customPaths: new Map(),
    };

    // Can write to workspace despite system being none
    expect(canAccess(p('/Users/test/project/file.txt'), 'write', permissions, workspacePath)).toBe(true);
    // Cannot access outside workspace
    expect(canAccess(p('/Users/test/other/file.txt'), 'read', permissions, workspacePath)).toBe(false);
  });

  test('system none denies all access outside workspace', () => {
    const permissions: FileAccessPolicy = {
      system: 'none',
      workspace: 'read',
      customPaths: new Map(),
    };

    expect(canAccess(p('/etc/hosts'), 'read', permissions, workspacePath)).toBe(false);
    expect(canAccess(p('/Users/test/other/file.txt'), 'read', permissions, workspacePath)).toBe(false);
  });

  test('write permission includes read permission', () => {
    const permissions: FileAccessPolicy = {
      system: 'write',
      workspace: 'none',
      customPaths: new Map(),
    };

    expect(canAccess(p('/Users/test/file.txt'), 'read', permissions, workspacePath)).toBe(true);
    expect(canAccess(p('/Users/test/file.txt'), 'write', permissions, workspacePath)).toBe(true);
  });

  test('null workspace is handled correctly', () => {
    const permissions: FileAccessPolicy = {
      system: 'read',
      workspace: 'write',
      customPaths: new Map(),
    };

    // With null workspace, workspace permission is ignored
    expect(canAccess(p('/Users/test/project/file.txt'), 'write', permissions, null)).toBe(false);
    expect(canAccess(p('/Users/test/project/file.txt'), 'read', permissions, null)).toBe(true);
  });

  test('sandbox paths follow the same global policy as any other outside path', () => {
    const permissions: FileAccessPolicy = {
      system: 'none',
      workspace: 'none',
      customPaths: new Map(),
    };
    const sandboxFile = normalizePath('/Users/test/app-sandbox/example.txt');

    expect(canAccess(sandboxFile, 'read', permissions, workspacePath)).toBe(false);
    expect(canAccess(sandboxFile, 'write', permissions, workspacePath)).toBe(false);
  });

  test('custom path rules can grant sandbox-like directories explicitly', () => {
    const sandboxDir = normalizePath('/Users/test/app-sandbox');
    const permissions: FileAccessPolicy = {
      system: 'none',
      workspace: 'none',
      customPaths: new Map([[sandboxDir, 'write']]),
    };
    const sandboxFile = normalizePath(`${sandboxDir}/locked.txt`);

    expect(canAccess(sandboxFile, 'read', permissions, workspacePath)).toBe(true);
    expect(canAccess(sandboxFile, 'write', permissions, workspacePath)).toBe(true);
  });

  test('custom path rules work for preserved slash-style absolute paths on Windows', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });

    try {
      const windowsWorkspace = 'C:\\Users\\test\\project';
      const slashStyleRoot = '/Users/test/app-sandbox';
      const permissions: FileAccessPolicy = {
        system: 'none',
        workspace: 'none',
        customPaths: new Map([[slashStyleRoot, 'write']]),
      };

      expect(canAccess('/Users/test/app-sandbox/locked.txt', 'read', permissions, windowsWorkspace)).toBe(true);
      expect(canAccess('/Users/test/app-sandbox/locked.txt', 'write', permissions, windowsWorkspace)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        writable: true,
        configurable: true,
      });
    }
  });
});

describe('canAccessAsync', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('allows real workspace paths when the opened workspace is a symlink alias', async () => {
    if (process.platform === 'win32') return;

    const root = await mkdtemp(join(tmpdir(), 'permissions-async-'));
    tempDirs.push(root);

    const realWorkspace = join(root, 'real-workspace');
    const workspaceAlias = join(root, 'workspace-alias');
    await mkdir(realWorkspace, { recursive: true });
    await symlink(realWorkspace, workspaceAlias);

    const targetPath = join(realWorkspace, 'note.md');
    await writeFile(targetPath, 'hello', 'utf-8');

    const permissions: FileAccessPolicy = {
      system: 'none',
      workspace: 'write',
      customPaths: new Map(),
    };

    await expect(canAccessAsync(targetPath, 'write', permissions, workspaceAlias)).resolves.toBe(true);
  });

  test('denies symlink escapes from inside workspace to outside targets', async () => {
    if (process.platform === 'win32') return;

    const root = await mkdtemp(join(tmpdir(), 'permissions-async-'));
    tempDirs.push(root);

    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });

    const outsideFile = join(outside, 'secret.txt');
    const escapedPath = join(workspace, 'escape.txt');
    await writeFile(outsideFile, 'sensitive', 'utf-8');
    await symlink(outsideFile, escapedPath);

    const permissions: FileAccessPolicy = {
      system: 'read',
      workspace: 'write',
      customPaths: new Map(),
    };

    await expect(canAccessAsync(escapedPath, 'write', permissions, workspace)).resolves.toBe(false);
  });
});

describe('normalizePath', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    // Restore platform after each test
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  describe('Quote and whitespace handling', () => {
    test('removes surrounding quotes', () => {
      if (process.platform === 'win32') {
        expect(normalizePath('"C:\\Users\\test\\file.txt"')).toBe('C:\\Users\\test\\file.txt');
        expect(normalizePath("'C:\\Users\\test\\file.txt'")).toBe('C:\\Users\\test\\file.txt');
      } else {
        expect(normalizePath('"/home/user/file.txt"')).toBe('/home/user/file.txt');
        expect(normalizePath("'/home/user/file.txt'")).toBe('/home/user/file.txt');
      }
    });

    test('trims whitespace', () => {
      if (process.platform === 'win32') {
        expect(normalizePath('  C:\\Users\\test\\file.txt  ')).toBe('C:\\Users\\test\\file.txt');
      } else {
        expect(normalizePath('  /home/user/file.txt  ')).toBe('/home/user/file.txt');
      }
    });

    test('handles empty paths', () => {
      expect(normalizePath('')).toBe('');
      expect(normalizePath('   ')).toBe('');
    });
  });

  describe('WSL path preservation', () => {
    test('ALWAYS preserves WSL paths - never converts them', () => {
      // WSL paths should NEVER be converted, regardless of platform
      expect(normalizePath('/mnt/c/Users/test/folder')).toBe('/mnt/c/Users/test/folder');
      expect(normalizePath('/mnt/d/Documents/project')).toBe('/mnt/d/Documents/project');
      expect(normalizePath('/mnt/c/Program Files/App')).toBe('/mnt/c/Program Files/App');
    });

    test('handles WSL paths with multiple slashes', () => {
      expect(normalizePath('/mnt/c//Users//test//file.txt')).toBe('/mnt/c/Users/test/file.txt');
    });

    test('handles WSL paths with trailing slashes', () => {
      expect(normalizePath('/mnt/c/Users/test/')).toBe('/mnt/c/Users/test');
    });
  });

  describe('Windows path handling', () => {
    test('capitalizes drive letters', () => {
      expect(normalizePath('c:\\windows\\system32')).toBe('C:\\windows\\system32');
      expect(normalizePath('d:/documents/file.txt')).toBe('D:\\documents\\file.txt');
    });

    test('normalizes forward slashes to backslashes', () => {
      expect(normalizePath('C:/Users/test/file.txt')).toBe('C:\\Users\\test\\file.txt');
      expect(normalizePath('C:/Program Files/App')).toBe('C:\\Program Files\\App');
    });

    test('handles multiple consecutive backslashes', () => {
      expect(normalizePath('C:\\\\Users\\\\test\\\\file.txt')).toBe('C:\\Users\\test\\file.txt');
    });
  });

  describe('UNC path handling', () => {
    test('preserves UNC paths with double backslash', () => {
      expect(normalizePath('\\\\server\\share\\folder')).toBe('\\\\server\\share\\folder');
      expect(normalizePath('\\\\SERVER\\Share\\File.txt')).toBe('\\\\SERVER\\Share\\File.txt');
    });

    test('normalizes excessive leading backslashes in UNC paths', () => {
      expect(normalizePath('\\\\\\\\server\\\\share\\\\folder')).toBe('\\\\server\\share\\folder');
    });

    test('normalizes double backslashes in UNC path body', () => {
      expect(normalizePath('\\\\server\\\\share\\\\folder\\\\file.txt')).toBe('\\\\server\\share\\folder\\file.txt');
    });
  });

  describe('Unix-style Windows paths', () => {
    test('converts /c/ to C:\\ on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      expect(normalizePath('/c/Users/test/file.txt')).toBe('C:\\Users\\test\\file.txt');
      expect(normalizePath('/d/Documents/project')).toBe('D:\\Documents\\project');
    });

    test('preserves /c/ as Unix path on Linux/Mac', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        writable: true,
        configurable: true
      });

      expect(normalizePath('/c/some/path')).toBe('/c/some/path');
      expect(normalizePath('/d/another/path')).toBe('/d/another/path');
    });
  });

  describe('Home directory expansion', () => {
    test('expands ~ to home directory', () => {
      const result = normalizePath('~');
      expect(result).not.toContain('~');
      expect(result.length).toBeGreaterThan(0);
    });

    test('expands ~/path to home/path', () => {
      const result = normalizePath('~/Documents/file.txt');
      expect(result).not.toContain('~');
      expect(result).toContain('Documents');
    });
  });

  describe('Unix path handling', () => {
    test('preserves regular Unix paths', () => {
      expect(normalizePath('/usr/local/bin')).toBe('/usr/local/bin');
      expect(normalizePath('/home/user/documents')).toBe('/home/user/documents');
      expect(normalizePath('/var/log/app')).toBe('/var/log/app');
    });

    test('normalizes multiple slashes in Unix paths', () => {
      expect(normalizePath('/usr//local///bin')).toBe('/usr/local/bin');
      expect(normalizePath('///home/user')).toBe('/home/user');
    });

    test('removes trailing slashes from Unix paths', () => {
      expect(normalizePath('/usr/local/bin/')).toBe('/usr/local/bin');
      expect(normalizePath('/home/user/')).toBe('/home/user');
    });

    test('preserves root slash', () => {
      expect(normalizePath('/')).toBe('/');
      expect(normalizePath('///')).toBe('/');
    });
  });

  describe('Security', () => {
    test('rejects null bytes', () => {
      expect(() => normalizePath('/path/with\x00null')).toThrow('Path contains null byte');
    });
  });
});

describe('resolvePathWithWorkspace', () => {
  const isWin = process.platform === 'win32';
  const workspacePath = isWin ? 'C:\\Users\\test\\project' : '/Users/test/project';

  describe('Absolute path detection', () => {
    test('detects Unix absolute paths', () => {
      if (isWin) {
        expect(resolvePathWithWorkspace('C:\\usr\\local\\bin', workspacePath)).toBe('C:\\usr\\local\\bin');
      } else {
        expect(resolvePathWithWorkspace('/usr/local/bin', workspacePath)).toBe('/usr/local/bin');
      }
    });

    test('detects WSL paths as absolute', () => {
      expect(resolvePathWithWorkspace('/mnt/c/Users/test', workspacePath)).toBe('/mnt/c/Users/test');
    });

    test('detects home directory paths as absolute', () => {
      const result = resolvePathWithWorkspace('~/Documents', workspacePath);
      expect(result).not.toContain('~');
    });

    test('detects Windows drive letters as absolute', () => {
      expect(resolvePathWithWorkspace('C:\\Users\\test', workspacePath)).toBe('C:\\Users\\test');
      expect(resolvePathWithWorkspace('D:/Documents', workspacePath)).toBe('D:\\Documents');
    });

    test('normalizes slash-prefixed Windows drive paths as absolute Windows paths', () => {
      const originalPlatform = process.platform;

      try {
        Object.defineProperty(process, 'platform', {
          value: 'win32',
          writable: true,
          configurable: true
        });

        expect(resolvePathWithWorkspace(
          '/C:/Users/test/project/report.md',
          'C:\\Users\\test\\project',
        )).toBe('C:\\Users\\test\\project\\report.md');
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          writable: true,
          configurable: true
        });
      }
    });

    test('detects UNC paths as absolute', () => {
      expect(resolvePathWithWorkspace('\\\\server\\share\\folder', workspacePath)).toBe('\\\\server\\share\\folder');
    });
  });

  describe('Relative path resolution', () => {
    test('resolves relative paths with workspace', () => {
      const result = resolvePathWithWorkspace('src/index.ts', workspacePath);
      expect(result).toContain('project');
      expect(result).toContain('src');
    });

    test('throws error for relative paths without workspace', () => {
      expect(() => resolvePathWithWorkspace('src/index.ts', null))
        .toThrow('Cannot resolve relative path');
    });
  });

  describe('Quote handling', () => {
    test('removes quotes from paths before processing', () => {
      if (isWin) {
        expect(resolvePathWithWorkspace('"C:\\Users\\test\\file.txt"', workspacePath))
          .toBe('C:\\Users\\test\\file.txt');
      } else {
        expect(resolvePathWithWorkspace('"/usr/local/bin"', workspacePath))
          .toBe('/usr/local/bin');
      }
    });
  });
});
