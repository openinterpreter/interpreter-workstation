/**
 * Format Workstation Context for LLM Consumption
 *
 * Converts WorkstationContext into a human-readable format
 * suitable for inclusion in LLM prompts.
 */

import type {
  WorkstationContext,
  FileTabContext,
  OfficeSelection,
  OfficeSelectedObject,
  Selection,
  TextSelection,
} from '../types/workstation';

const MAX_SELECTION_TEXT_LENGTH = 500;

/**
 * Formats the workstation context into a structured string for LLM consumption.
 *
 * The output is designed to be:
 * - Human-readable for debugging
 * - Concise to minimize token usage
 * - Informative to give the LLM full context about the UI state
 *
 * @param context - The workstation context to format
 * @returns A formatted string representation of the context
 */
export function formatWorkstationContext(context: WorkstationContext): string {
  const sections: string[] = [];

  // The active folder is already carried natively via Interpreter `cwd`, so keep it
  // out of the hidden prompt context to avoid stale folder text and cache churn.
  const tabLines = formatTabs(context.tabs);
  if (tabLines.length > 0) {
    sections.push(tabLines.join('\n\n'));
  }

  // Selection section
  if (context.selection) {
    sections.push(formatSelection(context.selection));
  }

  // Sidebars section (only if relevant)
  const sidebarInfo = formatSidebars(context.sidebars);
  if (sidebarInfo) {
    sections.push(sidebarInfo);
  }

  return sections.join('\n\n');
}

/**
 * Formats the tabs context into an array of formatted lines
 */
function formatTabs(tabs: WorkstationContext['tabs']): string[] {
  const lines: string[] = [];
  const fileLines = tabs.files.map(formatFileTab);
  if (fileLines.length > 0) {
    lines.push(`Open Files:\n${fileLines.join('\n')}`);
  }

  const browserLines = tabs.browsers.map(formatBrowserTab);
  if (browserLines.length > 0) {
    lines.push(`Browser-Control Tabs:\n${browserLines.join('\n')}`);
  }

  return lines;
}

/**
 * Formats a single file tab
 */
function formatFileTab(file: FileTabContext): string {
  const activeMarker = file.isActive ? ' [active]' : '';
  return `  - ${file.path}${activeMarker}`;
}

function formatBrowserTab(tab: WorkstationContext['tabs']['browsers'][number]): string {
  const title = tab.title || tab.url || 'Untitled';
  const url = tab.url ? ` (${tab.url})` : '';
  const activeMarker = tab.isActive ? ' [active]' : '';
  return `  - ${title}${url} [tab_id: ${tab.browserId}]${activeMarker}`;
}

/**
 * Formats a selection (text or files) for LLM context
 */
function formatSelection(selection: Selection): string {
  switch (selection.type) {
    case 'text': {
      const sourceDesc = formatSelectionSource(selection.source);
      const text = truncateSelectionText(selection.text);
      return `Selected Text (from ${sourceDesc}):\n\`\`\`\n${text}\n\`\`\``;
    }
    case 'files': {
      return `Selected Files:\n${selection.items.map(i => `  - [${i.kind}] ${i.path}`).join('\n')}`;
    }
    case 'office':
      return formatOfficeSelection(selection);
    case 'pdf':
      return formatPdfSelection(selection);
  }
}

function formatPdfSelection(selection: Extract<Selection, { type: 'pdf' }>): string {
  const idPart = selection.fieldId ? ` [${selection.fieldId}]` : '';
  const valuePart = selection.value === undefined || selection.value === null || selection.value === ''
    ? ''
    : `\nCurrent value: ${Array.isArray(selection.value) ? selection.value.join(', ') : String(selection.value)}`;
  const actionHint = selection.fieldId
    ? `Use builtin-pdf fill_pdf_form with fields: [{ "id": "${selection.fieldId}", "value": ... }].`
    : 'Use builtin-pdf read_pdf first to get this field\'s fN id before calling fill_pdf_form.';
  return `Selected PDF Form Field (from ${selection.filePath}, page ${selection.page}):\n${idPart} "${selection.fieldName}" (${selection.fieldType})${valuePart}\n${actionHint}`;
}

export function formatOfficeSelection(selection: OfficeSelection): string {
  switch (selection.kind) {
    case 'cell': {
      const locationParts = [selection.filePath];
      if (typeof selection.sheetIndex === 'number') {
        locationParts.push(`sheet ${selection.sheetIndex}`);
      }
      if (selection.range) {
        locationParts.push(`range ${selection.range}`);
      } else if (selection.cell) {
        locationParts.push(`cell ${selection.cell}`);
      }
      if (selection.activeCell) {
        locationParts.push(`active ${selection.activeCell}`);
      }
      const text = selection.text ? `\n\`\`\`\n${truncateSelectionText(selection.text)}\n\`\`\`` : '';
      return `Selected Office Cell (from ${locationParts.join(', ')}):${text}`;
    }
    case 'text':
      return `Selected Office Text (from ${selection.filePath}):\n\`\`\`\n${truncateSelectionText(selection.text)}\n\`\`\``;
    case 'image':
    case 'object':
      return `Selected Office ${capitalize(selection.kind)} (from ${selection.filePath}):\n${formatOfficeObjects(selection.objects)}`;
  }
}

