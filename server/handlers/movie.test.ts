import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildDefaultMovieExportPath, compileMovieComponentsModule, createMovieProjectFile } from './movie';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'movie-handler-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('movie handlers', () => {
  test('builds the default export path inside renders with a sanitized mp4 filename', () => {
    const manifestPath = path.join('/tmp', 'Movie', 'Movie.movie');
    const outputPath = buildDefaultMovieExportPath(
      manifestPath,
      {
        name: 'My Test Movie!',
        rendersDir: 'renders',
      },
      1234567890,
    );

    expect(outputPath).toBe(path.join('/tmp', 'Movie', 'renders', 'my-test-movie-1234567890.mp4'));
  });

  test('compiles project components into a preview bundle', async () => {
    const workspaceDir = await makeTempDir();
    const creation = await createMovieProjectFile(workspaceDir);

    expect(creation.success).toBe(true);
    expect(creation.path).toBeTruthy();

    const manifestPath = creation.path as string;
    const projectDir = path.dirname(manifestPath);
    const componentsPath = path.join(projectDir, 'components.tsx');

    await fs.writeFile(
      componentsPath,
      `import React from 'react';
import { MovieSequence, useMovieFrame } from './movie-runtime';

const PreviewBadge: React.FC<{ label?: string }> = ({ label = 'Preview' }) => {
  const frame = useMovieFrame();
  return (
    <MovieSequence layout="none">
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontSize: 48,
        }}
      >
        {label}-{frame}
      </div>
    </MovieSequence>
  );
};

export const movieReactComponents = {
  PreviewBadge,
};
`,
      'utf8',
    );

    const compiled = await compileMovieComponentsModule({ manifestPath });

    expect(compiled.success).toBe(true);
    expect(compiled.code).toContain('movieReactComponents');
    expect(compiled.code).toContain('MovieStage');
    expect(compiled.code).toContain('__INTERPRETER_MOVIE_PREVIEW');
  });
});
