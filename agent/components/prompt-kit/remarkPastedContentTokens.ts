const EXCLUDED_PARENT_TYPES = new Set([
  'link',
  'linkReference',
  'fileLink',
  'skillLink',
  'wikilink',
  'inlineCode',
  'code',
  'pastedContent',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createPastedContentNode(attachmentId: string): any {
  return {
    type: 'pastedContent',
    data: {
      hName: 'pasted-content',
      hProperties: {
        'data-attachment-id': attachmentId,
      },
    },
    children: [],
  };
}

function splitTextIntoNodes(
  value: string,
  tokenToAttachmentId: Record<string, string>,
): any[] {
  const tokens = Object.keys(tokenToAttachmentId);
  if (tokens.length === 0) {
    return [{ type: 'text', value }];
  }

  const matcher = new RegExp(tokens.map(escapeRegExp).join('|'), 'g');
  const nodes: any[] = [];
  let lastIndex = 0;
  let changed = false;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(value)) !== null) {
    const token = match[0];
    const attachmentId = tokenToAttachmentId[token];
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }

    if (attachmentId) {
      nodes.push(createPastedContentNode(attachmentId));
      changed = true;
    } else {
      nodes.push({ type: 'text', value: token });
    }

    lastIndex = match.index + token.length;
  }

  if (!changed) {
    return [{ type: 'text', value }];
  }

  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }

  return mergeAdjacentTextNodes(nodes);
}

function mergeAdjacentTextNodes(nodes: any[]): any[] {
  const merged: any[] = [];

  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (node?.type === 'text' && previous?.type === 'text') {
      previous.value = `${previous.value || ''}${node.value || ''}`;
    } else {
      merged.push(node);
    }
  }

  return merged;
}

function transformTextChildren(
  parent: any,
  tokenToAttachmentId: Record<string, string>,
): void {
  if (!Array.isArray(parent?.children)) return;
  if (EXCLUDED_PARENT_TYPES.has(parent.type)) return;

  const nextChildren: any[] = [];
  for (const child of parent.children) {
    if (child?.type === 'text' && typeof child.value === 'string') {
      nextChildren.push(...splitTextIntoNodes(child.value, tokenToAttachmentId));
      continue;
    }

    transformTextChildren(child, tokenToAttachmentId);
    nextChildren.push(child);
  }

  parent.children = nextChildren;
}

export const remarkPastedContentTokens = (
  tokenToAttachmentId: Record<string, string> = {},
) => {
  return (tree: any) => {
    if (Object.keys(tokenToAttachmentId).length === 0) {
      return;
    }
    transformTextChildren(tree, tokenToAttachmentId);
  };
};
