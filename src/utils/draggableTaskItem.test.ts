import { describe, expect, test } from 'bun:test';

// prosemirror-view reads doc.documentElement.style at module load time;
// must be set before the dynamic import triggers module evaluation.
(globalThis as any).document = { documentElement: { style: {} } };

const { DraggableTaskItem } = await import('../extensions/DraggableTaskItem');

class MockElement {
  readonly tag: string;
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: MockElement[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();

  checked = false;
  type = '';
  contentEditable = '';
  draggable = false;

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }

  appendChild(child: MockElement) {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, callback: () => void) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  dispatch(type: string) {
    const callbacks = this.listeners.get(type) ?? [];
    for (const callback of callbacks) {
      callback();
    }
  }
}

describe('DraggableTaskItem', () => {
  test('updates checkbox state without focusing editor', () => {
    (globalThis as { document?: { createElement: (tag: string) => MockElement } }).document = {
      createElement: (tag: string) => new MockElement(tag),
    };

    const state = {
      focusCalled: false,
      commandRan: false,
      attrs: null as Record<string, unknown> | null,
    };

    const editor = {
      chain: () => ({
        focus: () => {
          state.focusCalled = true;
          return editor.chain();
        },
        command: (fn: (ctx: { tr: { setNodeMarkup: (pos: number, arg: undefined, attrs: Record<string, unknown>) => void } }) => boolean) => {
          fn({
            tr: {
              setNodeMarkup: (_pos, _arg, attrs) => {
                state.attrs = attrs;
              },
            },
          });
          state.commandRan = true;
          return {
            run: () => true,
          };
        },
      }),
    };

    const nodeViewFactory = (DraggableTaskItem as { config: { addNodeView: () => Function } }).config.addNodeView();
    const nodeView = nodeViewFactory({
      node: { attrs: { checked: false, id: 'a1' } },
      HTMLAttributes: {},
      getPos: () => 7,
      editor,
    }) as { dom: MockElement };

    const label = nodeView.dom.children[0];
    const checkbox = label.children[0];
    checkbox.checked = true;
    checkbox.dispatch('change');

    expect(state.focusCalled).toBe(false);
    expect(state.commandRan).toBe(true);
    expect(state.attrs).toEqual({
      checked: true,
      id: 'a1',
    });
  });
});
