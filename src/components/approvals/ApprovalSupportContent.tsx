import { type DragEvent, type ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { browserControl } from '@/ipc';
import type { QuestionOption, QuestionRequest } from '../../../shared/types/approval';
import { createFileDragData } from '../../../shared/types/drag';
import { Button } from '../ui/button';

const HIDDEN_CONTEXT_KEYS = {
  warning: true,
  message: true,
  description: true,
  reason: true,
  files: true,
  paths: true,
  command: true,
  threadId: true,
  sessionAware: true,
  turnId: true,
  itemId: true,
  approvalId: true,
  cwd: true,
  commandActions: true,
  availableDecisions: true,
  proposedExecpolicyAmendment: true,
  proposedNetworkPolicyAmendments: true,
  additionalPermissions: true,
  networkApprovalContext: true,
  grantRoot: true,
  fileChanges: true,
  path: true,
  runtimeRestart: true,
  runtimeRestartNotice: true,
  toolName: true,
  target: true,
  app: true,
  appIconDataUrl: true,
  appIconLabel: true,
  permissionCard: true,
  window_id: true,
  full_screen: true,
  recommendation: true,
} as const satisfies Record<string, true>;

type HiddenContextKey = keyof typeof HIDDEN_CONTEXT_KEYS;
type ContextLabel = 'Server' | 'Tool Args';

const CONTEXT_LABEL_BY_KEY = {
  serverId: 'Server',
  serverName: 'Server',
  args: 'Tool Args',
  toolParams: 'Tool Args',
} as const satisfies Record<string, ContextLabel>;

type LabeledContextKey = keyof typeof CONTEXT_LABEL_BY_KEY;

function hasOwnKey<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isHiddenContextKey(key: string): key is HiddenContextKey {
  return hasOwnKey(HIDDEN_CONTEXT_KEYS, key);
}

function isLabeledContextKey(key: string): key is LabeledContextKey {
  return hasOwnKey(CONTEXT_LABEL_BY_KEY, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatContextKey(key: string): string {
  if (isLabeledContextKey(key)) {
    return CONTEXT_LABEL_BY_KEY[key];
  }

  return key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (value) => value.toUpperCase());
}

function formatContextValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .filter((item) => item != null)
      .map((item) => formatContextValue(item))
      .join(', ');
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([entryKey, entryValue]) => `${formatContextKey(entryKey)}: ${formatContextValue(entryValue)}`)
      .join(' • ');
  }
  return '';
}

export function normalizeApprovalCopy(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  switch (trimmed) {
    case 'Interpreter wants to edit files with apply_patch.':
      return 'Interpreter wants to make changes to files.';
    case 'Interpreter apply_patch requested approval.':
      return 'Review the proposed changes before continuing.';
    case 'Agent wants to run a shell command.':
    case 'Run this command?':
    case 'Interpreter wants to run this command.':
      return 'Interpreter wants to run a command.';
    case 'Delete file requires approval':
      return 'Let Interpreter delete this file?';
    case 'Codex shell execution requested approval.':
    case 'Interpreter shell execution requested approval.':
      return 'Review this command before continuing.';
    default:
      return trimmed;
  }
}

