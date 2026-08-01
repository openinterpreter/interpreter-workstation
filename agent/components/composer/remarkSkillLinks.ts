import { visit } from 'unist-util-visit';
import { parseSkillMentionToken } from '../../../shared/utils/skillMentions';

const RAW_SKILL_LINK_REGEX = /skill:\[[^\]]+\]\([^\)\n]+\)/g;
const RAW_SKILL_EXCLUDED_PARENT_TYPES = new Set(['skillLink', 'inlineCode', 'code']);

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

function createSkillLinkNode(rawToken: string): any | null {
  const parsed = parseSkillMentionToken(rawToken);
  if (!parsed) {
    return null;
  }

  return {
    type: 'skillLink',
    data: {
      hName: 'skill-link',
      hProperties: {
        'data-id': parsed.id,
        'data-name': parsed.name,
        'data-path': parsed.path,
        'data-display-text': parsed.label,
      },
    },
    children: [],
  };
}

function createSkillLinkNodeFromParts(displayText: string, payload: string): any | null {
  return createSkillLinkNode(`skill:[${displayText}](${payload})`);
}

function splitRawTextIntoNodes(value: string): any[] {
  RAW_SKILL_LINK_REGEX.lastIndex = 0;

  const nodes: any[] = [];
  let lastIndex = 0;
  let changed = false;
  let match: RegExpExecArray | null;

  while ((match = RAW_SKILL_LINK_REGEX.exec(value)) !== null) {
    const rawToken = match[0];
    const replacement = createSkillLinkNode(rawToken);

    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }

    if (replacement) {
      nodes.push(replacement);
      changed = true;
    } else {
      nodes.push({ type: 'text', value: rawToken });
    }

    lastIndex = match.index + rawToken.length;
  }

  if (!changed) {
    return [{ type: 'text', value }];
  }

  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }

  return mergeAdjacentTextNodes(nodes);
}

function recoverRawSkillLinks(node: any): void {
  if (!Array.isArray(node?.children)) {
    return;
  }

  const nextChildren: any[] = [];

  for (const child of node.children) {
    if (
      child?.type === 'text' &&
      typeof child.value === 'string' &&
      !RAW_SKILL_EXCLUDED_PARENT_TYPES.has(node.type)
    ) {
      nextChildren.push(...splitRawTextIntoNodes(child.value));
      continue;
    }

    recoverRawSkillLinks(child);
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

export const remarkSkillLinks = () => {
  return (tree: any) => {
    recoverRawSkillLinks(tree);

    visit(tree, 'link', (node: any, index: number | undefined, parent: any) => {
      if (!parent || typeof index !== 'number' || index <= 0) {
        return;
      }

      const prev = parent.children[index - 1];
      if (prev?.type !== 'text' || typeof prev.value !== 'string' || !prev.value.endsWith('skill:')) {
        return;
      }

      const replacement = createSkillLinkNodeFromParts(
        String(node.children?.[0]?.value || ''),
        String(node.url || ''),
      );
      if (!replacement) {
        return;
      }

      prev.value = prev.value.slice(0, -'skill:'.length);
      if (prev.value.length === 0) {
        parent.children.splice(index - 1, 1);
        index -= 1;
      }

      parent.children[index] = replacement;
    });

    visit(tree, 'skillLink', () => undefined);
  };
};
