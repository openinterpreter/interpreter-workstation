import { useEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { X } from 'lucide-react';

import { vault, workspace } from '@/ipc';
import { MARKDOWN_FRONTMATTER_CARD_ID } from '../../shared/element-ids';
import type { MarkdownFrontmatter } from '../utils/markdownFrontmatter';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

interface MarkdownFrontmatterCardProps {
  frontmatter: MarkdownFrontmatter | null;
  onChange: (key: string, value: unknown) => void;
  onClose: () => void;
  readOnly?: boolean;
  children?: ReactNode;
}

interface StringListSuggestion {
  value: string;
  noteCount?: number;
}

type SuggestionStatus = 'idle' | 'loading' | 'ready';

function formatFieldLabel(key: string): string {
  const normalized = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized === '') {
    return key;
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatInlineValue(value: unknown): string {
  if (value == null) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function parseScalarDraft(originalValue: unknown, draft: string): unknown {
  if (typeof originalValue === 'number') {
    const parsed = Number(draft);
    return Number.isFinite(parsed) ? parsed : originalValue;
  }

  if (typeof originalValue === 'boolean') {
    return draft.trim().toLowerCase() === 'true';
  }

  if (originalValue == null) {
    return draft.trim() === '' ? null : draft;
  }

  return draft;
}

function normalizeStringListEntry(rawValue: string, prefix?: string): string {
  let normalized = rawValue.trim();

  if (prefix && normalized.startsWith(prefix)) {
    normalized = normalized.slice(prefix.length);
  }

  return normalized.trim();
}

function EditableScalarValue({
  value,
  onCommit,
}: {
  value: string | number | boolean | null | undefined;
  onCommit: (value: unknown) => void;
}) {
  const multiline = typeof value === 'string' && value.includes('\n');
  const [draft, setDraft] = useState(formatInlineValue(value));

  useEffect(() => {
    setDraft(formatInlineValue(value));
  }, [value]);

  const commit = () => {
    onCommit(parseScalarDraft(value, draft));
  };

  if (multiline) {
    return (
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className="min-h-0 resize-none border-transparent bg-transparent px-0 py-0 text-ui-sm leading-6 shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0"
      />
    );
  }

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      className="h-auto border-transparent bg-transparent px-0 py-0 font-medium shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0"
    />
  );
}

function EditableJsonValue({
  value,
  onCommit,
}: {
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2));

  useEffect(() => {
    setDraft(JSON.stringify(value, null, 2));
  }, [value]);

  const commit = () => {
    try {
      onCommit(JSON.parse(draft));
    } catch {
      setDraft(JSON.stringify(value, null, 2));
    }
  };

  return (
    <Textarea
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      className="min-h-0 resize-none border-transparent bg-transparent px-0 py-0 font-mono text-ui-xs leading-5 shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:ring-0"
    />
  );
}

function EditableStringList({
  values,
  onCommit,
  prefix,
  emptyPlaceholder,
  onItemClick,
  suggestions,
  suggestionStatus,
  suggestionLabel,
}: {
  values: string[];
  onCommit: (value: string[]) => void;
  prefix?: string;
  emptyPlaceholder?: string;
  onItemClick?: (value: string) => void;
  suggestions?: StringListSuggestion[];
  suggestionStatus?: SuggestionStatus;
  suggestionLabel?: string;
}) {
  const [draftItems, setDraftItems] = useState<string[]>(values);
  const [pendingTag, setPendingTag] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    setDraftItems(values);
  }, [values]);

  const filteredSuggestions = useMemo(() => {
    const normalizedPending = normalizeStringListEntry(pendingTag, prefix).toLowerCase();

    return (suggestions ?? [])
      .filter((suggestion) => (
        normalizedPending === ''
        || suggestion.value.toLowerCase().includes(normalizedPending)
      ))
      .slice(0, 8);
  }, [draftItems, pendingTag, prefix, suggestions]);
  const supportsSuggestions = suggestionStatus !== undefined;
  const showSuggestionPopover = isInputFocused && supportsSuggestions;
  const showSuggestions = showSuggestionPopover && filteredSuggestions.length > 0;

  useEffect(() => {
    setActiveSuggestionIndex(0);
  }, [pendingTag]);

  useEffect(() => {
    if (activeSuggestionIndex >= filteredSuggestions.length) {
      setActiveSuggestionIndex(0);
    }
  }, [activeSuggestionIndex, filteredSuggestions.length]);

  const inputPlaceholder = draftItems.length === 0 ? (emptyPlaceholder ?? '+ Add') : '+';
  const showIdleAddPill = pendingTag === '' && !isInputFocused;

  const addTag = (rawTag: string) => {
    const normalized = normalizeStringListEntry(rawTag, prefix);
    if (!normalized || draftItems.includes(normalized)) {
      setPendingTag('');
      return;
    }

    const next = [...draftItems, normalized];
    setDraftItems(next);
    setPendingTag('');
    onCommit(next);
  };

  const removeTag = (tag: string) => {
    const next = draftItems.filter((entry) => entry !== tag);
    setDraftItems(next);
    onCommit(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestionIndex((currentIndex) =>
        currentIndex >= filteredSuggestions.length - 1 ? 0 : currentIndex + 1,
      );
      return;
    }

    if (showSuggestions && event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestionIndex((currentIndex) =>
        currentIndex <= 0 ? filteredSuggestions.length - 1 : currentIndex - 1,
      );
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      addTag(showSuggestions ? (filteredSuggestions[activeSuggestionIndex]?.value ?? pendingTag) : pendingTag);
      return;
    }

    if (event.key === ',') {
      event.preventDefault();
      addTag(pendingTag);
      return;
    }

    if (showSuggestions && event.key === 'Tab' && pendingTag.trim() !== '') {
      event.preventDefault();
      addTag(filteredSuggestions[activeSuggestionIndex]?.value ?? pendingTag);
      return;
    }

    if (event.key === 'Escape') {
      skipBlurCommitRef.current = true;
      setIsInputFocused(false);
      inputRef.current?.blur();
      return;
    }

    if (event.key === 'Backspace' && pendingTag === '' && draftItems.length > 0) {
      event.preventDefault();
      removeTag(draftItems[draftItems.length - 1]!);
    }
  };

  const handleItemMouseUp = (value: string) => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim() !== '') {
      return;
    }
    onItemClick?.(value);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    const nextFocusedTarget = event.relatedTarget as HTMLElement | null;
    if (nextFocusedTarget?.dataset.metadataSuggestion === 'true') {
      return;
    }

    setIsInputFocused(false);
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    addTag(pendingTag);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button')) {
          return;
        }

        if (document.activeElement !== inputRef.current) {
          event.preventDefault();
          setIsInputFocused(true);
          inputRef.current?.focus();
        }
      }}
    >
      {draftItems.map((tag) => (
        <span
          key={tag}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 py-1.5 text-ui-sm text-[var(--oa-text, var(--foreground))] transition-[background-color,color,border-color,filter] hover:brightness-110 hover:text-[var(--foreground)]"
          style={{
            border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 42%, transparent)',
            background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 30%, transparent)',
          }}
        >
          <span
            className={onItemClick ? 'cursor-pointer transition-[color,opacity] hover:opacity-100 hover:text-[var(--foreground)]' : undefined}
            onMouseUp={() => handleItemMouseUp(tag)}
          >
            {prefix ?? ''}{tag}
          </span>
          <button
            type="button"
            onClick={() => removeTag(tag)}
            aria-label={`Remove ${tag}`}
            className="inline-flex size-4 items-center justify-center rounded-full text-[var(--oa-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--oa-text, var(--foreground))] dark:hover:bg-white/[0.08]"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <div className="relative flex min-h-8 min-w-[10rem] flex-1 basis-[12rem] items-center cursor-text">
        {showIdleAddPill ? (
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              setIsInputFocused(true);
              window.requestAnimationFrame(() => inputRef.current?.focus());
            }}
            className="inline-flex min-h-8 items-center self-center rounded-full px-3 py-1.5 text-ui-sm text-[var(--oa-text-muted)] transition-[background-color,color,border-color,opacity] hover:text-[var(--foreground)]"
            style={{
              border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 30%, transparent)',
              background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 16%, transparent)',
              opacity: 0.78,
            }}
          >
            {inputPlaceholder}
          </button>
        ) : (
          <div
            className="inline-flex min-h-8 min-w-[8rem] items-center self-center rounded-full px-3 py-1.5"
            style={{
              border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 30%, transparent)',
              background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 16%, transparent)',
            }}
          >
            <Input
              ref={inputRef}
              value={pendingTag}
              onChange={(event) => {
                setPendingTag(event.target.value);
                setIsInputFocused(true);
              }}
              onFocus={() => setIsInputFocused(true)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              placeholder={inputPlaceholder}
              className="h-auto min-w-[1.5rem] self-center border-transparent bg-transparent px-0 py-0 text-ui-sm leading-normal text-[var(--oa-text)] shadow-none placeholder:text-[var(--oa-text-muted)] placeholder:opacity-45 hover:border-transparent focus-visible:border-transparent focus-visible:ring-0"
            />
          </div>
        )}
        {showSuggestionPopover ? (
          <div
            className="absolute left-0 top-full z-20 mt-2 w-[min(22rem,100%)] overflow-hidden rounded-[14px] p-1 backdrop-blur-xl"
            style={{
              border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)',
              background: 'color-mix(in srgb, var(--oa-surface-center, var(--background)) 90%, transparent)',
              boxShadow: '0 14px 40px rgba(0, 0, 0, 0.18)',
            }}
          >
            <div className="max-h-56 overflow-y-auto">
              {showSuggestions ? filteredSuggestions.map((suggestion, suggestionIndex) => {
                const isActive = suggestionIndex === activeSuggestionIndex;
                const isAlreadyAdded = draftItems.includes(suggestion.value);

                return (
                  <button
                    key={suggestion.value}
                    type="button"
                    data-metadata-suggestion="true"
                    disabled={isAlreadyAdded}
                    onMouseDown={(event) => {
                      if (isAlreadyAdded) {
                        return;
                      }
                      event.preventDefault();
                      addTag(suggestion.value);
                      setIsInputFocused(true);
                      inputRef.current?.focus();
                    }}
                    onMouseEnter={() => setActiveSuggestionIndex(suggestionIndex)}
                    className={`flex w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-left text-ui-sm transition-colors ${isAlreadyAdded ? 'cursor-default opacity-55' : ''} ${isActive && !isAlreadyAdded ? 'bg-hover text-[var(--foreground)]' : 'text-[var(--oa-text, var(--foreground))]'} ${!isAlreadyAdded ? 'hover:bg-hover/80' : ''}`}
                  >
                    <span className="truncate font-medium">{prefix ?? ''}{suggestion.value}</span>
                    <span className="shrink-0 text-ui-xs text-[var(--oa-text-muted)]">
                      {isAlreadyAdded
                        ? 'Added'
                        : typeof suggestion.noteCount === 'number'
                          ? `${suggestion.noteCount} ${suggestion.noteCount === 1 ? 'note' : 'notes'}`
                          : ''}
                    </span>
                  </button>
                );
              }) : (
                <div className="px-3 py-2 text-ui-sm text-[var(--oa-text-muted)]">
                  {suggestionStatus === 'loading'
                    ? `Loading ${suggestionLabel ?? 'items'}...`
                    : pendingTag.trim() !== ''
                      ? `Press enter to add ${suggestionLabel === 'tags' ? 'tag' : suggestionLabel ?? 'item'}`
                      : `No existing ${suggestionLabel ?? 'items'}`}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderFrontmatterEditor(
  key: string,
  value: unknown,
  onCommit: (value: unknown) => void,
  onSearchTermClick?: (value: string) => void,
  listSuggestions?: StringListSuggestion[],
  listSuggestionStatus?: SuggestionStatus,
): ReactNode {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    const normalizedKey = key.toLowerCase();
    return (
      <EditableStringList
        values={value}
        onCommit={onCommit}
        prefix={normalizedKey === 'tags' ? '#' : undefined}
        emptyPlaceholder="+ Add"
        onItemClick={onSearchTermClick}
        suggestions={normalizedKey === 'tags' ? listSuggestions : undefined}
        suggestionStatus={normalizedKey === 'tags' ? listSuggestionStatus : undefined}
        suggestionLabel={normalizedKey === 'tags' ? 'tags' : undefined}
      />
    );
  }

  if (
    typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || value == null
  ) {
    return <EditableScalarValue value={value} onCommit={onCommit} />;
  }

  return <EditableJsonValue value={value} onCommit={onCommit} />;
}

export function MarkdownFrontmatterCard({ frontmatter, onChange, onClose, readOnly = false, children }: MarkdownFrontmatterCardProps) {
  const preferredFieldOrder = ['title', 'aliases', 'tags'];
  const mergedData = preferredFieldOrder.reduce<Record<string, unknown>>((result, key) => {
    result[key] = frontmatter?.data[key] ?? (key === 'title' ? '' : []);
    return result;
  }, {});

  for (const [key, value] of Object.entries(frontmatter?.data ?? {})) {
    if (!(key in mergedData)) {
      mergedData[key] = value;
    }
  }

  const entries = Object.entries(mergedData);
  const [tagSuggestions, setTagSuggestions] = useState<StringListSuggestion[]>([]);
  const [tagSuggestionStatus, setTagSuggestionStatus] = useState<SuggestionStatus>('idle');

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;

    const loadTagSuggestions = async () => {
      setTagSuggestionStatus('loading');
      let snapshot: Awaited<ReturnType<typeof vault.getSnapshot>> | null = null;
      try {
        snapshot = await vault.getSnapshot();
      } catch {
        if (!cancelled) {
          setTagSuggestions([]);
          setTagSuggestionStatus('ready');
        }
      }

      if (cancelled || !snapshot) {
        return;
      }

      const tagCounts = new Map<string, number>();
      for (const note of snapshot.notes) {
        for (const tag of note.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      setTagSuggestions(
        Array.from(tagCounts.entries())
          .map(([value, noteCount]) => ({ value, noteCount }))
          .sort((a, b) => {
            if ((b.noteCount ?? 0) !== (a.noteCount ?? 0)) {
              return (b.noteCount ?? 0) - (a.noteCount ?? 0);
            }

            return a.value.localeCompare(b.value, undefined, { sensitivity: 'base', numeric: true });
          }),
      );
      setTagSuggestionStatus('ready');
    };

    void loadTagSuggestions();

    const unsubscribe = workspace.onFilesChanged(() => {
      void loadTagSuggestions();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [readOnly]);

  return (
    <section
      aria-label="Document metadata"
      data-testid={MARKDOWN_FRONTMATTER_CARD_ID}
      className="relative mb-6 rounded-[16px] border border-black/[0.06] bg-[var(--oa-surface-center)] shadow-[0_8px_30px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:shadow-[0_10px_32px_rgba(0,0,0,0.4)]"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Hide metadata"
        className="absolute right-5 top-5 inline-flex size-7 items-center justify-center rounded-[8px] text-[#6b7280] transition-colors hover:bg-black/[0.045] hover:text-[#202123] dark:text-[#b4b4b4] dark:hover:bg-white/[0.06] dark:hover:text-[#f5f5f5]"
      >
        <X className="size-4" />
      </button>

      <dl className="px-5 py-5 pr-14">
        <div className="space-y-6">
          {entries.map(([key, value]) => (
            <div
              key={key}
              className="grid min-h-[2.75rem] items-center gap-x-5 gap-y-2 md:grid-cols-[minmax(0,120px)_minmax(0,1fr)]"
            >
              <dt className="text-ui-sm text-[var(--oa-text-muted)]">
                {formatFieldLabel(key)}
              </dt>
              <dd className="min-w-0 min-h-5">
                {readOnly ? (
                  <span className="whitespace-pre-wrap break-words text-ui-sm font-medium">
                    {Array.isArray(value)
                      ? value.map(formatInlineValue).join(', ')
                      : formatInlineValue(value)}
                  </span>
                ) : renderFrontmatterEditor(key, value, (nextValue) => onChange(key, nextValue), (searchValue) => {
                  window.dispatchEvent(new CustomEvent('explorer:set-search-query', {
                  detail: {
                    query: key.toLowerCase() === 'tags' ? `#${searchValue}` : searchValue,
                    focus: true,
                  },
                }));
              }, tagSuggestions, tagSuggestionStatus)}
            </dd>
          </div>
        ))}
        </div>
        {children ? (
          <div className="space-y-6 pt-7">
            {children}
          </div>
        ) : null}
      </dl>
    </section>
  );
}
