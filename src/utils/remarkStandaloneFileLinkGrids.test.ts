import { describe, expect, test } from 'bun:test';

import { transformStandaloneFileLinkGrids } from './remarkStandaloneFileLinkGrids';

function fileLink(path: string, displayText = path, type: 'file' | 'directory' = 'file') {
  return {
    type: 'fileLink',
    data: {
      hProperties: {
        'data-path': path,
        'data-type': type,
        'data-display-text': displayText,
      },
    },
  };
}

describe('transformStandaloneFileLinkGrids', () => {
  test('converts a single mention-only paragraph into a grid node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [fileLink('/tmp/a.png', 'a.png')],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].type).toBe('fileLinkGrid');
    expect(tree.children[0].data.hProperties['data-items']).toContain('/tmp/a.png');
  });

  test('converts newline-separated mention-only paragraphs into one grid node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            fileLink('/tmp/a.png', 'a.png'),
            { type: 'break' },
            fileLink('/tmp/b.png', 'b.png'),
          ],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    const items = JSON.parse(tree.children[0].data.hProperties['data-items']);
    expect(tree.children[0].type).toBe('fileLinkGrid');
    expect(items).toEqual([
      expect.objectContaining({ path: '/tmp/a.png', displayText: 'a.png' }),
      expect.objectContaining({ path: '/tmp/b.png', displayText: 'b.png' }),
    ]);
  });

  test('converts unordered lists of standalone mentions into a grid node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [fileLink('/tmp/a.png', 'a.png')] }],
            },
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [fileLink('/tmp/b.png', 'b.png')] }],
            },
          ],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    const items = JSON.parse(tree.children[0].data.hProperties['data-items']);
    expect(tree.children[0].type).toBe('fileLinkGrid');
    expect(items).toHaveLength(2);
  });

  test('converts newline-separated file mentions with trailing details into a file list node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            fileLink('/tmp/a.png', 'a.png'),
            { type: 'text', value: ' - hero image for the landing page' },
            { type: 'break' },
            fileLink('/tmp/b.png', 'b.png'),
            { type: 'text', value: ': cropped variant for social preview' },
          ],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    const items = JSON.parse(tree.children[0].data.hProperties['data-items']);
    expect(tree.children[0].type).toBe('fileLinkList');
    expect(items).toEqual([
      expect.objectContaining({ path: '/tmp/a.png', detailText: 'hero image for the landing page' }),
      expect.objectContaining({ path: '/tmp/b.png', detailText: 'cropped variant for social preview' }),
    ]);
  });

  test('converts unordered lists with file-first details into a file list node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [fileLink('/tmp/a.png', 'a.png'), { type: 'text', value: ' - first draft' }] }],
            },
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [fileLink('/tmp/b.png', 'b.png'), { type: 'text', value: ' - final export' }] }],
            },
          ],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    const items = JSON.parse(tree.children[0].data.hProperties['data-items']);
    expect(tree.children[0].type).toBe('fileLinkList');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(expect.objectContaining({ detailText: 'first draft' }));
  });

  test('converts unordered lists with text before a file link into a file list node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Primary route: ' }, fileLink('/tmp/01_registration-frame_recraft.png', '01')] }],
            },
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Secondary route: ' }, fileLink('/tmp/07_perception-window_recraft.png', '07')] }],
            },
          ],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    const items = JSON.parse(tree.children[0].data.hProperties['data-items']);
    expect(tree.children[0].type).toBe('fileLinkList');
    expect(items[0]).toEqual(expect.objectContaining({ detailText: 'Primary route:' }));
    expect(items[1]).toEqual(expect.objectContaining({ detailText: 'Secondary route:' }));
  });

  test('converts unordered lists with a standalone file link plus nested bullets into a file list node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              children: [
                { type: 'paragraph', children: [fileLink('/tmp/project', 'project', 'directory')] },
                {
                  type: 'list',
                  ordered: false,
                  children: [
                    {
                      type: 'listItem',
                      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'package.json' }] }],
                    },
                    {
                      type: 'listItem',
                      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'src/' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    const items = JSON.parse(tree.children[0].data.hProperties['data-items']);
    expect(tree.children[0].type).toBe('fileLinkList');
    expect(items[0]).toEqual(expect.objectContaining({
      path: '/tmp/project',
      detailText: '- package.json\n- src/',
    }));
  });

  test('converts ordered lists of file links with nested notes into a file list node and preserves ordinals', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: true,
          start: 3,
          children: [
            {
              type: 'listItem',
              children: [
                { type: 'paragraph', children: [fileLink('/tmp/README.md', 'README.md')] },
                { type: 'paragraph', children: [{ type: 'text', value: 'overall project overview' }] },
              ],
            },
            {
              type: 'listItem',
              children: [
                { type: 'paragraph', children: [fileLink('/tmp/src', 'src', 'directory')] },
                {
                  type: 'list',
                  ordered: false,
                  children: [
                    {
                      type: 'listItem',
                      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'composition code' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    const items = JSON.parse(tree.children[0].data.hProperties['data-items']);
    expect(tree.children[0].type).toBe('fileLinkList');
    expect(items).toEqual([
      expect.objectContaining({ path: '/tmp/README.md', ordinal: 3, detailText: 'overall project overview' }),
      expect.objectContaining({ path: '/tmp/src', ordinal: 4, detailText: '- composition code' }),
    ]);
  });

  test('converts ordered lists of standalone file links into a file list node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: true,
          children: [
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [fileLink('/tmp/a.png', 'a.png')] }],
            },
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [fileLink('/tmp/b.png', 'b.png')] }],
            },
          ],
        },
      ],
    };

    transformStandaloneFileLinkGrids(tree);

    const items = JSON.parse(tree.children[0].data.hProperties['data-items']);
    expect(tree.children[0].type).toBe('fileLinkList');
    expect(items).toEqual([
      expect.objectContaining({ path: '/tmp/a.png', ordinal: 1 }),
      expect.objectContaining({ path: '/tmp/b.png', ordinal: 2 }),
    ]);
  });

  test('keeps inline mentions in normal paragraphs', () => {
    const paragraph = {
      type: 'paragraph',
      children: [
        { type: 'text', value: 'Open ' },
        fileLink('/tmp/a.png', 'a.png'),
        { type: 'text', value: ' please' },
      ],
    };
    const tree = { type: 'root', children: [paragraph] };

    transformStandaloneFileLinkGrids(tree);

    expect(tree.children[0]).toBe(paragraph);
  });

  test('keeps ordered lists unchanged', () => {
    const list = {
      type: 'list',
      ordered: true,
      children: [
        {
          type: 'listItem',
          children: [{ type: 'paragraph', children: [{ type: 'text', value: 'plain text item' }] }],
        },
      ],
    };
    const tree = { type: 'root', children: [list] };

    transformStandaloneFileLinkGrids(tree);

    expect(tree.children[0]).toBe(list);
  });
});
