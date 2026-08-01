export interface StandaloneFileLinkItem {
  path: string;
  type: 'file' | 'directory';
  displayText?: string;
  lineStart?: number;
  lineEnd?: number;
  fragment?: string;
  detailText?: string;
  ordinal?: number;
}

function isWhitespaceTextNode(node: any): boolean {
  return node?.type === 'text' && typeof node.value === 'string' && node.value.trim() === '';
}

function getFileLinkItem(node: any): StandaloneFileLinkItem | null {
  if (node?.type !== 'fileLink') {
    return null;
  }

  const props = node.data?.hProperties;
  const path = props?.['data-path'];
  const type = props?.['data-type'];
  if (typeof path !== 'string' || (type !== 'file' && type !== 'directory')) {
    return null;
  }

  const displayText = typeof props?.['data-display-text'] === 'string' ? props['data-display-text'] : undefined;
  const lineStart = typeof props?.['data-line-start'] === 'string'
    ? parseInt(props['data-line-start'], 10)
    : undefined;
  const lineEnd = typeof props?.['data-line-end'] === 'string'
    ? parseInt(props['data-line-end'], 10)
    : undefined;
  const fragment = typeof props?.['data-fragment'] === 'string' ? props['data-fragment'] : undefined;

  return {
    path,
    type,
    ...(displayText ? { displayText } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
    ...(fragment ? { fragment } : {}),
  };
}

function getTextContent(node: any): string {
  if (!node) return '';
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return typeof node.value === 'string' ? node.value : '';
    case 'break':
      return '\n';
    case 'paragraph':
    case 'strong':
    case 'emphasis':
    case 'delete':
    case 'link':
    case 'blockquote':
      return Array.isArray(node.children)
        ? node.children.map((child: any) => getTextContent(child)).join('')
        : '';
    case 'fileLink': {
      const item = getFileLinkItem(node);
      return item?.displayText || item?.path || '';
    }
    case 'list': {
      const ordered = Boolean(node.ordered);
      const start = typeof node.start === 'number' ? node.start : 1;
      if (!Array.isArray(node.children)) {
        return '';
      }

      return node.children
        .map((child: any, index: number) => {
          const marker = ordered ? `${start + index}. ` : '- ';
          const content = getTextContent(child).trim();
          if (!content) {
            return '';
          }
          const indent = ' '.repeat(marker.length);
          return `${marker}${content.replace(/\n/g, `\n${indent}`)}`;
        })
        .filter(Boolean)
        .join('\n');
    }
    case 'listItem':
      return Array.isArray(node.children)
        ? node.children.map((child: any) => getTextContent(child).trim()).filter(Boolean).join('\n')
        : '';
    default:
      return Array.isArray(node.children)
        ? node.children.map((child: any) => getTextContent(child)).join('')
        : '';
  }
}

function normalizeInlineDetailText(value: string): string {
  return value
    .replace(/\s+$/g, '')
    .trim()
    .replace(/^[\s:;\-–—|]+/, '')
    .trim();
}

function normalizeBlockDetailText(value: string): string {
  const trimmed = value.replace(/\s+$/g, '').trim();
  if (!trimmed) {
    return '';
  }

  if (/^(?:[-*+]\s|\d+\.\s)/.test(trimmed) || trimmed.includes('\n')) {
    return trimmed;
  }

  return trimmed.replace(/^[\s:;\-–—|]+/, '').trim();
}

function extractSingleLineItem(nodes: any[]): StandaloneFileLinkItem | null {
  const nonWhitespaceNodes = nodes.filter((node) => !isWhitespaceTextNode(node));
  if (nonWhitespaceNodes.length !== 1) {
    return null;
  }

  return getFileLinkItem(nonWhitespaceNodes[0]);
}

