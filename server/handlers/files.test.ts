import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createFile,
  isDirectory,
  listDirectory,
  normalizeTrashPath,
  readBinaryFile,
  readTextFile,
  trashFile,
  writeBinaryFile,
  writeTextFile,
} from './files';

async function withTempPath<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'interpreter-files-handler-'));

  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('isDirectory', () => {
  test('returns true for directories', async () => {
    await withTempPath(async (root) => {
      const dirPath = path.join(root, 'folder');
      await mkdir(dirPath);

      expect(await isDirectory(dirPath)).toBe(true);
    });
  });

  test('returns false for regular files', async () => {
    await withTempPath(async (root) => {
      const filePath = path.join(root, 'note.md');
      await writeFile(filePath, '# hi\n', 'utf8');

      expect(await isDirectory(filePath)).toBe(false);
    });
  });
});

describe('listDirectory', () => {
  test('should_skip_broken_children_and_return_remaining_entries', async () => {
    await withTempPath(async (root) => {
      await mkdir(path.join(root, 'folder'));
      await writeFile(path.join(root, 'file.txt'), 'hello');
      await symlink(path.join(root, 'missing-target'), path.join(root, 'broken-link'));

      const result = await listDirectory(root);

      expect(result.success).toBe(true);
      expect(result.entries).toEqual([
        {
          name: 'folder',
          path: path.join(root, 'folder'),
          type: 'directory',
        },
        {
          name: 'file.txt',
          path: path.join(root, 'file.txt'),
          type: 'file',
          mtime: expect.any(Number),
        },
      ]);
    });
  });

  test('marks runnable node web app folders when package.json exposes a run script', async () => {
    await withTempPath(async (root) => {
      const appDir = path.join(root, 'graph-app');
      await mkdir(appDir);
      await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
        name: 'graph-app',
        private: true,
        scripts: {
          start: 'node server.mjs',
        },
      }, null, 2));

      const result = await listDirectory(root);

      expect(result.success).toBe(true);
      expect(result.entries).toEqual([
        {
          name: 'graph-app',
          path: appDir,
          type: 'directory',
          runnableProject: {
            kind: 'node-web-app',
            runScript: 'start',
          },
        },
      ]);
    });
  });
});

describe('desktop file operations', () => {
  const originalPlatform = process.platform;
  const urlPathname = '/C:/Users/example/Documents/My Workspace (2)';
  const windowsPath = 'C:\\Users\\example\\Documents\\My Workspace (2)';

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    mock.restore();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  test('normalizes slash-prefixed Windows drive paths before text reads', async () => {
    const readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValueOnce('report body');

    await expect(readTextFile(`${urlPathname}/report.md`)).resolves.toEqual({
      content: 'report body',
    });

    expect(readFileSpy).toHaveBeenCalledWith(
      `${windowsPath}\\report.md`,
      'utf-8',
    );
  });

  test('normalizes slash-prefixed Windows drive paths before binary reads', async () => {
    const buffer = Buffer.from('report body');
    const readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValueOnce(buffer);

    await expect(readBinaryFile(`${urlPathname}/report.pdf`)).resolves.toEqual({
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    });

    expect(readFileSpy).toHaveBeenCalledWith(
      `${windowsPath}\\report.pdf`,
    );
  });

  test('normalizes slash-prefixed Windows drive paths before text writes', async () => {
    const writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValueOnce(undefined);

    await expect(writeTextFile(`${urlPathname}/report.md`, 'report body')).resolves.toEqual({
      success: true,
    });

    expect(writeFileSpy).toHaveBeenCalledWith(
      `${windowsPath}\\report.md`,
      'report body',
      'utf-8',
    );
  });

  test('normalizes slash-prefixed Windows drive paths before binary writes', async () => {
    const content = new Uint8Array([1, 2, 3]);
    const writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValueOnce(undefined);

    await expect(writeBinaryFile(`${urlPathname}/report.pdf`, content)).resolves.toEqual({
      success: true,
    });

    expect(writeFileSpy).toHaveBeenCalledWith(
      `${windowsPath}\\report.pdf`,
      content,
    );
  });

  test('normalizes Windows extended-length paths before trashing', () => {
    expect(
      normalizeTrashPath('\\\\?\\C:\\Users\\liu\\AppData\\Roaming\\interpreter\\codex-home\\sessions\\thread.jsonl'),
    ).toBe('C:\\Users\\liu\\AppData\\Roaming\\interpreter\\codex-home\\sessions\\thread.jsonl');

    expect(
      normalizeTrashPath('\\\\?\\UNC\\server\\share\\thread.jsonl'),
    ).toBe('\\\\server\\share\\thread.jsonl');

    expect(
      normalizeTrashPath('\\\\?\\Volume{1234}\\thread.jsonl'),
    ).toBe('\\\\?\\Volume{1234}\\thread.jsonl');
  });

  test('keeps Windows extended-length-looking paths unchanged off Windows', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true,
    });

    expect(
      normalizeTrashPath('\\\\?\\C:\\Users\\liu\\AppData\\Roaming\\interpreter\\codex-home\\sessions\\thread.jsonl'),
    ).toBe('\\\\?\\C:\\Users\\liu\\AppData\\Roaming\\interpreter\\codex-home\\sessions\\thread.jsonl');
  });

  test('trashes normalized Windows extended-length paths', async () => {
    const rmSpy = spyOn(fsPromises, 'rm').mockResolvedValueOnce(undefined);

    await expect(
      trashFile('\\\\?\\C:\\Users\\liu\\AppData\\Roaming\\interpreter\\codex-home\\sessions\\thread.jsonl'),
    ).resolves.toEqual({ success: true });

    expect(rmSpy).toHaveBeenCalledWith(
      'C:\\Users\\liu\\AppData\\Roaming\\interpreter\\codex-home\\sessions\\thread.jsonl',
      { recursive: true },
    );
  });
});