export function formatOfficeSelectionInline(selection: OfficeSelection): string {
  switch (selection.kind) {
    case 'cell': {
      const location = selection.range ?? selection.cell ?? 'cell';
      const text = selection.text ? `: ${truncateSelectionText(selection.text)}` : '';
      return `[Selected Office Cell from ${selection.filePath} (${location})]${text}`;
    }
    case 'text':
      return `[Selected Office Text from ${selection.filePath}]:\n\`\`\`\n${truncateSelectionText(selection.text)}\n\`\`\``;
    case 'image':
    case 'object':
      return `[Selected Office ${capitalize(selection.kind)} from ${selection.filePath}]\n${formatOfficeObjects(selection.objects)}`;
  }
}

export function getOfficeSelectionPreview(selection: OfficeSelection): string {
  switch (selection.kind) {
    case 'cell':
      return `Office ${selection.range ?? selection.cell ?? 'cell'}${selection.text ? `: ${selection.text}` : ''}`;
    case 'text':
      return selection.text;
    case 'image':
    case 'object':
      return `Office ${selection.kind}: ${selection.objects.map(formatOfficeObjectLabel).join(', ')}`;
  }
}

function formatOfficeObjects(objects: OfficeSelectedObject[]): string {
  if (objects.length === 0) {
    return '  - (no object details)';
  }

  return objects.map(object => `  - ${formatOfficeObjectLabel(object)}`).join('\n');
}

function formatOfficeObjectLabel(object: OfficeSelectedObject): string {
  const type = object.type ?? 'object';
  const id = object.id ? ` ${object.id}` : '';
  const label = object.imageName ?? object.value;
  return label ? `${type}${id}: ${label}` : `${type}${id}`;
}

function truncateSelectionText(text: string): string {
  return text.length > MAX_SELECTION_TEXT_LENGTH
    ? text.substring(0, MAX_SELECTION_TEXT_LENGTH) + '...'
    : text;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Formats the selection source into a human-readable description
 */
function formatSelectionSource(source: TextSelection['source']): string {
  switch (source.type) {
    case 'file':
      return `${source.path}:${source.startLine}-${source.endLine}`;
    case 'pdf':
      return `${source.path} (page ${source.page})`;
    case 'browser':
      return `browser tab ${source.browserId}`;
    case 'email':
      return `email ${source.emailId}`;
    case 'unknown':
      return 'unknown source';
  }
}

/**
 * Formats sidebar state (only returns non-empty string if sidebars are open)
 */
function formatSidebars(sidebars: WorkstationContext['sidebars']): string | null {
  const parts: string[] = [];

  if (sidebars.left.isOpen) {
    parts.push(`Left sidebar: ${sidebars.left.activeTab}`);
  }

  if (sidebars.right.isOpen) {
    parts.push('Right sidebar: pinned agents');
  }

  if (parts.length === 0) {
    return null;
  }

  return `Sidebars:\n  - ${parts.join('\n  - ')}`;
}

/**
 * Creates an empty WorkstationContext with default values.
 * Useful for initialization or testing.
 */
/**
 * XML tag used to wrap workstation context in user messages.
 */
export const WORKSTATION_CONTEXT_TAG = 'workstation-context';

/**
 * Strip workstation context from a message for display.
 * Removes the <workstation-context>...</workstation-context> block and any trailing newlines.
 */
export function stripWorkstationContext(text: string): string {
  if (!text) return text;
  const regex = new RegExp(
    `<${WORKSTATION_CONTEXT_TAG}>\\n[\\s\\S]*?\\n<\\/${WORKSTATION_CONTEXT_TAG}>\\n*`,
    'g'
  );
  return text.replace(regex, '').trim();
}

/**
 * Strip markdown file links to just their display text.
 * Handles both standard [text](url) and angle-bracket [text](<url>) syntax.
 * Used for single-line text contexts (tab labels, sticky headers, previews).
 */
export function stripFileLinks(text: string): string {
  if (!text) return text;
  return text
    .replace(/\[([^\]]+)\]\(<[^>]*>\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/**
 * Check if a message contains workstation context.
 */
export function hasWorkstationContext(text: string): boolean {
  if (!text) return false;
  return text.includes(`<${WORKSTATION_CONTEXT_TAG}>`);
}

export function createEmptyWorkstationContext(): WorkstationContext {
  return {
    workspace: null,
    tabs: {
      files: [],
      browsers: [],
      emails: [],
    },
    selection: null,
    sidebars: {
      left: { isOpen: false, activeTab: 'explorer' },
      right: { isOpen: false },
    },
  };
}
