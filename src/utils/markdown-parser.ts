/**
 * Simple markdown to Tiptap JSON converter
 * Handles basic markdown syntax
 */

import {
  canonicalizeLocalLinkPath,
  inferLocalLinkItemType,
  isLocalFileLink,
  parseLocalLink,
  serializeLocalLinkHref,
} from './localLinkDetection';
import { pathResolve } from '@/ipc';

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

type TiptapMark = NonNullable<TiptapNode['marks']>[number];
const EMPTY_TASK_PLACEHOLDER = ' ';

function buildInlineParagraphContent(text: string, baseDir?: string): TiptapNode[] {
  const inlineContent = parseInlineContent(text, baseDir);
  return inlineContent.length > 0 ? inlineContent : [{ type: 'text', text: EMPTY_TASK_PLACEHOLDER }];
}

export function markdownToTiptap(markdown: string, baseDir?: string): { type: 'doc'; content: TiptapNode[] } {
  const normalizedMarkdown = markdown.replace(/\r\n?/g, '\n');
  const lines = normalizedMarkdown.split('\n');
  const content: TiptapNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      content.push({
        type: 'heading',
        attrs: { level },
        content: parseInlineContent(text, baseDir)
      });
      i++;
      continue;
    }

    // Task list (- [ ], - [x], with or without trailing text) - allow leading whitespace
    if (line.match(/^\s*[-*+]\s+\[[ xX]\](?:\s+(.*))?$/)) {
      const taskItems: TiptapNode[] = [];
      while (i < lines.length) {
        const taskMatch = lines[i].match(/^\s*[-*+]\s+\[([ xX])\](?:\s+(.*))?$/);
        if (!taskMatch) {
          break;
        }

        const isChecked = taskMatch[1].toLowerCase() === 'x';
        const text = taskMatch[2] ?? '';
        taskItems.push({
          type: 'taskItem',
          attrs: { checked: isChecked },
          content: [{
            type: 'paragraph',
            content: buildInlineParagraphContent(text, baseDir),
          }]
        });
        i++;
      }
      content.push({
        type: 'taskList',
        content: taskItems
      });
      continue;
    }

    // Bullet list - allow leading whitespace
    if (line.match(/^\s*[-*+]\s+/)) {
      const listItems: TiptapNode[] = [];
      while (i < lines.length && lines[i].match(/^\s*[-*+]\s+/) && !lines[i].match(/^\s*[-*+]\s+\[[ xX]\]/)) {
        const text = lines[i].replace(/^\s*[-*+]\s+/, '');
        listItems.push({
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: parseInlineContent(text, baseDir)
          }]
        });
        i++;
      }
      content.push({
        type: 'bulletList',
        content: listItems
      });
      continue;
    }

    // Numbered list
    if (line.match(/^\d+\.\s+/)) {
      const listItems: TiptapNode[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        const text = lines[i].replace(/^\d+\.\s+/, '');
        listItems.push({
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: parseInlineContent(text, baseDir)
          }]
        });
        i++;
      }
      content.push({
        type: 'orderedList',
        content: listItems
      });
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      content.push({
        type: 'blockquote',
        content: [{
          type: 'paragraph',
          content: parseInlineContent(quoteLines.join('\n'), baseDir)
        }]
      });
      continue;
    }

    // Code block
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++; // Skip opening ```
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // Skip closing ```
      content.push({
        type: 'codeBlock',
        content: [{
          type: 'text',
          text: codeLines.join('\n')
        }]
      });
      continue;
    }

    // Horizontal rule
    if (line.match(/^(---|\*\*\*|___)$/)) {
      content.push({
        type: 'horizontalRule'
      });
      i++;
      continue;
    }

    // Table (starts with |)
    if (line.trim().startsWith('|')) {
      const tableRows: string[] = [];
      let headerSeparatorIndex = -1;

      // Collect table rows
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const trimmedLine = lines[i].trim();
        tableRows.push(trimmedLine);

        // Check if this is the header separator row (|---|---|)
        if (trimmedLine.match(/^\|[\s:-]+\|/)) {
          headerSeparatorIndex = tableRows.length - 1;
        }
        i++;
      }

      if (tableRows.length > 0 && headerSeparatorIndex > 0) {
        // Parse table
        const tableNode = parseTable(tableRows, headerSeparatorIndex, baseDir);
        if (tableNode) {
          content.push(tableNode);
        }
      }
      continue;
    }

    // Empty line - preserve as empty paragraph for proper spacing
    if (line.trim() === '') {
      content.push({
        type: 'paragraph',
        content: []
      });
      i++;
      continue;
    }

    // Regular paragraph
    content.push({
      type: 'paragraph',
      content: parseInlineContent(line, baseDir)
    });
    i++;
  }

  // If no content, add an empty paragraph
  if (content.length === 0) {
    content.push({
      type: 'paragraph',
      content: []
    });
  }

  return {
    type: 'doc',
    content
  };
}

