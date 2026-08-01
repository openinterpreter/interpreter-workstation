/**
 * remarkWikilinks
 *
 * Detects Obsidian-style wikilinks in markdown and transforms them into
 * custom <wikilink> nodes for rendering.
 *
 * Supported forms:
 *   [[Page Name]]                      -> target="Page Name",        display="Page Name"
 *   [[Page Name|Display Text]]         -> target="Page Name",        display="Display Text"
 *   [[Page Name#Heading]]              -> target="Page Name",        fragment="Heading"
 *   [[Page Name#Heading|Display]]      -> target+fragment+display
 *   [[folder/Page Name]]               -> target="folder/Page Name"
 *   [[Page Name.md]]                   -> target retains extension
 *
 * Escapes: a leading backslash (\[[Page]]) disables matching for that
 * occurrence. Wikilinks are not matched inside inline code, code blocks,
 * or existing links.
 */

// Match [[target]] or [[target|display]]. No newlines inside. Not greedy.
// Negative lookbehind for escape backslash.
const WIKILINK_REGEX = /(?<!\\)\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

const EXCLUDED_PARENT_TYPES = new Set([
  'link',
  'linkReference',
  'wikilink',
  'fileLink',
  'skillLink',
  'inlineCode',
  'code',
]);

type WikilinkParts = {
  target: string;
  fragment?: string;
  display?: string;
};

function parseWikilinkBody(rawTarget: string, rawDisplay: string | undefined): WikilinkParts | null {
  const targetRaw = rawTarget.trim();
  if (!targetRaw) return null;

  let target = targetRaw;
  let fragment: string | undefined;
  const hashIndex = targetRaw.indexOf('#');
  if (hashIndex >= 0) {
    target = targetRaw.slice(0, hashIndex).trim();
    fragment = targetRaw.slice(hashIndex + 1).trim() || undefined;
    if (!target) return null;
  }

  const display = rawDisplay?.trim();
  return {
    target,
    ...(fragment ? { fragment } : {}),
    ...(display ? { display } : {}),
  };
}

function createWikilinkNode(parts: WikilinkParts): any {
  return {
    type: 'wikilink',
    data: {
      hName: 'wikilink',
      hProperties: {
        'data-target': parts.target,
        ...(parts.display ? { 'data-display': parts.display } : {}),
        ...(parts.fragment ? { 'data-fragment': parts.fragment } : {}),
      },
    },
    children: [],
  };
}

function splitTextIntoNodes(value: string): { nodes: any[]; changed: boolean } {
  WIKILINK_REGEX.lastIndex = 0;

  const nodes: any[] = [];
  let lastIndex = 0;
  let changed = false;
  let match: RegExpExecArray | null;

  while ((match = WIKILINK_REGEX.exec(value)) !== null) {
    const fullMatch = match[0];
    const parts = parseWikilinkBody(match[1], match[2]);

    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }

    if (parts) {
      nodes.push(createWikilinkNode(parts));
      changed = true;
    } else {
      nodes.push({ type: 'text', value: fullMatch });
    }

    lastIndex = match.index + fullMatch.length;
  }

  if (!changed) {
    return { nodes: [{ type: 'text', value }], changed: false };
  }

  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }

  return { nodes, changed: true };
}

function transformTextChildren(parent: any): void {
  if (!Array.isArray(parent?.children)) return;
  if (EXCLUDED_PARENT_TYPES.has(parent.type)) return;

  const nextChildren: any[] = [];
  for (const child of parent.children) {
    if (child?.type === 'text' && typeof child.value === 'string') {
      const { nodes } = splitTextIntoNodes(child.value);
      nextChildren.push(...nodes);
    } else {
      transformTextChildren(child);
      nextChildren.push(child);
    }
  }
  parent.children = nextChildren;
}

/**
 * Remark plugin to transform [[wikilinks]] into custom wikilink nodes.
 */
export const remarkWikilinks = () => {
  return (tree: any) => {
    transformTextChildren(tree);
  };
};
