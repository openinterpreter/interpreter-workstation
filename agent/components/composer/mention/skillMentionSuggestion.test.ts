import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SkillMentionDropdownData } from './SkillMentionDropdown';

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

mock.module('./SkillMentionDropdown', () => ({
  SkillMentionDropdown: () => null,
  filterSkillItems: (items: Array<{ id: string; label: string; name: string; description?: string }>, query: string) => {
    if (!query) return items;

    const lowerQuery = query.toLowerCase();
    return items.filter((item) =>
      item.label.toLowerCase().includes(lowerQuery)
      || item.name.toLowerCase().includes(lowerQuery)
      || (item.description || '').toLowerCase().includes(lowerQuery)
      || item.id.toLowerCase().includes(lowerQuery)
    );
  },
}));

const { createSkillMentionSuggestion } = await import('./skillMentionSuggestion');

beforeEach(() => {
  reactRendererInstances.length = 0;

  const body = createFakeNode();
  (globalThis as any).window = { innerHeight: 800 };
  (globalThis as any).document = {
    body,
    createElement: () => createFakeNode(),
  };
});

function buildDropdownData(): SkillMentionDropdownData {
  return {
    globalRootPath: '/global',
    projectRootPath: '/project',
    projectItems: [
      {
        id: 'frontend-design',
        label: 'Frontend Design',
        name: 'frontend-design',
        path: '/project/frontend-design/SKILL.md',
        description: 'Build polished interfaces',
        source: 'project',
      },
    ],
    globalItems: [
      {
        id: 'fixing-accessibility',
        label: 'Fixing Accessibility',
        name: 'fixing-accessibility',
        path: '/global/fixing-accessibility/SKILL.md',
        description: 'Audit and repair accessibility issues',
        source: 'global',
      },
    ],
  };
}

function buildLifecycle() {
  const container = {
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 400,
    }),
  };
  const suggestion = createSkillMentionSuggestion({
    getContainer: () => container as any,
    getDropdownData: buildDropdownData,
  });
  const lifecycle = suggestion.render?.();
  if (!lifecycle) {
    throw new Error('Expected suggestion render lifecycle');
  }
  return { suggestion, lifecycle };
}

describe('createSkillMentionSuggestion', () => {
  describe('allow', () => {
    type AllowFn = (props: {
      editor: unknown;
      state: { doc: { textBetween: (from: number, to: number) => string } };
      range: { from: number; to: number };
    }) => boolean;

    function buildSuggestionWithAllow() {
      const { suggestion, lifecycle } = buildLifecycle();
      const allow = suggestion.allow as AllowFn;
      if (!allow) {
        throw new Error('Expected suggestion to define an allow function');
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

    test('should accept bare trigger with no query yet ("/")', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('/'))).toBe(true);
    });

    test('should reject query that starts with a space ("/ foo")', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('/ foo'))).toBe(false);
    });

    test('should accept matching skill query', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('/frontend'))).toBe(true);
    });

    test('should reject query with no matching skills', () => {
      const { allow } = buildSuggestionWithAllow();
      expect(allow(mockAllowProps('/zzz'))).toBe(false);
    });
  });
});
