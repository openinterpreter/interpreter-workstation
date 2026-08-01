import { beforeEach, describe, expect, mock, test } from 'bun:test';

type FakeNode = {
  style: Record<string, string>;
  className: string;
  parentNode: FakeNode | null;
  children: FakeNode[];
  attributes: Record<string, string>;
  setAttribute: (key: string, value: string) => void;
  appendChild: (child: FakeNode) => void;
  removeChild: (child: FakeNode) => void;
};

function createFakeNode(): FakeNode {
  return {
    style: {},
    className: '',
    parentNode: null,
    children: [],
    attributes: {},
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
    },
    appendChild(child: FakeNode) {
      child.parentNode = this;
      this.children.push(child);
    },
    removeChild(child: FakeNode) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
      }
      child.parentNode = null;
    },
  };
}

const reactRendererInstances: FakeReactRenderer[] = [];

class FakeReactRenderer {
  element: FakeNode;

  ref: { onKeyDown?: (_props: unknown) => boolean };

  props: Record<string, unknown>;

  destroy: ReturnType<typeof mock>;

  constructor(_component: unknown, options: { props: Record<string, unknown> }) {
    this.element = createFakeNode();
    this.ref = {};
    this.props = options.props;
    this.destroy = mock(() => {});
    reactRendererInstances.push(this);
  }

  updateProps(nextProps: Record<string, unknown>) {
    this.props = nextProps;
  }
}

mock.module('@tiptap/react', () => ({
  ReactRenderer: FakeReactRenderer,
}));

mock.module('./FileMentionDropdown', () => ({
  FileMentionDropdown: () => null,
}));

mock.module('./fileSearchBridge', () => ({
  getAllSearchItems: () => [
    {
      path: '/workspace/README.md',
      name: 'README.md',
      type: 'file',
    },
    {
      path: '/workspace/src/components/Composer.tsx',
      name: 'Composer.tsx',
      type: 'file',
    },
  ],
  filterSearchItems: (items: Array<{ path?: string; name: string; url?: string }>, query: string) => {
    if (!query) return items;

    const lowerQuery = query.toLowerCase();
    return items.filter((item) =>
      item.name.toLowerCase().includes(lowerQuery)
      || item.path?.toLowerCase().includes(lowerQuery)
      || item.url?.toLowerCase().includes(lowerQuery)
    );
  },
}));

const { createFileMentionSuggestion } = await import('./fileMentionSuggestion');

beforeEach(() => {
  reactRendererInstances.length = 0;

  const body = createFakeNode();
  (globalThis as any).window = { innerHeight: 800 };
  (globalThis as any).document = {
    body,
    createElement: () => createFakeNode(),
  };
});

function buildLifecycle() {
  const container = {
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 400,
    }),
  };
  const suggestion = createFileMentionSuggestion({
    getContainer: () => container as any,
  });
  const lifecycle = suggestion.render?.();
  if (!lifecycle) {
    throw new Error('Expected suggestion render lifecycle');
  }
  return lifecycle;
}

function buildProps(range: { from: number; to: number }) {
  const deleteRange = mock(() => {});
  const command = mock(() => {});

  return {
    props: {
      editor: {
        view: { dom: {} },
        commands: { deleteRange },
      },
      query: '',
      command,
      clientRect: () => ({ left: 100, top: 200 }),
      range,
    },
    deleteRange,
    command,
  };
}

describe('createFileMentionSuggestion', () => {
  describe('allow', () => {
    type AllowFn = (props: {
      editor: unknown;
      state: { doc: { textBetween: (from: number, to: number) => string } };
      range: { from: number; to: number };
    }) => boolean;

    function buildSuggestionWithAllow() {
      const container = {
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 400 }),
      };
      const suggestion = createFileMentionSuggestion({
        getContainer: () => container as any,
      });
      const allow = suggestion.allow as AllowFn;
      if (!allow) {
        throw new Error('Expected suggestion to define an allow function');
      }
      const lifecycle = suggestion.render?.();
      if (!lifecycle) {
        throw new Error('Expected suggestion render lifecycle');
      }
      return { allow, lifecycle };
    }

    function mockAllowProps(text: string) {
      return {
        editor: {},
        state: { doc: { textBetween: () => text } },
        range: { from: 0, to: text.length },
      };
    }

    test('should reject query that starts with a space ("@ foo")', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('@ foo'))).toBe(false);
    });

    test('should reject query that is only a space ("@ ")', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('@ '))).toBe(false);
    });

    test('should accept query without leading space when it matches', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('@composer'))).toBe(true);
    });

    test('should accept query with no spaces ("@readme")', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('@readme'))).toBe(true);
    });

    test('should accept bare trigger with no query yet ("@")', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('@'))).toBe(true);
    });

    test('should reject query with no matching items', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('@zzz'))).toBe(false);
    });

    test('should not delete range when allow rejects (leading space typed)', () => {
      const { allow, lifecycle } = buildSuggestionWithAllow();
      const { props, deleteRange } = buildProps({ from: 4, to: 5 });

      lifecycle.onStart?.(props as any);

      allow(mockAllowProps('@ '));

      lifecycle.onExit?.(props as any);

      expect(deleteRange).not.toHaveBeenCalled();
    });
  });

  test('does not delete text when suggestion exits without a selection', () => {
    const lifecycle = buildLifecycle();
    const { props, deleteRange } = buildProps({ from: 4, to: 6 });

    lifecycle.onStart?.(props as any);
    lifecycle.onExit?.(props as any);

    expect(deleteRange).not.toHaveBeenCalled();
  });
});
