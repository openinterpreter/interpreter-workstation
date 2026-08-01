/**
 * ContextPreview Component
 *
 * Displays the current workstation context that will be sent with the next message.
 * Renders as a compact pill in the composer controls with a hover popover for details.
 * Calculates and displays the DIFF from the last sent context.
 */

import { FC, useContext, useState, useRef, useEffect } from 'react';
import { Folder, X } from 'lucide-react';
import { Button } from '../../../src/components/ui/button';
import { LayoutContext } from '../../../src/contexts/LayoutContext';
import type { WorkstationContext, Selection, SelectionSource } from '../../../shared/types/workstation';
import {
  formatOfficeSelectionInline,
  getOfficeSelectionPreview,
  WORKSTATION_CONTEXT_TAG,
} from '../../../shared/utils/formatWorkstationContext';
import { thumbnailCache } from '../../../src/components/explorer/thumbnailCache';
import { pathBasename } from '@/ipc';

/**
 * Calculate what changed between two contexts
 */
export interface ContextDiff {
  hasChanges: boolean;
  addedFiles: string[];
  removedFiles: string[];
  addedBrowsers: Array<{ browserId: string; url: string; title: string }>;
  removedBrowsers: Array<{ browserId: string; url: string; title: string }>;
  addedEmails: Array<{ emailId: string; subject: string }>;
  removedEmails: Array<{ emailId: string; subject: string }>;
  selectionChanged: boolean;
  newSelection: Selection | null;
}

export function calculateContextDiff(
  previous: WorkstationContext | null,
  current: WorkstationContext | null
): ContextDiff {
  const diff: ContextDiff = {
    hasChanges: false,
    addedFiles: [],
    removedFiles: [],
    addedBrowsers: [],
    removedBrowsers: [],
    addedEmails: [],
    removedEmails: [],
    selectionChanged: false,
    newSelection: null,
  };

  if (!current) return diff;

  // Compare files
  const prevFiles = new Set(previous?.tabs.files.map(f => f.path) || []);
  const currFiles = new Set(current.tabs.files.map(f => f.path));

  for (const file of currFiles) {
    if (!prevFiles.has(file)) {
      diff.addedFiles.push(file);
      diff.hasChanges = true;
    }
  }
  for (const file of prevFiles) {
    if (!currFiles.has(file)) {
      diff.removedFiles.push(file);
      diff.hasChanges = true;
    }
  }

  // Compare browsers
  const prevBrowsers = new Map(previous?.tabs.browsers.map(b => [b.browserId, b]) || []);
  const currBrowsers = new Map(current.tabs.browsers.map(b => [b.browserId, b]));

  for (const [id, browser] of currBrowsers) {
    if (!prevBrowsers.has(id)) {
      diff.addedBrowsers.push({ browserId: browser.browserId, url: browser.url, title: browser.title });
      diff.hasChanges = true;
    }
  }
  for (const [id, browser] of prevBrowsers) {
    if (!currBrowsers.has(id)) {
      diff.removedBrowsers.push({ browserId: browser.browserId, url: browser.url, title: browser.title });
      diff.hasChanges = true;
    }
  }

  // Compare emails
  const prevEmails = new Map(previous?.tabs.emails.map(e => [e.emailId, e]) || []);
  const currEmails = new Map(current.tabs.emails.map(e => [e.emailId, e]));

  for (const [id, email] of currEmails) {
    if (!prevEmails.has(id)) {
      diff.addedEmails.push({ emailId: email.emailId, subject: email.subject });
      diff.hasChanges = true;
    }
  }
  for (const [id, email] of prevEmails) {
    if (!currEmails.has(id)) {
      diff.removedEmails.push({ emailId: email.emailId, subject: email.subject });
      diff.hasChanges = true;
    }
  }

  // Compare selection - always show if there's a current selection
  // (User should be able to reference the same selection multiple times)
  if (current.selection) {
    if (current.selection.type === 'text' && current.selection.text) {
      diff.selectionChanged = true;
      diff.newSelection = current.selection;
      diff.hasChanges = true;
    } else if (current.selection.type === 'files' && current.selection.items.length > 0) {
      diff.selectionChanged = true;
      diff.newSelection = current.selection;
      diff.hasChanges = true;
    } else if (current.selection.type === 'office') {
      diff.selectionChanged = true;
      diff.newSelection = current.selection;
      diff.hasChanges = true;
    } else if (current.selection.type === 'pdf') {
      diff.selectionChanged = true;
      diff.newSelection = current.selection;
      diff.hasChanges = true;
    }
  }

  return diff;
}


