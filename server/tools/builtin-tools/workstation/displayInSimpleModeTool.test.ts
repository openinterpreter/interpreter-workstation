import { beforeEach, describe, expect, test } from 'bun:test';
import { clearSimplePresentation, readSimplePresentation } from '../../../simplePresentation';
import { displayInSimpleModeTool } from './displayInSimpleModeTool';

describe('display_in_simple_mode', () => {
  beforeEach(() => clearSimplePresentation());

  test('publishes an intentional rich drawer presentation', async () => {
    const result = await displayInSimpleModeTool.handler({
      kind: 'image',
      title: 'Finished image',
      text: 'A deliberately expanded result.',
      asset: 'result.webp',
    }, {} as never);

    expect(result.isError).toBe(false);
    expect(readSimplePresentation()).toMatchObject({
      kind: 'image',
      title: 'Finished image',
      text: 'A deliberately expanded result.',
      asset: 'result.webp',
    });
  });

  test('rejects paths and unsupported image names', async () => {
    const result = await displayInSimpleModeTool.handler({
      kind: 'image',
      title: 'Unsafe image',
      asset: '../outside.png',
    }, {} as never);
    expect(result.isError).toBe(true);
    expect(readSimplePresentation()).toBeNull();
  });
});