function extractDetailedLineItem(nodes: any[]): StandaloneFileLinkItem | null {
  const nonWhitespaceNodes = nodes.filter((node) => !isWhitespaceTextNode(node));
  if (nonWhitespaceNodes.length < 2) {
    return null;
  }

  const fileLinkNodes = nonWhitespaceNodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => getFileLinkItem(node));

  if (fileLinkNodes.length !== 1) {
    return null;
  }

  const [{ node: fileNode, index: fileIndex }] = fileLinkNodes;
  const item = getFileLinkItem(fileNode);
  if (!item) {
    return null;
  }

  const detailText = normalizeInlineDetailText(
    nonWhitespaceNodes
      .filter((_, index) => index !== fileIndex)
      .map((node) => getTextContent(node))
      .join(''),
  );
  if (!detailText) {
    return null;
  }

  return {
    ...item,
    detailText,
  };
}

function extractParagraphItems(node: any): StandaloneFileLinkItem[] | null {
  if (node?.type !== 'paragraph' || !Array.isArray(node.children) || node.children.length === 0) {
    return null;
  }

  const lineGroups: any[][] = [];
  let currentLine: any[] = [];

  for (const child of node.children) {
    if (child?.type === 'break') {
      lineGroups.push(currentLine);
      currentLine = [];
      continue;
    }
    currentLine.push(child);
  }
  lineGroups.push(currentLine);

  const items: StandaloneFileLinkItem[] = [];
  for (const lineGroup of lineGroups) {
    const item = extractSingleLineItem(lineGroup);
    if (!item) {
      return null;
    }
    items.push(item);
  }

  return items.length > 0 ? items : null;
}

function extractDetailedParagraphItems(node: any): StandaloneFileLinkItem[] | null {
  if (node?.type !== 'paragraph' || !Array.isArray(node.children) || node.children.length === 0) {
    return null;
  }

  const lineGroups: any[][] = [];
  let currentLine: any[] = [];

  for (const child of node.children) {
    if (child?.type === 'break') {
      lineGroups.push(currentLine);
      currentLine = [];
      continue;
    }
    currentLine.push(child);
  }
  lineGroups.push(currentLine);

  if (lineGroups.length < 2) {
    return null;
  }

  const items: StandaloneFileLinkItem[] = [];
  for (const lineGroup of lineGroups) {
    const item = extractDetailedLineItem(lineGroup);
    if (!item) {
      return null;
    }
    items.push(item);
  }

  return items.length > 0 ? items : null;
}

function extractDetailedParagraphItem(node: any): StandaloneFileLinkItem | null {
  if (node?.type !== 'paragraph' || !Array.isArray(node.children) || node.children.length === 0) {
    return null;
  }

  return extractDetailedLineItem(node.children);
}

function extractSingleParagraphItem(node: any): StandaloneFileLinkItem | null {
  const items = extractParagraphItems(node);
  if (!items || items.length !== 1) {
    return null;
  }

  return items[0];
}

function extractUnorderedListItems(node: any): StandaloneFileLinkItem[] | null {
  if (node?.type !== 'list' || node.ordered || !Array.isArray(node.children) || node.children.length === 0) {
    return null;
  }

  const items: StandaloneFileLinkItem[] = [];

  for (const child of node.children) {
    if (child?.type !== 'listItem' || child.checked != null || !Array.isArray(child.children) || child.children.length !== 1) {
      return null;
    }

    const paragraphItems = extractParagraphItems(child.children[0]);
    if (!paragraphItems || paragraphItems.length !== 1) {
      return null;
    }

    items.push(paragraphItems[0]);
  }

  return items.length > 0 ? items : null;
}

function withOrdinal(item: StandaloneFileLinkItem, ordinal: number | null): StandaloneFileLinkItem {
  if (ordinal == null) {
    return item;
  }

  return {
    ...item,
    ordinal,
  };
}