function parseDecisionIndex(value: string | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^decision:(\d+)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

function quoteCommandSegment(segment: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(segment)
    ? segment
    : `'${segment.replace(/'/g, `'\\''`)}'`;
}

function renderCommandPattern(command: string[]): string {
  if (command.length >= 3) {
    const executable = (command[0] ?? '').split('/').pop()?.toLowerCase();
    const flag = command[1];
    if ((executable === 'bash' || executable === 'zsh' || executable === 'sh') && (flag === '-lc' || flag === '-c')) {
      return command.slice(2).join(' ').trim();
    }
  }

  return command.map(quoteCommandSegment).join(' ').trim();
}

function commandPatternForOption(approval: QuestionRequest, option: QuestionOption): string {
  const decisionIndex = parseDecisionIndex(option.value);
  const decisions = Array.isArray(approval.context?.availableDecisions)
    ? approval.context.availableDecisions
    : [];

  const decision = decisionIndex !== null ? decisions[decisionIndex] : null;
  if (
    decision
    && typeof decision === 'object'
    && decision !== null
    && 'acceptWithExecpolicyAmendment' in decision
  ) {
    const amendment = (decision as {
      acceptWithExecpolicyAmendment?: { execpolicy_amendment?: unknown };
    }).acceptWithExecpolicyAmendment?.execpolicy_amendment;
    if (Array.isArray(amendment) && amendment.every((entry) => typeof entry === 'string')) {
      return renderCommandPattern(amendment);
    }
  }

  const fallback = approval.context?.proposedExecpolicyAmendment;
  if (Array.isArray(fallback) && fallback.every((entry) => typeof entry === 'string')) {
    return renderCommandPattern(fallback);
  }

  return '';
}

export function normalizeApprovalOptionCopy(
  approval: QuestionRequest,
  option: QuestionOption,
): QuestionOption {
  const rawLabel = option.label?.trim() ?? '';
  const rawDescription = option.description?.trim() ?? '';
  const lowerLabel = rawLabel.toLowerCase();
  const lowerDescription = rawDescription.toLowerCase();
  const hasSimilarCommandsCopy = lowerLabel.includes('similar commands') || lowerDescription.includes('similar commands');

  if (!hasSimilarCommandsCopy) {
    return option;
  }

  const pattern = commandPatternForOption(approval, option);
  if (!pattern) {
    return {
      ...option,
      label: lowerLabel.includes('always allow') ? 'Always allow this command pattern' : option.label,
      description: lowerDescription.includes('similar commands')
        ? 'Run it now and stop asking about this command pattern.'
        : option.description,
    };
  }

  return {
    ...option,
    label: `Always allow: ${pattern}`,
    description: `Run it now and stop asking about commands that start with: ${pattern}`,
  };
}

function isGenericCommandApprovalCopy(value: string): boolean {
  const normalized = normalizeApprovalCopy(value);
  return normalized === 'Interpreter wants to run a command.'
    || normalized === 'Review this command before continuing.';
}

function sameApprovalCopy(a: string, b: string): boolean {
  return normalizeApprovalCopy(a).trim() === normalizeApprovalCopy(b).trim();
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function safeImageSrc(value: unknown): string | null {
  const src = nonEmptyString(value);
  if (!src) return null;
  if (/^https:\/\/[^\s]+$/i.test(src)) return src;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(src)) return src;
  return null;
}

function safeResultUrl(value: unknown): string {
  const url = nonEmptyString(value);
  return /^https:\/\/[^\s]+$/i.test(url) ? url : '';
}

function generatedAssetDragData(localPathValue: unknown, fileNameValue: unknown) {
  const localPath = nonEmptyString(localPathValue);
  const fileName = nonEmptyString(fileNameValue);
  if (!localPath || !fileName) {
    return null;
  }

  return createFileDragData(localPath, fileName, false, 'unknown');
}

function setGeneratedAssetDragData(
  event: DragEvent<HTMLElement>,
  localPathValue: unknown,
  fileNameValue: unknown,
) {
  const dragData = generatedAssetDragData(localPathValue, fileNameValue);
  if (!dragData) {
    return;
  }

  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/json', JSON.stringify(dragData));
  event.dataTransfer.setData('text/plain', dragData.filePath);
}

function permissionCardBlocks(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.blocks)) {
    return [];
  }

  return value.blocks.filter(isRecord);
}

function permissionCardPreviewBlocks(value: unknown): Record<string, unknown>[] {
  return permissionCardBlocks(value).filter((block) => nonEmptyString(block.type) !== 'form');
}

export type PermissionCardDraftValue = string | boolean;
export type PermissionCardDraftValues = Record<string, PermissionCardDraftValue>;

type PermissionCardDraftField = {
  id: string;
  type: 'text' | 'checkbox';
  label: string;
  description: string;
  value: PermissionCardDraftValue;
};

function permissionCardDraftFields(card: unknown): PermissionCardDraftField[] {
  const fields: PermissionCardDraftField[] = [];
  for (const block of permissionCardBlocks(card)) {
    if (nonEmptyString(block.type) !== 'form') {
      continue;
    }
    const blockFields = Array.isArray(block.fields) ? block.fields.filter(isRecord) : [];
    for (const field of blockFields) {
      const id = nonEmptyString(field.id);
      const type = nonEmptyString(field.type);
      const label = nonEmptyString(field.label);
      if (!id || !label || (type !== 'text' && type !== 'checkbox')) {
        continue;
      }
      fields.push({
        id,
        type,
        label,
        description: nonEmptyString(field.description),
        value: type === 'checkbox'
          ? field.checked === true || field.value === true
          : nonEmptyString(field.value ?? field.defaultValue),
      });
    }
  }
  return fields;
}

export function initialPermissionCardDraftValues(card: unknown): PermissionCardDraftValues {
  const values: PermissionCardDraftValues = {};
  for (const field of permissionCardDraftFields(card)) {
    values[field.id] = field.value;
  }
  return values;
}

export function permissionCardDraftAnswers(values: PermissionCardDraftValues): Record<string, string> {
  return Object.keys(values).length > 0
    ? { permission_card_draft_json: JSON.stringify(values) }
    : {};
}

export function PermissionCardDraftFields({
  card,
  values,
  onChange,
  disabled = false,
}: {
  card: unknown;
  values: PermissionCardDraftValues;
  onChange: (values: PermissionCardDraftValues) => void;
  disabled?: boolean;
}) {
  const fields = permissionCardDraftFields(card);
  if (fields.length === 0) {
    return null;
  }

  return (
    <div
      className="space-y-3 rounded-[14px] px-3 py-3"
      style={{
        background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 62%, transparent)',
        border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)',
      }}
    >
      {fields.map((field) => {
        const value = values[field.id] ?? field.value;
        if (field.type === 'checkbox') {
          return (
            <label key={field.id} className="flex items-start gap-2 text-ui-sm leading-5 text-[var(--oa-text)]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={value === true}
                disabled={disabled}
                onChange={(event) => onChange({ ...values, [field.id]: event.target.checked })}
              />
              <span className="min-w-0">
                <span className="block break-words">{field.label}</span>
                {field.description ? (
                  <span className="mt-1 block break-words text-ui-xs text-[var(--oa-text-muted)]">
                    {field.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        }

        return (
          <label key={field.id} className="block space-y-1.5 text-ui-sm text-[var(--oa-text)]">
            <span className="block break-words">{field.label}</span>
            <input
              type="text"
              value={typeof value === 'string' ? value : ''}
              disabled={disabled}
              onChange={(event) => onChange({ ...values, [field.id]: event.target.value })}
              className="h-9 w-full rounded-[10px] px-3 text-ui-sm text-[var(--oa-text)] outline-none"
              style={{
                background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 78%, transparent)',
                border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 28%, transparent)',
              }}
            />
            {field.description ? (
              <span className="block break-words text-ui-xs text-[var(--oa-text-muted)]">{field.description}</span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

function PermissionCardPreview({
  card,
}: {
  card: unknown;
}) {
  const blocks = permissionCardPreviewBlocks(card);
  if (blocks.length === 0) {
    return null;
  }

  return (
    <div
      className="space-y-3 rounded-[14px] px-3 py-3"
      style={{
        background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 62%, transparent)',
        border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)',
      }}
    >
      {blocks.map((block, index) => {
        const type = nonEmptyString(block.type);
        if (type === 'form') {
          return null;
        }
        if (type === 'text') {
          const text = nonEmptyString(block.text);
          if (!text) return null;
          return (
            <div key={index} className="whitespace-pre-line text-ui-sm leading-6 text-[var(--oa-text)]">
              {text}
            </div>
          );
        }

        if (type === 'list') {
          const items = Array.isArray(block.items) ? block.items.filter(isRecord) : [];
          if (items.length === 0) return null;
          return (
            <div key={index} className="space-y-2">
              {items.map((item, itemIndex) => {
                const label = nonEmptyString(item.label);
                const description = nonEmptyString(item.description);
                const icon = nonEmptyString(item.icon);
                if (!label && !description) return null;
                return (
                  <div key={itemIndex} className="flex gap-2 text-ui-sm leading-5">
                    {icon ? (
                      <span className="shrink-0 text-[var(--oa-text-muted)]" aria-hidden="true">{icon.slice(0, 4)}</span>
                    ) : null}
                    <div className="min-w-0">
                      {label ? <div className="break-words text-[var(--oa-text)]">{label}</div> : null}
                      {description ? <div className="break-words text-[var(--oa-text-muted)]">{description}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }

        if (type === 'image') {
          const src = safeImageSrc(block.src);
          const localPath = nonEmptyString(block.localPath);
          const dragData = generatedAssetDragData(block.localPath, block.fileName);
          const alt = nonEmptyString(block.alt) || nonEmptyString(block.description) || 'Generated preview';
          const description = nonEmptyString(block.description);
          if (!src && !localPath) return null;
          return (
            <figure
              key={index}
              className="space-y-2"
              draggable={Boolean(dragData)}
              data-generated-asset={dragData ? 'true' : undefined}
              onDragStart={dragData
                ? (event) => setGeneratedAssetDragData(event, block.localPath, block.fileName)
                : undefined}
            >
              {src ? (
                <img
                  src={src}
                  alt={alt}
                  className="max-h-64 w-full rounded-[12px] object-cover"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div
                  className="rounded-[12px] px-3 py-2.5 font-mono text-[11px] leading-5 text-[var(--oa-text-muted)]"
                  style={{
                    background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 74%, transparent)',
                    border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 20%, transparent)',
                  }}
                >
                  {localPath}
                </div>
              )}
              {description ? (
                <figcaption className="text-ui-xs leading-5 text-[var(--oa-text-muted)]">
                  {description}
                </figcaption>
              ) : null}
            </figure>
          );
        }

        if (type === 'browser-tab') {
          const tabRef = nonEmptyString(block.tabRef);
          if (!tabRef) return null;
          const title = nonEmptyString(block.title) || 'Browser tab';
          const url = nonEmptyString(block.url);
          const description = nonEmptyString(block.description);
          return (
            <div
              key={index}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] px-3 py-2"
              style={{
                border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 22%, transparent)',
              }}
            >
              <div className="min-w-0">
                <div className="break-words text-ui-sm text-[var(--oa-text)]">{title}</div>
                {url ? <div className="break-words text-ui-xs text-[var(--oa-text-muted)]">{url}</div> : null}
                {description ? (
                  <div className="mt-1 break-words text-ui-xs text-[var(--oa-text-muted)]">{description}</div>
                ) : null}
              </div>
              <Button
                type="button"
                variant="utility"
                size="xs"
                className="gap-1"
                onClick={() => {
                  void browserControl.activateTab({ tabRef });
                }}
              >
                <Eye className="size-3" />
                <span>Show tab</span>
              </Button>
            </div>
          );
        }

        if (type === 'image-grid') {
          const images = Array.isArray(block.images) ? block.images.filter(isRecord) : [];
          if (images.length === 0) return null;
          return (
            <div key={index} className="grid grid-cols-2 gap-2">
              {images.map((image, imageIndex) => {
                const src = safeImageSrc(image.src);
                const localPath = nonEmptyString(image.localPath);
                const dragData = generatedAssetDragData(image.localPath, image.fileName);
                const alt = nonEmptyString(image.alt) || nonEmptyString(image.description) || 'Generated preview';
                const description = nonEmptyString(image.description);
                if (!src && !localPath) return null;
                return (
                  <figure
                    key={imageIndex}
                    className="min-w-0 space-y-1.5"
                    draggable={Boolean(dragData)}
                    data-generated-asset={dragData ? 'true' : undefined}
                    onDragStart={dragData
                      ? (event) => setGeneratedAssetDragData(event, image.localPath, image.fileName)
                      : undefined}
                  >
                    {src ? (
                      <img
                        src={src}
                        alt={alt}
                        className="aspect-square w-full rounded-[12px] object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div
                        className="min-h-20 rounded-[12px] px-2.5 py-2 font-mono text-[10px] leading-4 text-[var(--oa-text-muted)]"
                        style={{
                          background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 74%, transparent)',
                          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 20%, transparent)',
                        }}
                      >
                        {localPath}
                      </div>
                    )}
                    {description ? (
                      <figcaption className="break-words text-ui-xs leading-5 text-[var(--oa-text-muted)]">
                        {description}
                      </figcaption>
                    ) : null}
                  </figure>
                );
              })}
            </div>
          );
        }

        if (type === 'search-results') {
          const title = nonEmptyString(block.title);
          const searches = Array.isArray(block.searches) ? block.searches.filter(isRecord) : [];
          if (searches.length === 0) return null;
          return (
            <div key={index} className="space-y-3">
              {title ? (
                <div className="text-ui-sm font-medium text-[var(--oa-text)]">{title}</div>
              ) : null}
              {searches.map((search, searchIndex) => {
                const query = nonEmptyString(search.query);
                const results = Array.isArray(search.results) ? search.results.filter(isRecord) : [];
                if (!query && results.length === 0) return null;
                return (
                  <div
                    key={searchIndex}
                    className="rounded-[12px] px-3 py-2.5"
                    style={{
                      background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 70%, transparent)',
                      border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 18%, transparent)',
                    }}
                  >
                    {query ? (
                      <div className="mb-2 text-ui-xs text-[var(--oa-text-faint)]">{query}</div>
                    ) : null}
                    <div className="space-y-2">
                      {results.map((result, resultIndex) => {
                        const resultTitle = nonEmptyString(result.title);
                        const url = safeResultUrl(result.url);
                        const imageSrc = safeImageSrc(result.imageSrc);
                        if (!resultTitle && !url && !imageSrc) return null;
                        return (
                          <div key={resultIndex} className="flex min-w-0 gap-2">
                            {imageSrc ? (
                              <img
                                src={imageSrc}
                                alt=""
                                className="size-10 shrink-0 rounded-[8px] object-cover"
                                loading="lazy"
                                decoding="async"
                                aria-hidden="true"
                              />
                            ) : null}
                            <div className="min-w-0 text-ui-sm leading-5">
                              {resultTitle ? (
                                <div className="break-words text-[var(--oa-text)]">{resultTitle}</div>
                              ) : null}
                              {url ? (
                                <div className="break-all text-ui-xs text-[var(--oa-text-muted)]">{url}</div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

function HighlightedCommand({
  command,
}: {
  command: string;
}) {
  return (
    <pre className="oa-command-transcript-code">
      <code>{command}</code>
    </pre>
  );
}

function getExtraContextEntries(context: unknown): Array<[string, string]> {
  if (!isRecord(context)) return [];
  const hideSessionScopedMcpPlumbing = context.sessionAware === true;

  return Object.entries(context)
    .filter(([key, value]) => {
      if (isHiddenContextKey(key) || value == null) {
        return false;
      }
      return !(hideSessionScopedMcpPlumbing && (key === 'serverId' || key === 'serverName'));
    })
    .map(([key, value]) => [
      hideSessionScopedMcpPlumbing && (key === 'args' || key === 'toolParams')
        ? 'Details'
        : formatContextKey(key),
      formatContextValue(value),
    ] as [string, string])
    .filter(([, value]) => value.length > 0);
}

function ApprovalDetailField({
  label,
  children,
  inset = false,
}: {
  label: string;
  children: ReactNode;
  inset?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-ui-xs text-[var(--oa-text-faint)]">{label}</div>
      <div
        className={inset ? 'rounded-[12px] px-3 py-2.5' : undefined}
        style={inset
          ? {
              background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 56%, transparent)',
              border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 22%, transparent)',
            }
          : undefined}
      >
        {children}
      </div>
    </div>
  );
}

export function ApprovalSupportContent({
  approval,
}: {
  approval: QuestionRequest;
}) {
  const files = toStringList(approval.context?.files);
  const paths = toStringList(approval.context?.paths);
  const permissionCardBlocksCount = permissionCardPreviewBlocks(approval.context?.permissionCard).length;
  const extraContextEntries = getExtraContextEntries(approval.context);

  const rawMessage = typeof approval.context?.message === 'string' && approval.context.message.trim().length > 0
    ? String(approval.context.message)
    : '';
  const rawDescription = typeof approval.context?.description === 'string' && approval.context.description.trim().length > 0
    ? String(approval.context.description)
    : '';
  const rawWarning = typeof approval.context?.warning === 'string' && approval.context.warning.trim().length > 0
    ? String(approval.context.warning)
    : '';
  const isSessionAwareMcpApproval = approval.context?.sessionAware === true;
  const hasWarningMessage = rawWarning.length > 0
    && !(isSessionAwareMcpApproval && rawWarning.includes('__'))
    && !(rawMessage.length > 0 && sameApprovalCopy(rawWarning, rawMessage))
    && !(rawDescription.length > 0 && sameApprovalCopy(rawWarning, rawDescription));
  const hasDescription = typeof approval.context?.description === 'string'
    && approval.context.description.trim().length > 0
    && !(isSessionAwareMcpApproval && approval.context.description.trim() === 'Review this MCP tool call before continuing.');
  const hasReason = !hasDescription
    && typeof approval.context?.reason === 'string'
    && approval.context.reason.trim().length > 0;
  const hasCommand = typeof approval.context?.command === 'string' && approval.context.command.trim().length > 0;

  const hasContent = hasWarningMessage
    || hasDescription
    || hasReason
    || hasCommand
    || permissionCardBlocksCount > 0
    || files.length > 0
    || paths.length > 0
    || extraContextEntries.length > 0;

  if (!hasContent) return null;

  const descriptionText = hasDescription
    ? normalizeApprovalCopy(rawDescription)
    : '';
  const messageText = rawMessage.length > 0
    ? normalizeApprovalCopy(rawMessage)
    : '';
  const reasonText = hasReason
    ? normalizeApprovalCopy(String(approval.context.reason))
    : '';
  const warningText = hasWarningMessage
    ? normalizeApprovalCopy(rawWarning)
    : '';

  return (
    <div className="space-y-3">
      {permissionCardBlocksCount > 0 ? (
        <PermissionCardPreview card={approval.context?.permissionCard} />
      ) : null}

      {hasWarningMessage && (
        <div
          className="pl-3"
          style={{
            borderLeft: '2px solid color-mix(in srgb, rgb(217 119 6) 48%, transparent)',
          }}
        >
          <div className="text-ui-xs text-[var(--oa-text-faint)]">Note</div>
          <div className="mt-1 whitespace-pre-line text-ui-sm leading-6 text-[var(--oa-text)]">
            {warningText}
          </div>
        </div>
      )}

      {hasDescription && descriptionText && !(
        descriptionText === messageText
        || (hasCommand && isGenericCommandApprovalCopy(descriptionText))
      ) ? (
        <div className="text-ui-sm leading-6 text-[var(--oa-text)]">
          {descriptionText}
        </div>
      ) : null}

      {hasReason && reasonText && reasonText !== descriptionText && !(
        hasCommand && isGenericCommandApprovalCopy(reasonText)
      ) && (
        <div className="text-ui-sm leading-6 text-[var(--oa-text-muted)]">
          {reasonText}
        </div>
      )}

      {files.length > 0 && (
        <ApprovalDetailField label="Files" inset>
          <div className="space-y-1 font-mono text-[11px] leading-5 text-[var(--oa-text-muted)]">
            {files.map((file, fileIndex) => (
              <div key={fileIndex} className="break-all">{file}</div>
            ))}
          </div>
        </ApprovalDetailField>
      )}

      {hasCommand && (
        <ApprovalDetailField label="Command" inset>
          <HighlightedCommand command={approval.context.command} />
        </ApprovalDetailField>
      )}

      {paths.length > 0 && files.length === 0 && (
        <ApprovalDetailField label="Paths" inset>
          <div className="space-y-1 font-mono text-[11px] leading-5 text-[var(--oa-text-muted)]">
            {paths.map((path, pathIndex) => (
              <div key={pathIndex} className="break-all">{path}</div>
            ))}
          </div>
        </ApprovalDetailField>
      )}

      {extraContextEntries.length > 0 && (
        <div className="space-y-3">
          {extraContextEntries.map(([label, value]) => (
            <ApprovalDetailField key={label} label={label}>
              <div className="break-words text-ui-sm leading-6 text-[var(--oa-text-muted)]">{value}</div>
            </ApprovalDetailField>
          ))}
        </div>
      )}
    </div>
  );
}