/**
 * Format the context diff as a string for embedding in messages.
 * Wraps the context in XML tags so it can be hidden from the UI.
 */
export function formatContextDiffForMessage(diff: ContextDiff): string {
  if (!diff.hasChanges) return '';

  const parts: string[] = [];

  if (diff.addedFiles.length > 0) {
    // Include full paths so the agent knows exactly which files are open
    parts.push(`[Opened: ${diff.addedFiles.join(', ')}]`);
  }

  if (diff.removedFiles.length > 0) {
    // Include full paths for consistency
    parts.push(`[Closed: ${diff.removedFiles.join(', ')}]`);
  }

  if (diff.addedBrowsers.length > 0) {
    const browsers = diff.addedBrowsers.map(b => `${b.title || b.url} (tab_id: ${b.browserId})`).join(', ');
    parts.push(`[Browsing: ${browsers}]`);
  }

  if (diff.addedEmails.length > 0) {
    const emails = diff.addedEmails.map(e => `"${e.subject}" (email_id: ${e.emailId})`).join(', ');
    parts.push(`[Viewing email: ${emails}]`);
  }

  if (diff.selectionChanged && diff.newSelection) {
    if (diff.newSelection.type === 'text') {
      const source = formatSelectionSource(diff.newSelection.source);
      parts.push(`[Selected from ${source}]:\n\`\`\`\n${diff.newSelection.text}\n\`\`\``);
    } else if (diff.newSelection.type === 'files') {
      parts.push(`[Selected files: ${diff.newSelection.items.map(item => `${item.kind}:${item.path}`).join(', ')}]`);
    } else if (diff.newSelection.type === 'office') {
      parts.push(formatOfficeSelectionInline(diff.newSelection));
    }
  }

  const content = parts.join(' ');
  // Wrap in XML tags so we can strip it from UI display
  return `<${WORKSTATION_CONTEXT_TAG}>\n${content}\n</${WORKSTATION_CONTEXT_TAG}>`;
}

/**
 * Extract the workstation context from a message (without the XML tags).
 * Returns null if no context is present.
 */
export function extractWorkstationContext(text: string): string | null {
  if (!text) return null;

  const regex = new RegExp(
    `<${WORKSTATION_CONTEXT_TAG}>\\n([\\s\\S]*?)\\n<\\/${WORKSTATION_CONTEXT_TAG}>`,
    ''
  );

  const match = text.match(regex);
  return match ? match[1] : null;
}

function formatSelectionSource(source: SelectionSource): string {
  switch (source.type) {
    case 'file': {
      // Use full path so the agent knows exactly which file the selection is from
      if (source.startLine === source.endLine) {
        return `${source.path}:${source.startLine}`;
      }
      return `${source.path}:${source.startLine}-${source.endLine}`;
    }
    case 'pdf': {
      // Use full path for PDFs too
      return `${source.path} (page ${source.page})`;
    }
    case 'browser':
      return 'browser';
    case 'email':
      return 'email';
    default:
      return 'selection';
  }
}

/**
 * Context for tracking the last sent context PER AGENT
 * Key: agentId, Value: WorkstationContext
 */
const lastSentContextByAgent: Map<string, WorkstationContext> = new Map();

export function getLastSentContext(agentId: string): WorkstationContext | null {
  return lastSentContextByAgent.get(agentId) ?? null;
}

export function setLastSentContext(agentId: string, ctx: WorkstationContext | null): void {
  if (ctx) {
    lastSentContextByAgent.set(agentId, ctx);
  } else {
    lastSentContextByAgent.delete(agentId);
  }
}

/**
 * Track whether context sending is enabled per agent (default: true)
 */
const contextEnabledByAgent: Map<string, boolean> = new Map();

export function isContextEnabled(agentId: string): boolean {
  return contextEnabledByAgent.get(agentId) ?? true;
}

export function setContextEnabled(agentId: string, enabled: boolean): void {
  contextEnabledByAgent.set(agentId, enabled);
}