function appendDetailText(item: StandaloneFileLinkItem, extraText: string): StandaloneFileLinkItem {
  const detailText = normalizeBlockDetailText(extraText);
  if (!detailText) {
    return item;
  }

  return {
    ...item,
    detailText: item.detailText ? `${item.detailText}\n\n${detailText}` : detailText,
  };
}

function extractDetailedUnorderedListItems(node: any): StandaloneFileLinkItem[] | null {
  if (node?.type !== 'list' || !Array.isArray(node.children) || node.children.length === 0) {
    return null;
  }

  const items: StandaloneFileLinkItem[] = [];
  const ordered = Boolean(node.ordered);
  const start = typeof node.start === 'number' ? node.start : 1;

  for (const [index, child] of node.children.entries()) {
    if (child?.type !== 'listItem' || child.checked != null || !Array.isArray(child.children) || child.children.length === 0) {
      return null;
    }

    const [firstChild, ...restChildren] = child.children;
    const baseItem = firstChild
      ? extractDetailedParagraphItem(firstChild) ?? extractSingleParagraphItem(firstChild)
      : null;
    if (!baseItem) {
      return null;
    }

    let item = withOrdinal(baseItem, ordered ? start + index : null);
    const trailingText = restChildren.map((node: any) => getTextContent(node)).join('\n\n');
    item = appendDetailText(item, trailingText);
    if (!item.detailText) {
      return null;
    }

    items.push(item);
  }

  return items.length > 0 ? items : null;
}

function extractStandaloneFileLinkItems(node: any): StandaloneFileLinkItem[] | null {
  return extractParagraphItems(node) ?? extractUnorderedListItems(node);
}

function extractOrderedStandaloneFileLinkItems(node: any): StandaloneFileLinkItem[] | null {
  if (node?.type !== 'list' || !node.ordered || !Array.isArray(node.children) || node.children.length === 0) {
    return null;
  }

  const start = typeof node.start === 'number' ? node.start : 1;
  const items: StandaloneFileLinkItem[] = [];

  for (const [index, child] of node.children.entries()) {
    if (child?.type !== 'listItem' || child.checked != null || !Array.isArray(child.children) || child.children.length !== 1) {
      return null;
    }

    const item = extractSingleParagraphItem(child.children[0]);
    if (!item) {
      return null;
    }

    items.push(withOrdinal(item, start + index));
  }

  return items.length > 0 ? items : null;
}

function extractDetailedStandaloneFileLinkItems(node: any): StandaloneFileLinkItem[] | null {
  return extractDetailedParagraphItems(node) ?? extractDetailedUnorderedListItems(node);
}

function createFileLinkGridNode(items: StandaloneFileLinkItem[]): any {
  return {
    type: 'fileLinkGrid',
    data: {
      hName: 'file-link-grid',
      hProperties: {
        'data-items': JSON.stringify(items),
      },
    },
    children: [],
  };
}

function createFileLinkListNode(items: StandaloneFileLinkItem[]): any {
  return {
    type: 'fileLinkList',
    data: {
      hName: 'file-link-list',
      hProperties: {
        'data-items': JSON.stringify(items),
      },
    },
    children: [],
  };
}

export function transformStandaloneFileLinkGrids(tree: any): void {
  if (!tree || typeof tree !== 'object' || !Array.isArray(tree.children)) {
    return;
  }

  tree.children = tree.children.map((child: any) => {
    const detailedItems = extractDetailedStandaloneFileLinkItems(child);
    if (detailedItems) {
      return createFileLinkListNode(detailedItems);
    }

    const orderedItems = extractOrderedStandaloneFileLinkItems(child);
    if (orderedItems) {
      return createFileLinkListNode(orderedItems);
    }

    const items = extractStandaloneFileLinkItems(child);
    if (items) {
      return createFileLinkGridNode(items);
    }

    transformStandaloneFileLinkGrids(child);
    return child;
  });
}

export const remarkStandaloneFileLinkGrids = () => {
  return (tree: any) => {
    transformStandaloneFileLinkGrids(tree);
  };
};
