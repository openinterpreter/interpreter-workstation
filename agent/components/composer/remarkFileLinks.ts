/**
 * remarkFileLinks
 *
 * A remark plugin that detects markdown links pointing to file paths
 * and transforms them into custom FileLink components that can be rendered
 * as FileSystemProxy components.
 *
 * Example:
 *   [config.json](/absolute/path/to/config.json)
 *   => <FileLink path="/absolute/path/to/config.json">config.json</FileLink>
 */

import { visit } from 'unist-util-visit';
import { isLocalFileLink, resolveLocalLinkTarget } from '../../../src/utils/localLinkDetection';

const RAW_LOCAL_LINK_REGEX = /@?\[([^\]]+)\]\((<[^>\n]+>|[^)\n]+)\)/g;
const RAW_LINK_EXCLUDED_PARENT_TYPES = new Set(['link', 'fileLink', 'inlineCode', 'code']);

function unwrapLinkDestination(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function createFileLinkNode(url: string, displayText: string): any | null {
  const resolved = resolveLocalLinkTarget(url);
  if (!resolved) {
    return null;
  }

  const cleanPath = resolved.path;
  const lineStart = resolved.lineStart;
  const lineEnd = resolved.lineEnd;
  const fragment = resolved.fragment;
  const fileType = resolved.itemType;

  return {
    type: 'fileLink',
    data: {
      hName: 'file-link',
      hProperties: {
        'data-path': cleanPath,
        'data-type': fileType,
        'data-display-text': displayText || undefined,
        ...(lineStart !== undefined ? { 'data-line-start': String(lineStart) } : {}),
        ...(lineEnd !== undefined ? { 'data-line-end': String(lineEnd) } : {}),
        ...(fragment ? { 'data-fragment': fragment } : {}),
      },
    },
    children: [],
  };
}

function recoverRawFileLinks(node: any): void {
  if (!Array.isArray(node?.children)) {
    return;
  }

  const nextChildren: any[] = [];

  for (const child of node.children) {
    if (
      child?.type === 'text' &&
      typeof child.value === 'string' &&
      !RAW_LINK_EXCLUDED_PARENT_TYPES.has(node.type)
    ) {
      nextChildren.push(...splitRawTextIntoNodes(child.value));
      continue;
    }

    recoverRawFileLinks(child);
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

function splitRawTextIntoNodes(value: string): any[] {
  RAW_LOCAL_LINK_REGEX.lastIndex = 0;

  const nodes: any[] = [];
  let lastIndex = 0;
  let changed = false;
  let match: RegExpExecArray | null;

  while ((match = RAW_LOCAL_LINK_REGEX.exec(value)) !== null) {
    const fullMatch = match[0];
    const label = match[1];
    const href = unwrapLinkDestination(match[2]);
    const replacement = isLocalFileLink(href) ? createFileLinkNode(href, label) : null;

    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }

    if (replacement) {
      nodes.push(replacement);
      changed = true;
    } else {
      nodes.push({ type: 'text', value: fullMatch });
    }

    lastIndex = match.index + fullMatch.length;
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

/**
 * Recursively extract text content from a node tree.
 * Handles text nested inside formatting (e.g., [**file.txt**](/path) where text is inside strong).
 */
function getTextContent(node: any): string {
  if (node.type === 'text') return node.value || '';
  if (node.children) {
    return node.children.map((child: any) => getTextContent(child)).join('');
  }
  return '';
}

/**
 * Unwrap formatting nodes (strong, emphasis, delete) that contain fileLink children.
 * This ensures mentions render as mention pills regardless of surrounding markdown formatting
 * like bold, italic, or strikethrough.
 *
 * Processes bottom-up so nested formatting (e.g., ***[file](/path)***) is handled correctly.
 */
function unwrapFormattingFromFileLinks(node: any): void {
  if (!node.children) return;

  const formattingTypes = ['strong', 'emphasis', 'delete'];

  // Recurse into children first (bottom-up)
  for (const child of node.children) {
    unwrapFormattingFromFileLinks(child);
  }

  // Then unwrap any formatting nodes that contain fileLink children
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (
      formattingTypes.includes(child.type) &&
      child.children?.some((gc: any) => gc.type === 'fileLink')
    ) {
      // Replace formatting node with its children (removing the formatting wrapper)
      node.children.splice(i, 1, ...child.children);
      i--; // Re-check from same position since we spliced new nodes in
    }
  }
}

/**
 * Remark plugin to transform file path links into custom FileLink nodes
 */
export const remarkFileLinks = () => {
  return (tree: any) => {
    recoverRawFileLinks(tree);

    visit(tree, 'link', (node: any, index: number | undefined, parent: any) => {
      const url = node.url;

      if (!isLocalFileLink(url)) {
        return;
      }

      // Strip preceding "@" (mentions are serialized as "@[label](path)")
      if (parent && typeof index === 'number' && index > 0) {
        const prev = parent.children[index - 1];
        if (prev?.type === 'text' && typeof prev.value === 'string' && prev.value.endsWith('@')) {
          prev.value = prev.value.slice(0, -1);
          if (prev.value.length === 0) {
            parent.children.splice(index - 1, 1);
          }
        }
      }

      const displayText = getTextContent(node);
      const fileLinkNode = createFileLinkNode(url, displayText);
      if (!fileLinkNode) {
        return;
      }

      node.type = fileLinkNode.type;
      node.data = fileLinkNode.data;
    });

    // Unwrap any formatting (bold/italic/strikethrough) from around file mentions
    // so they always render as mention pills regardless of markdown formatting
    unwrapFormattingFromFileLinks(tree);
  };
};