/** Small thumbnail that subscribes to thumbnailCache for reactivity */
const FileThumbnail: FC<{ path: string; kind: 'file' | 'folder' }> = ({ path, kind }) => {
  const [thumbUrl, setThumbUrl] = useState<string | undefined>(() => thumbnailCache.get(path));

  useEffect(() => {
    if (kind === 'folder') return;
    // Check cache again in case it loaded between render and effect
    const cached = thumbnailCache.get(path);
    if (cached) setThumbUrl(cached);
    return thumbnailCache.subscribe(path, (url) => setThumbUrl(url));
  }, [path, kind]);

  const name = pathBasename(path) || path;

  if (kind === 'folder') {
    return (
      <div
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full"
        style={{
          background: 'var(--oa-bg-subtle, var(--hover-bg))',
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 52%, transparent)',
        }}
        title={name}
      >
        <Folder className="w-3.5 h-3.5 text-muted-foreground" />
      </div>
    );
  }

  if (thumbUrl) {
    return (
      <img
        src={thumbUrl}
        alt={name}
        title={name}
        className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
      />
    );
  }

  // Fallback: show first 2 chars of extension as a tiny badge
  const ext = name.includes('.') ? name.split('.').pop()?.slice(0, 3) ?? '' : '';
  return (
    <div
      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full"
      style={{
        background: 'var(--oa-bg-subtle, var(--hover-bg))',
        border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 52%, transparent)',
      }}
      title={name}
    >
      <span className="text-[8px] text-muted-foreground uppercase leading-none">{ext}</span>
    </div>
  );
};

interface ContextPreviewProps {
  agentId?: string;
}

