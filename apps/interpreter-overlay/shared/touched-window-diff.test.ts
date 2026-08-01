import { describe, expect, test } from 'bun:test';

import { diffTouchedWindows, formatTouchedWindowDiff } from './touched-window-diff';

const BEFORE = [
  '<window name="Quick form">',
  '  <input id="ref:1" name="Full name" focused caret/>',
  '  <input id="ref:2" name="Department"/>',
  '  <checkbox id="ref:3" name="Confirmed"/>',
  '  <button id="ref:4">Submit</button>',
  '</window>',
].join('\n');

const AFTER = [
  '<window name="Quick form">',
  '  <input id="ref:1" name="Full name">Ada Lovelace</input>',
  '  <input id="ref:2" name="Department" focused caret>Operations</input>',
  '  <checkbox id="ref:3" name="Confirmed" checked/>',
  '  <button id="ref:4">Submit</button>',
  '</window>',
].join('\n');

describe('diffTouchedWindows', () => {
  test('reports only observed changed lines per touched window', () => {
    const diff = diffTouchedWindows({ formattedText: BEFORE }, { formattedText: AFTER });

    expect(diff.changed).toBe(true);
    expect(diff.windows).toHaveLength(1);
    const window = diff.windows[0];
    expect(window.window).toBe('<window name="Quick form">');
    expect(window.status).toBe('changed');
    // Values set, focus moved, and checkbox checked all surface as raw
    // observed line changes; the unchanged Submit button is omitted.
    expect(window.removedLines).toEqual([
      '  <input id="ref:1" name="Full name" focused caret/>',
      '  <input id="ref:2" name="Department"/>',
      '  <checkbox id="ref:3" name="Confirmed"/>',
    ]);
    expect(window.addedLines).toEqual([
      '  <input id="ref:1" name="Full name">Ada Lovelace</input>',
      '  <input id="ref:2" name="Department" focused caret>Operations</input>',
      '  <checkbox id="ref:3" name="Confirmed" checked/>',
    ]);
  });

  test('reports no change when the observed window text is identical', () => {
    const diff = diffTouchedWindows({ formattedText: BEFORE }, { formattedText: BEFORE });
    expect(diff.changed).toBe(false);
    expect(diff.windows).toEqual([]);
    expect(formatTouchedWindowDiff(diff)).toContain('no_observed_change');
  });

  test('reports appeared and removed windows with their observed lines', () => {
    const diff = diffTouchedWindows(
      {
        formattedText: [
          '<window name="Quick form">',
          '  <button id="ref:4">Submit</button>',
          '</window>',
        ].join('\n'),
      },
      {
        formattedText: [
          '<window name="Quick form">',
          '  <button id="ref:4">Submit</button>',
          '</window>',
          '<window name="Save dialog">',
          '  <button id="ref:9">Save</button>',
          '</window>',
        ].join('\n'),
      },
    );

    expect(diff.windows).toEqual([{
      window: '<window name="Save dialog">',
      status: 'appeared',
      removedLines: [],
      addedLines: ['  <button id="ref:9">Save</button>'],
    }]);

    const reversed = diffTouchedWindows(
      {
        formattedText: [
          '<window name="Save dialog">',
          '  <button id="ref:9">Save</button>',
          '</window>',
        ].join('\n'),
      },
      { formattedText: '' },
    );
    expect(reversed.windows).toEqual([{
      window: '<window name="Save dialog">',
      status: 'removed',
      removedLines: ['  <button id="ref:9">Save</button>'],
      addedLines: [],
    }]);
  });

  test('handles nested window tags and lines outside window blocks', () => {
    const before = [
      'orphan line',
      '<window name="Outer">',
      '  <window name="Inner">',
      '    <text>old</text>',
      '  </window>',
      '</window>',
    ].join('\n');
    const after = [
      'orphan line changed',
      '<window name="Outer">',
      '  <window name="Inner">',
      '    <text>new</text>',
      '  </window>',
      '</window>',
    ].join('\n');

    const diff = diffTouchedWindows({ formattedText: before }, { formattedText: after });
    expect(diff.windows.map((window) => window.window)).toEqual([
      '(outside window blocks)',
      '<window name="Outer">',
    ]);
    const outer = diff.windows[1];
    expect(outer.removedLines).toEqual(['    <text>old</text>']);
    expect(outer.addedLines).toEqual(['    <text>new</text>']);
  });

  test('diffs observed selected-target ref lines as their own block', () => {
    const diff = diffTouchedWindows(
      {
        formattedText: BEFORE,
        selectableRefLines: [
          'ref id="element_index:19" role="AXTextField" label="- [19] AXTextField \\"Full name\\""',
          'ref id="element_index:26" role="AXButton" label="- [26] AXButton \\"Submit\\""',
        ],
      },
      {
        // The formatted text capture raced the app update; the selected-ref
        // read still observed the set value.
        formattedText: BEFORE,
        selectableRefLines: [
          'ref id="element_index:19" role="AXTextField" label="- [19] AXTextField \\"Full name\\" value=\\"Ada Lovelace\\""',
          'ref id="element_index:26" role="AXButton" label="- [26] AXButton \\"Submit\\""',
        ],
      },
    );

    expect(diff.windows).toEqual([{
      window: '(selected target refs)',
      status: 'changed',
      removedLines: ['ref id="element_index:19" role="AXTextField" label="- [19] AXTextField \\"Full name\\""'],
      addedLines: ['ref id="element_index:19" role="AXTextField" label="- [19] AXTextField \\"Full name\\" value=\\"Ada Lovelace\\""'],
    }]);
  });

  test('treats a self-closing childless window line as a window block, not stray lines', () => {
    const diff = diffTouchedWindows({ formattedText: BEFORE }, { formattedText: '<window/>' });
    expect(diff.windows.map((window) => [window.window, window.status])).toEqual([
      ['<window name="Quick form">', 'removed'],
      ['<window/>', 'appeared'],
    ]);
    expect(diff.windows[1].addedLines).toEqual([]);
  });

  test('formats a model-facing diff block with +/- lines and the read-tool pointer', () => {
    const text = formatTouchedWindowDiff(diffTouchedWindows({ formattedText: BEFORE }, { formattedText: AFTER }));
    expect(text).toContain('<touched_window_diff>');
    expect(text).toContain('<window_diff window="<window name=\\"Quick form\\">" status="changed">');
    expect(text).toContain('- <input id="ref:1" name="Full name" focused caret/>');
    expect(text).toContain('+ <input id="ref:1" name="Full name">Ada Lovelace</input>');
    expect(text).toContain('call overlay_read_context');
    expect(text).not.toContain('Submit</button>\n+');
  });
});