function parseTable(rows: string[], headerSeparatorIndex: number, baseDir?: string): TiptapNode | null {
  const tableContent: TiptapNode[] = [];

  // Parse header rows (rows before separator)
  for (let i = 0; i < headerSeparatorIndex; i++) {
    const cells = rows[i].split('|').filter(cell => cell.trim() !== '');
    const rowContent: TiptapNode[] = cells.map(cell => ({
      type: 'tableHeader',
      content: [{
        type: 'paragraph',
        content: parseInlineContent(cell.trim(), baseDir)
      }]
    }));

    tableContent.push({
      type: 'tableRow',
      content: rowContent
    });
  }

  // Parse body rows (rows after separator)
  for (let i = headerSeparatorIndex + 1; i < rows.length; i++) {
    const cells = rows[i].split('|').filter(cell => cell.trim() !== '');
    const rowContent: TiptapNode[] = cells.map(cell => ({
      type: 'tableCell',
      content: [{
        type: 'paragraph',
        content: parseInlineContent(cell.trim(), baseDir)
      }]
    }));

    tableContent.push({
      type: 'tableRow',
      content: rowContent
    });
  }

  return {
    type: 'table',
    content: tableContent
  };
}

function parseInlineContent(text: string, baseDir?: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Wikilink ([[Target]], [[Target|Display]], [[Target#Heading]], [[Target#Heading|Display]])
    const wikilinkMatch = remaining.match(/^\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/);
    if (wikilinkMatch) {
      const rawTarget = wikilinkMatch[1].trim();
      const rawDisplay = wikilinkMatch[2]?.trim();
      if (rawTarget) {
        let target = rawTarget;
        let fragment: string | null = null;
        const hashIndex = rawTarget.indexOf('#');
        if (hashIndex >= 0) {
          target = rawTarget.slice(0, hashIndex).trim();
          const frag = rawTarget.slice(hashIndex + 1).trim();
          fragment = frag.length > 0 ? frag : null;
        }
        if (target) {
          nodes.push({
            type: 'wikilink',
            attrs: {
              target,
              fragment,
              display: rawDisplay && rawDisplay.length > 0 ? rawDisplay : null,
            },
          });
          remaining = remaining.slice(wikilinkMatch[0].length);
          continue;
        }
      }
    }

    // File mention (@[label](path)) — backward compatible legacy format
    const mentionMatch = remaining.match(/^@\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)/);
    if (mentionMatch) {
      const label = mentionMatch[1];
      const href = decodeMdHref(mentionMatch[2]);
      const parsed = parseLocalLink(href);
      const resolvedPath = parsed ? resolveLocalPath(parsed.path, baseDir) : href;
      const itemType = inferLocalLinkItemType({
        href,
        path: resolvedPath,
        fragment: parsed?.fragment,
        lineStart: parsed?.lineStart,
        lineEnd: parsed?.lineEnd,
      });
      const canonicalPath = canonicalizeLocalLinkPath(resolvedPath, itemType);
      nodes.push({
        type: 'fileMention',
        attrs: {
          id: canonicalPath,
          label,
          itemType,
          ...(parsed?.fragment ? { fragment: parsed.fragment } : {}),
          ...(parsed?.lineStart !== undefined ? { lineStart: parsed.lineStart } : {}),
          ...(parsed?.lineEnd !== undefined ? { lineEnd: parsed.lineEnd } : {}),
        }
      });
      remaining = remaining.slice(mentionMatch[0].length);
      continue;
    }

    // Linked image ([![alt](img-src)](href)) with optional {width=N%}
    const linkedWrapMatch = remaining.match(/^\[!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+)\)\]\(((?:[^()]|\([^()]*\))+)\)(?:\{width=([^}]+)\})?/);
    if (linkedWrapMatch) {
      nodes.push({
        type: 'image',
        attrs: {
          src: decodeMdHref(linkedWrapMatch[2]),
          alt: linkedWrapMatch[1] || null,
          href: decodeMdHref(linkedWrapMatch[3]),
          ...(linkedWrapMatch[4] ? { width: linkedWrapMatch[4] } : {}),
        }
      });
      remaining = remaining.slice(linkedWrapMatch[0].length);
      continue;
    }

    // Image (![alt](url)) with optional {width=N%} suffix
    const imageMatch = remaining.match(/^!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+)\)(?:\{width=([^}]+)\})?/);
    if (imageMatch) {
      nodes.push({
        type: 'image',
        attrs: {
          src: decodeMdHref(imageMatch[2]),
          alt: imageMatch[1] || null,
          ...(imageMatch[3] ? { width: imageMatch[3] } : {}),
        }
      });
      remaining = remaining.slice(imageMatch[0].length);
      continue;
    }

    // Bold (**text** or __text__)
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch) {
      nodes.push(...applyMarkToInlineNodes(parseInlineContent(boldMatch[2], baseDir), { type: 'bold' }));
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic (*text* or _text_)
    const italicMatch = remaining.match(/^(\*|_)(.+?)\1/);
    if (italicMatch) {
      nodes.push(...applyMarkToInlineNodes(parseInlineContent(italicMatch[2], baseDir), { type: 'italic' }));
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Strikethrough (~~text~~)
    const strikeMatch = remaining.match(/^~~(.+?)~~/);
    if (strikeMatch) {
      nodes.push(...applyMarkToInlineNodes(parseInlineContent(strikeMatch[1], baseDir), { type: 'strike' }));
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    // Inline code (`code`)
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      nodes.push({
        type: 'text',
        text: codeMatch[1],
        marks: [{ type: 'code' }]
      });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Link ([text](url)) — local file links become fileMention nodes
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)/);
    if (linkMatch) {
      const linkText = linkMatch[1];
      const href = decodeMdHref(linkMatch[2]);

      if (isLocalFileLink(href)) {
        // Local file link → fileMention node
        const parsed = parseLocalLink(href);
        const resolvedPath = parsed ? resolveLocalPath(parsed.path, baseDir) : href;
        const itemType = inferLocalLinkItemType({
          href,
          path: resolvedPath,
          fragment: parsed?.fragment,
          lineStart: parsed?.lineStart,
          lineEnd: parsed?.lineEnd,
        });
        const canonicalPath = canonicalizeLocalLinkPath(resolvedPath, itemType);
        nodes.push({
          type: 'fileMention',
          attrs: {
            id: canonicalPath,
            label: linkText,
            itemType,
            ...(parsed?.fragment ? { fragment: parsed.fragment } : {}),
            ...(parsed?.lineStart !== undefined ? { lineStart: parsed.lineStart } : {}),
            ...(parsed?.lineEnd !== undefined ? { lineEnd: parsed.lineEnd } : {}),
          }
        });
      } else {
        // External link → keep as text with link mark
        nodes.push({
          type: 'text',
          text: linkText,
          marks: [{ type: 'link', attrs: { href } }]
        });
      }
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text (until next special character)
    const plainMatch = remaining.match(/^([^*_`~!\[@]+)/);
    if (plainMatch) {
      nodes.push({
        type: 'text',
        text: plainMatch[1]
      });
      remaining = remaining.slice(plainMatch[0].length);
      continue;
    }

    // Fallback: single character
    nodes.push({
      type: 'text',
      text: remaining[0]
    });
    remaining = remaining.slice(1);
  }

  return nodes;
}

function applyMarkToInlineNodes(nodes: TiptapNode[], mark: TiptapMark): TiptapNode[] {
  return nodes.map((node) => {
    if (node.type !== 'text') {
      return node;
    }

    const marks = node.marks ? [...node.marks] : [];
    if (!marks.some((existingMark) => existingMark.type === mark.type)) {
      marks.push(mark);
    }

    return {
      ...node,
      marks,
    };
  });
}

export function tiptapToMarkdown(doc: { content?: TiptapNode[] } | null | undefined): string {
  if (!doc || !doc.content || !Array.isArray(doc.content)) return '';

  return doc.content.map(node => nodeToMarkdown(node)).join('\n');
}

function nodeToMarkdown(node: TiptapNode): string {
  switch (node.type) {
    case 'heading':
      const level = (typeof node.attrs?.level === 'number' ? node.attrs?.level : 1) as number;
      const headingText = node.content?.map(n => inlineNodeToMarkdown(n)).join('') || '';
      return '#'.repeat(level) + ' ' + headingText;

    case 'paragraph':
      // Preserve empty paragraphs as empty lines for proper spacing
      if (!node.content || node.content.length === 0) {
        return '';
      }
      return node.content.map(n => inlineNodeToMarkdown(n)).join('');

    case 'bulletList':
      return node.content?.map(item => {
        const text = item.content?.[0]?.content?.map(n => inlineNodeToMarkdown(n)).join('') || '';
        return '- ' + text;
      }).join('\n') || '';

    case 'taskList':
      return node.content?.map(item => {
        const checked = item.attrs?.checked ? 'x' : ' ';
        const text = item.content?.[0]?.content?.map(n => inlineNodeToMarkdown(n)).join('') || '';
        return text.trim().length === 0
          ? `- [${checked}]`
          : `- [${checked}] ${text}`;
      }).join('\n') || '';

    case 'orderedList':
      return node.content?.map((item, i) => {
        const text = item.content?.[0]?.content?.map(n => inlineNodeToMarkdown(n)).join('') || '';
        return `${i + 1}. ` + text;
      }).join('\n') || '';

    case 'blockquote':
      const quoteText = node.content?.map(n => nodeToMarkdown(n)).join('\n') || '';
      return quoteText.split('\n').map(line => '> ' + line).join('\n');

    case 'codeBlock':
      const code = node.content?.[0]?.text || '';
      return '```\n' + code + '\n```';

    case 'horizontalRule':
      return '---';

    case 'table':
      return tableToMarkdown(node);

    case 'image': {
      const src = (node.attrs?.src as string) || '';
      const alt = (node.attrs?.alt as string) || '';
      const href = (node.attrs?.href as string) || '';
      const width = (node.attrs?.width as string) || '';
      const widthSuffix = width && width !== '50%' ? `{width=${width}}` : '';
      if (href) {
        return `[![${alt}](${src})](${href})${widthSuffix}`;
      }
      return `![${alt}](${src})${widthSuffix}`;
    }

    case 'fileMention': {
      return serializeFileMention(node);
    }

    default:
      return '';
  }
}

function tableToMarkdown(tableNode: TiptapNode): string {
  if (!tableNode.content || tableNode.content.length === 0) return '';

  const rows: string[] = [];
  let isFirstRow = true;

  for (const row of tableNode.content) {
    if (row.type !== 'tableRow' || !row.content) continue;

    const cells = row.content.map(cell => {
      const cellContent = cell.content?.[0]?.content?.map(n => inlineNodeToMarkdown(n)).join('') || '';
      return cellContent;
    });

    rows.push('| ' + cells.join(' | ') + ' |');

    // Add separator after first row (header)
    if (isFirstRow) {
      const separator = '| ' + cells.map(() => '---').join(' | ') + ' |';
      rows.push(separator);
      isFirstRow = false;
    }
  }

  return rows.join('\n');
}

function inlineNodeToMarkdown(node: TiptapNode): string {
  // Handle wikilink nodes — serialize as [[target]], [[target|display]], or [[target#fragment]]
  if (node.type === 'wikilink') {
    const target = (node.attrs?.target as string) || '';
    const fragment = node.attrs?.fragment as string | null | undefined;
    const display = node.attrs?.display as string | null | undefined;
    if (!target) return '';
    const targetWithFragment = fragment ? `${target}#${fragment}` : target;
    return display ? `[[${targetWithFragment}|${display}]]` : `[[${targetWithFragment}]]`;
  }

  // Handle fileMention nodes — serialize as standard markdown links
  if (node.type === 'fileMention') {
    return serializeFileMention(node);
  }

  // Handle image nodes
  if (node.type === 'image') {
    const src = (node.attrs?.src as string) || '';
    const alt = (node.attrs?.alt as string) || '';
    const href = (node.attrs?.href as string) || '';
    const width = (node.attrs?.width as string) || '';
    const widthSuffix = width && width !== '50%' ? `{width=${width}}` : '';
    if (href) {
      return `[![${alt}](${src})](${href})${widthSuffix}`;
    }
    return `![${alt}](${src})${widthSuffix}`;
  }

  if (node.type !== 'text' || !node.text) return '';

  let text = node.text;

  if (node.marks) {
    for (const mark of node.marks) {
      switch (mark.type) {
        case 'bold':
          text = `**${text}**`;
          break;
        case 'italic':
          text = `*${text}*`;
          break;
        case 'strike':
          text = `~~${text}~~`;
          break;
        case 'code':
          text = `\`${text}\``;
          break;
        case 'link':
          text = `[${text}](${mark.attrs?.href || ''})`;
          break;
      }
    }
  }

  return text;
}

/**
 * Decode percent-encoded parentheses in a markdown link href.
 */
function decodeMdHref(href: string): string {
  return href.replace(/%28/g, '(').replace(/%29/g, ')');
}

/**
 * Serialize a fileMention node as a standard markdown link [label](path#fragment:L10-L20)
 */
function serializeFileMention(node: TiptapNode): string {
  const label = (node.attrs?.label as string) || '';
  const id = (node.attrs?.id as string) || '';
  const itemType = (node.attrs?.itemType as 'file' | 'directory' | undefined) || 'file';
  const fragment = node.attrs?.fragment as string | undefined;
  const lineStart = node.attrs?.lineStart as number | undefined;
  const lineEnd = node.attrs?.lineEnd as number | undefined;

  return `[${label}](${serializeLocalLinkHref({
    path: id,
    itemType,
    fragment,
    lineStart,
    lineEnd,
  })})`;
}

/**
 * Resolve local paths against baseDir with shared cross-platform path helpers.
 */
function resolveLocalPath(path: string, baseDir?: string): string {
  if (!baseDir) return path;
  if (path.includes('://')) return path;
  return pathResolve(baseDir, path);
}