export const ContextPreview: FC<ContextPreviewProps> = ({ agentId }) => {
  const layout = useContext(LayoutContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevTextRef = useRef<string>('');
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [opacity, setOpacity] = useState(0);
  const [isVisible, setIsVisible] = useState(false);

  const currentSelection = layout?.currentSelection;
  const currentContext = layout?.getWorkstationContext?.() ?? null;
  const contextWithLiveSelection = currentContext
    ? { ...currentContext, selection: currentSelection ?? null }
    : null;

  const lastContext = agentId ? getLastSentContext(agentId) : null;
  const diff = calculateContextDiff(lastContext, contextWithLiveSelection);

  const hasSelection = diff.selectionChanged && diff.newSelection;

  // Derive display values based on selection type
  const selectionText = hasSelection && diff.newSelection!.type === 'text'
    ? diff.newSelection!.text.replace(/\s+/g, ' ').trim()
    : hasSelection && diff.newSelection!.type === 'office'
      ? getOfficeSelectionPreview(diff.newSelection!).replace(/\s+/g, ' ').trim()
    : hasSelection && diff.newSelection!.type === 'pdf'
      ? `PDF field ${diff.newSelection!.fieldId ? `[${diff.newSelection!.fieldId}] ` : ''}${diff.newSelection!.fieldName}`.replace(/\s+/g, ' ').trim()
    : '';
  const selectedItems = hasSelection && diff.newSelection!.type === 'files'
    ? diff.newSelection!.items
    : [];
  const hasContent = !!selectionText || selectedItems.length > 0;

  // Detect direction from text changes
  useEffect(() => {
    const prevText = prevTextRef.current;

    if (selectionText && prevText && selectionText !== prevText) {
      if (selectionText.startsWith(prevText)) {
        setDirection('right');
      } else if (selectionText.endsWith(prevText)) {
        setDirection('left');
      }
    }

    prevTextRef.current = selectionText;
  }, [selectionText]);

  // Handle scroll position - run after every render
  useEffect(() => {
    if (!selectionText) return;

    const scroll = scrollRef.current;
    if (!scroll) return;

    // Check overflow
    const overflowing = scroll.scrollWidth > scroll.clientWidth + 1;
    setIsOverflowing(overflowing);

    // Scroll to follow direction
    if (overflowing) {
      if (direction === 'right') {
        scroll.scrollLeft = scroll.scrollWidth;
      } else {
        scroll.scrollLeft = 0;
      }
    }
  });

  // Fade in/out - track visibility separately for unmount delay
  useEffect(() => {
    if (hasContent) {
      setIsVisible(true);
      requestAnimationFrame(() => setOpacity(1));
    } else {
      setOpacity(0);
      // Delay hiding until fade completes
      const timeout = setTimeout(() => setIsVisible(false), 150);
      return () => clearTimeout(timeout);
    }
  }, [hasContent]);

  // Handle close button click - clear any selection
  const handleClose = () => {
    layout?.clearSelection();
  };

  if (!isVisible) {
    return null;
  }

  // Render file selection variant
  if (selectedItems.length > 0) {
    const MAX_VISIBLE = 4;
    const visibleItems = selectedItems.slice(0, MAX_VISIBLE);
    const remaining = selectedItems.length - MAX_VISIBLE;

    return (
      <div
        className="flex min-w-0 cursor-default items-center gap-1.5 overflow-hidden px-2 py-1 text-ui-sm text-muted-foreground"
        data-context-preview
        style={{
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border-inactive)) 58%, transparent)',
          borderRadius: '999px',
          background: 'color-mix(in srgb, var(--oa-bg-input, var(--background)) 92%, var(--oa-bg-subtle, var(--hover-bg)) 8%)',
          maxWidth: 'calc(100% - 40px)',
          width: 'fit-content',
          opacity,
          transform: opacity === 0 ? 'translateY(2px)' : 'translateY(0)',
          transition: 'opacity 150ms ease-out, transform 150ms ease-out',
        }}
      >
        {visibleItems.map((item) => (
          <FileThumbnail key={`${item.kind}:${item.path}`} path={item.path} kind={item.kind} />
        ))}
        {remaining > 0 && (
          <span className="text-ui-xs text-muted-foreground/70 flex-shrink-0 px-0.5">
            +{remaining}
          </span>
        )}
        {/* Close button */}
        <div className="ml-0.5 flex items-center" style={{ borderLeft: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border-inactive)) 52%, transparent)' }}>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleClose}
            className="size-6 rounded-full text-muted-foreground/55 hover:bg-transparent hover:text-muted-foreground"
          >
            <X className="w-3 h-3" />
          </Button>
        </div>
      </div>
    );
  }

  // Render text selection variant (existing behavior)
  return (
    <div
      className="flex min-w-0 cursor-default items-center overflow-hidden text-ui-sm text-muted-foreground"
      style={{
        border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border-inactive)) 58%, transparent)',
        borderRadius: '999px',
        background: 'color-mix(in srgb, var(--oa-bg-input, var(--background)) 92%, var(--oa-bg-subtle, var(--hover-bg)) 8%)',
        maxWidth: 'calc(100% - 40px)',
        width: 'fit-content',
        opacity,
        transform: opacity === 0 ? 'translateY(2px)' : 'translateY(0)',
        transition: 'opacity 150ms ease-out, transform 150ms ease-out',
      }}
    >
      {/* Text container */}
      <div className="min-w-0 relative">
        <div
          ref={scrollRef}
          className="overflow-x-auto whitespace-nowrap px-2 py-1 text-ui-xs"
          style={{
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          {selectionText}
        </div>

        {/* Left fade - uses inactive-bg to match sidebar background */}
        {isOverflowing && direction === 'right' && (
          <div
            className="pointer-events-none absolute inset-y-0 left-0 z-50 w-12 bg-gradient-to-r to-transparent"
            style={{ '--tw-gradient-from': 'var(--oa-bg-subtle, var(--inactive))' }}
          />
        )}

        {/* Right fade - uses inactive-bg to match sidebar background */}
        {isOverflowing && direction === 'left' && (
          <div
            className="pointer-events-none absolute inset-y-0 right-0 z-50 w-12 bg-gradient-to-l to-transparent"
            style={{ '--tw-gradient-from': 'var(--oa-bg-subtle, var(--inactive))' }}
          />
        )}
      </div>

      {/* Close button container with left border */}
      <div className="flex items-center" style={{ borderLeft: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border-inactive)) 52%, transparent)' }}>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleClose}
          className="size-6 rounded-full text-muted-foreground/55 hover:bg-transparent hover:text-muted-foreground"
        >
          <X className="w-3 h-3" />
        </Button>
      </div>

      <style>{`
        div[class*="overflow-x-auto"]::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
};

export default ContextPreview;
