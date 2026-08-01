import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Markdown } from './markdown';
import { clearFileCache, setFileCache } from '../../../src/stores/fileStore';

describe('agent markdown file mentions', () => {
  test('renders serialized pasted-content blocks as chips instead of placeholder text', () => {
    const markdown = [
      '"',
      '<pasted-content label="Pasted (2 lines)">',
      'alpha',
      'beta',
      '</pasted-content>',
      '" mattered',
    ].join('\n');

    const html = renderToStaticMarkup(React.createElement(Markdown, null, markdown));

    assert.match(html, /composer-attachment-chip/);
    assert.match(html, /Pasted \(2 lines\)/);
    assert.match(html, /mattered/);
    assert.doesNotMatch(html, /INTERPRETERPASTEDCONTENTTOKEN/);
    assert.doesNotMatch(html, /&lt;pasted-content/);
  });

  test('renders file URL links with spaces in paragraph content as mentions', () => {
    const markdown = `Based on my scan at [/Users/example/Documents/My Workspace](file:///Users/example/Documents/My Workspace), I found files.`;
    const html = renderToStaticMarkup(React.createElement(Markdown, null, markdown));

    assert.match(html, /mention-node-view/);
    assert.match(html, /data-path=\"\/Users\/example\/Documents\/My Workspace\"/);
    assert.doesNotMatch(html, /\[\/Users\/example\/Documents\/My Workspace\]\(file:\/\/\/Users\/example\/Documents\/My Workspace\)/);
  });

  test('renders file URL links with spaces inside table cells as mentions', () => {
    const markdown = [
      '| # | File | Size |',
      '| --- | --- | --- |',
      '| 1 | [As we may think.pdf](file:///Users/example/Documents/My Workspace/As%20we%20may%20think.pdf) | 44 KB |',
    ].join('\n');
    const html = renderToStaticMarkup(React.createElement(Markdown, null, markdown));

    assert.match(html, /mention-node-view/);
    assert.match(html, /data-path=\"\/Users\/example\/Documents\/My Workspace\/As we may think\.pdf\"/);
    assert.match(html, /whitespace-normal/);
    assert.match(html, /overflow-wrap:anywhere/);
    assert.doesNotMatch(html, /\[As we may think\.pdf\]\(file:\/\/\/Users\/example\/Documents\/My Workspace\/As%20we%20may%20think\.pdf\)/);
  });

  test('treats extensionless markdown note targets as file mentions, not directories', () => {
    const html = renderToStaticMarkup(
      React.createElement(Markdown, { renderFileCollections: false }, '[cost_model](cost_model.md)'),
    );

    assert.match(html, /data-path=\"cost_model\.md\"/);
    assert.match(html, /data-type=\"file\"/);
    assert.doesNotMatch(html, /data-type=\"directory\"/);
  });

  test('normalizes markdown note labels in inline mentions', () => {
    const html = renderToStaticMarkup(React.createElement(Markdown, null, 'See [README.md](/tmp/README.md) now.'));

    assert.match(html, /data-path=\"\/tmp\/README\.md\"/);
    assert.match(html, />README<\/span>/);
    assert.doesNotMatch(html, />README\.md<\/span>/);
  });

  test('renders wikilinks with the same normalized note label and heading suffix as file mentions', () => {
    const globalObject = globalThis as any;
    const previousWindow = globalObject.window;

    try {
      globalObject.window = previousWindow ?? new EventTarget();
      globalObject.window.__layoutContext = { workspacePath: '/workspace' };
      setFileCache([
        {
          path: '/workspace/wiki/README.md',
          name: 'README.md',
          type: 'file',
        },
      ]);

      const html = renderToStaticMarkup(
        React.createElement(Markdown, null, 'See [[wiki/README.md#intro]] now.'),
      );

      assert.match(html, /data-path=\"\/workspace\/wiki\/README\.md\"/);
      assert.match(html, />README<\/span>/);
      assert.match(html, /#intro/);
      assert.doesNotMatch(html, />README\.md#intro<\/span>/);
    } finally {
      clearFileCache();
      globalObject.window = previousWindow;
    }
  });

  test('renders file-first bullet lists with details as a rich file list', () => {
    const markdown = [
      '- [As we may think.pdf](file:///Users/example/Documents/My Workspace/As%20we%20may%20think.pdf) - primary reference document',
      '- [Sierra.jpeg](file:///Users/example/Documents/My Workspace/Sierra.jpeg) - image used for the preview',
    ].join('\n');
    const html = renderToStaticMarkup(React.createElement(Markdown, null, markdown));

    assert.match(html, /primary reference document/);
    assert.match(html, /image used for the preview/);
    assert.match(html, /rounded-\[18px\]/);
    assert.doesNotMatch(html, /<ul/);
  });

  test('preserves underscores in file labels inside rich file lists', () => {
    const markdown = '- [foo_bar_baz.png](/tmp/foo_bar_baz.png) - detailed preview';
    const html = renderToStaticMarkup(React.createElement(Markdown, null, markdown));

    assert.match(html, /foo_bar_baz\.png/);
    assert.doesNotMatch(html, />foo<\/div>/);
  });

  test('renders list items with prefix text and short file labels as rich file rows using the real basename', () => {
    const markdown = [
      '- Primary route: [01](/tmp/01_registration-frame_recraft.png)',
      '- Secondary route: [07](/tmp/07_perception-window_recraft.png)',
    ].join('\n');
    const html = renderToStaticMarkup(React.createElement(Markdown, null, markdown));

    assert.match(html, /01_registration-frame_recraft\.png/);
    assert.match(html, /07_perception-window_recraft\.png/);
    assert.match(html, /Primary route:/);
    assert.match(html, /Secondary route:/);
    assert.doesNotMatch(html, />01<\/div>/);
    assert.doesNotMatch(html, />07<\/div>/);
  });

  test('renders file-first bullets with nested child bullets as rich file rows', () => {
    const markdown = [
      '- [/tmp/project](/tmp/project)',
      '  - package.json',
      '  - src/',
      '- [/tmp/assets](/tmp/assets)',
      '  - moodboard',
      '  - references',
    ].join('\n');
    const html = renderToStaticMarkup(React.createElement(Markdown, null, markdown));

    assert.match(html, /package\.json/);
    assert.match(html, /moodboard/);
    assert.match(html, /rounded-\[18px\]/);
    assert.doesNotMatch(html, /<ul/);
  });

  test('renders numbered file review lists with nested notes as rich file rows with ordinals', () => {
    const markdown = [
      '1. [README.md](/tmp/README.md)',
      '   - overall project overview',
      '   - launch concept',
      '2. [src](/tmp/src)',
      '   - active composition code',
    ].join('\n');
    const html = renderToStaticMarkup(React.createElement(Markdown, null, markdown));

    assert.match(html, /README\.md/);
    assert.match(html, /overall project overview/);
    assert.match(html, />1<\/span>/);
    assert.match(html, />2<\/span>/);
    assert.doesNotMatch(html, /<ol/);
  });
});
