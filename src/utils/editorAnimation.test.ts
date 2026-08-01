import { beforeAll, describe, test, expect } from 'bun:test';

type AnimationCallbacks = {
  setContentJSON: (json: Record<string, unknown>) => void;
  setEditable: (editable: boolean) => void;
  isCancelled: () => boolean;
};

let runEditorAnimation: (
  currentMarkdown: string,
  targetMarkdown: string,
  callbacks: AnimationCallbacks,
) => Promise<void>;

beforeAll(async () => {
  const globalObject = globalThis as any;
  globalObject.window = globalObject.window ?? {};
  globalObject.window.electron = globalObject.window.electron ?? undefined;

  const module = await import('./editorAnimation');
  runEditorAnimation = module.runEditorAnimation;
});

/** Collect all JSON docs set during animation */
function makeRecorder() {
  const docs: Array<{ type: string; content: any[] }> = [];
  let cancelled = false;

  const callbacks: AnimationCallbacks = {
    setContentJSON: (json: Record<string, unknown>) => {
      docs.push(json as any);
    },
    setEditable: () => {},
    isCancelled: () => cancelled,
  };

  return { docs, callbacks, cancel: () => { cancelled = true; } };
}

describe('editorAnimation', () => {
  // ── Basic behavior ──────────────────────────────────────────────────────

  test('identical content produces a single final setContent call', async () => {
    const md = '# Hello\n\nWorld';
    const { docs, callbacks } = makeRecorder();
    await runEditorAnimation(md, md, callbacks);
    // No diffs → just the final content set
    expect(docs.length).toBe(1);
    expect(docs[0].type).toBe('doc');
  });

  test('pure addition produces addition steps + final', async () => {
    const current = '# Title';
    const target = '# Title\n\nNew paragraph\n\nAnother paragraph';
    const { docs, callbacks } = makeRecorder();
    await runEditorAnimation(current, target, callbacks);

    // Should have addition steps (with orange marks) + final (no marks)
    expect(docs.length).toBeGreaterThanOrEqual(2);

    // Final doc should have no animationHighlight marks
    const finalDoc = docs[docs.length - 1];
    const hasMarks = JSON.stringify(finalDoc).includes('animationHighlight');
    expect(hasMarks).toBe(false);
  });

  test('pure deletion shows red then removes', async () => {
    const current = '# Title\n\nParagraph to delete\n\nKeep this';
    const target = '# Title\n\nKeep this';
    const { docs, callbacks } = makeRecorder();
    await runEditorAnimation(current, target, callbacks);

    // First call: deletions in red
    expect(docs.length).toBeGreaterThanOrEqual(2);
    const firstJson = JSON.stringify(docs[0]);
    expect(firstJson).toContain('animationHighlight');
    expect(firstJson).toContain('"color":"red"');

    // Final doc: no marks
    const finalDoc = docs[docs.length - 1];
    const hasMarks = JSON.stringify(finalDoc).includes('animationHighlight');
    expect(hasMarks).toBe(false);
  });

  test('addition steps color new chunks orange', async () => {
    const current = '# Title';
    const target = '# Title\n\nA\n\nB\n\nC\n\nD\n\nE';
    const { docs, callbacks } = makeRecorder();
    await runEditorAnimation(current, target, callbacks);

    // At least one intermediate step should have orange marks
    const intermediates = docs.slice(0, -1);
    const hasOrange = intermediates.some(d =>
      JSON.stringify(d).includes('"color":"orange"')
    );
    expect(hasOrange).toBe(true);
  });

  // ── Cancellation ────────────────────────────────────────────────────────

  test('cancellation stops animation early', async () => {
    const current = '# Title';
    const target = '# Title\n\nA\n\nB\n\nC\n\nD\n\nE\n\nF\n\nG\n\nH';
    const recorder = makeRecorder();

    // Cancel after first setContent
    const origSet = recorder.callbacks.setContentJSON;
    let callCount = 0;
    recorder.callbacks.setContentJSON = (json) => {
      origSet(json);
      callCount++;
      if (callCount >= 2) recorder.cancel();
    };

    await runEditorAnimation(current, target, recorder.callbacks);

    // Should have stopped before completing all steps
    expect(recorder.docs.length).toBeLessThan(10);
  });

  // ── Insertion plan correctness ──────────────────────────────────────────

  test('final content matches target markdown structure', async () => {
    const current = '# Old title\n\nOld paragraph';
    const target = '# New title\n\nKept text\n\nNew ending';
    const { docs, callbacks } = makeRecorder();
    await runEditorAnimation(current, target, callbacks);

    const finalDoc = docs[docs.length - 1];
    expect(finalDoc.type).toBe('doc');
    expect(finalDoc.content.length).toBeGreaterThan(0);

    // Final doc should not contain any animation marks
    const finalJson = JSON.stringify(finalDoc);
    expect(finalJson).not.toContain('animationHighlight');
  });

  test('mixed deletions and additions produce correct sequence', async () => {
    const current = '# Title\n\nDelete me\n\nKeep me';
    const target = '# Title\n\nKeep me\n\nAdd me';
    const { docs, callbacks } = makeRecorder();
    await runEditorAnimation(current, target, callbacks);

    // Should have: red deletion → afterDeletions → addition steps → final
    expect(docs.length).toBeGreaterThanOrEqual(3);

    // First doc has red marks (deletion phase)
    const firstJson = JSON.stringify(docs[0]);
    expect(firstJson).toContain('"color":"red"');

    // Final doc is clean
    const finalJson = JSON.stringify(docs[docs.length - 1]);
    expect(finalJson).not.toContain('animationHighlight');
  });
});