describe('createFile', () => {
  const originalElectronVersion = process.versions.electron;

  afterEach(() => {
    mock.restore();
    if (originalElectronVersion === undefined) {
      delete process.versions.electron;
      return;
    }
    Object.defineProperty(process.versions, 'electron', {
      value: originalElectronVersion,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  });

  test('creates a movie project folder with a manifest and assets directory', async () => {
    await withTempPath(async (root) => {
      const result = await createFile('movie', root);

      expect(result.success).toBe(true);
      expect(result.path).toBeDefined();

      const manifestPath = result.path!;
      expect(path.extname(manifestPath)).toBe('.movie');

      const projectDir = path.dirname(manifestPath);
      const projectName = path.basename(projectDir);
      const assetsDir = path.join(projectDir, 'assets');
      const metadataDir = path.join(projectDir, 'meta');
      const rendersDir = path.join(projectDir, 'renders');
      const timelinePath = path.join(projectDir, 'timeline.tsx');
      const componentsPath = path.join(projectDir, 'components.tsx');
      const runtimePath = path.join(projectDir, 'movie-runtime.tsx');
      const entryPointPath = path.join(projectDir, 'index.ts');

      const manifestContent = await readFile(manifestPath, 'utf8');
      expect(JSON.parse(manifestContent)).toEqual({
        version: 2,
        name: projectName,
        assetsDir: 'assets',
        metadataDir: 'meta',
        rendersDir: 'renders',
        timelinePath: 'timeline.tsx',
        componentsPath: 'components.tsx',
        runtimePath: 'movie-runtime.tsx',
        entryPoint: 'index.ts',
      });

      expect((await stat(assetsDir)).isDirectory()).toBe(true);
      expect((await stat(metadataDir)).isDirectory()).toBe(true);
      expect((await stat(rendersDir)).isDirectory()).toBe(true);
      expect((await stat(timelinePath)).isFile()).toBe(true);
      expect((await stat(componentsPath)).isFile()).toBe(true);
      expect((await stat(runtimePath)).isFile()).toBe(true);
      expect((await stat(entryPointPath)).isFile()).toBe(true);
      expect(await readdir(assetsDir)).toEqual([]);
    });
  });

  test('rejects movie project creation in packaged Electron builds', async () => {
    Object.defineProperty(process.versions, 'electron', {
      value: '99.0.0',
      configurable: true,
      enumerable: true,
      writable: true,
    });
    mock.module('electron', () => ({
      app: {
        isPackaged: true,
      },
    }));

    await withTempPath(async (root) => {
      const result = await createFile('movie', root);
      expect(result).toEqual({
        success: false,
        error: 'Movie projects are only available in development mode',
      });
    });
  });
});
