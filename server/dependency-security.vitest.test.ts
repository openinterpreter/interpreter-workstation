import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requireFromHere = createRequire(import.meta.url);

function resolveNutJsImageDependencies(): {
  fileTypeEntry: string;
  requireFromShared: NodeJS.Require;
} {
  const requireFromNut = createRequire(requireFromHere.resolve('@nut-tree-fork/nut-js'));
  const requireFromProviderInterfaces = createRequire(
    requireFromNut.resolve('@nut-tree-fork/provider-interfaces'),
  );
  const requireFromShared = createRequire(
    requireFromProviderInterfaces.resolve('@nut-tree-fork/shared'),
  );
  const requireFromJimp = createRequire(requireFromShared.resolve('jimp'));
  const requireFromJimpCore = createRequire(requireFromJimp.resolve('@jimp/core'));

  return {
    fileTypeEntry: requireFromJimpCore.resolve('file-type'),
    requireFromShared,
  };
}

describe('patched production dependencies', () => {
  it('does not hang while inspecting a malformed ASF buffer', () => {
    const { fileTypeEntry } = resolveNutJsImageDependencies();
    const fileTypePackage = JSON.parse(
      readFileSync(join(dirname(fileTypeEntry), 'package.json'), 'utf8'),
    ) as { version: string };
    const probe = `
      const { pathToFileURL } = require('node:url');
      import(pathToFileURL(process.argv[1]).href).then(({ fileTypeFromBuffer }) => {
        const malformedAsf = Buffer.from(
          '3026b2758e66cf11a6d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
          'hex',
        );
        return fileTypeFromBuffer(malformedAsf);
      }).then(() => {
        process.stdout.write('completed');
      });
    `;

    const output = execFileSync(process.execPath, ['-e', probe, fileTypeEntry], {
      encoding: 'utf8',
      timeout: 2_000,
    });

    expect(fileTypePackage.version).toBe('21.3.4');
    expect(output).toBe('completed');
  });

  it('keeps Jimp image detection working with the secure file-type API', async () => {
    const { requireFromShared } = resolveNutJsImageDependencies();
    const jimpModule = requireFromShared('jimp') as {
      default?: { read: (buffer: Buffer) => Promise<{ bitmap: { width: number; height: number } }> };
      read?: (buffer: Buffer) => Promise<{ bitmap: { width: number; height: number } }>;
    };
    const Jimp = jimpModule.default ?? jimpModule;
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    const image = await Jimp.read(onePixelPng);

    expect(image.bitmap).toMatchObject({ width: 1, height: 1 });
  });
});
