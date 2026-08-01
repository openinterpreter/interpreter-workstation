/**
 * ToolCard - Unified tool server card
 *
 * Layout:
 * ┌────────────────────────────────────────────┐
 * │  [Icon]  Title  [Status]          [Toggle] │
 * │  Description or "X tools"                  │
 * │  [Cancel] [Delete]          (special only) │
 * └────────────────────────────────────────────┘
 *
 * Card is clickable in edit mode for navigation to detail view.
 * Action row only appears for special states (pending, disabled, MCP delete).
 */

import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import {
  Globe,
  Wrench,
  Server,
  Loader2,
  X,
  Plus,
  BadgeCheck,
} from 'lucide-react';
import {
  WhatsAppIcon,
  TelegramIcon,
  NylasIcon,
  PdfIcon,
  WordIcon,
  ExcelIcon,
  SlidesIcon,
  ConverterIcon,
} from '../icons/BrandIcons';
import type { ToolServer } from '../../api';
import type { McpStoreEntry } from './mcpStoreData';
import {
  isToolServerAuthRequired,
  isToolServerDisplayConnected,
} from '../../../shared/toolServerAvailability';

export type ToolCardMode = 'edit' | 'toggle';

export interface ToolCardProps {
  tool?: ToolServer;
  storeEntry?: McpStoreEntry;
  faviconUrl?: string;
  mode: ToolCardMode;
  isAdding?: boolean;
  isAuthPending?: boolean;
  enabled?: boolean;
  globallyDisabled?: boolean;
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
  onGlobalToggle?: (enabled: boolean) => void;
  onNavigateToGlobalTools?: () => void;
  onDelete?: () => void;
  onCancel?: () => void;
  onAdd?: () => void;
  onCompleteAuth?: () => void;
  className?: string;
}

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'builtin-google': Globe,
  'builtin-nylas': NylasIcon,
  'builtin-whatsapp': WhatsAppIcon,
  'builtin-telegram': TelegramIcon,
  'builtin-browser': Globe,
  'builtin-pdf': PdfIcon,
  'builtin-docx': WordIcon,
  'builtin-cells': ExcelIcon,
  'builtin-slides': SlidesIcon,
  'builtin-converter': ConverterIcon,
  'builtin-interpreter': Wrench,
  'builtin-mcp-management': Server,
  'builtin-utility': Wrench,
};

function getToolIcon(toolId: string) {
  return TOOL_ICONS[toolId] || Server;
}

export function ToolCard({
  tool,
  storeEntry,
  faviconUrl,
  mode,
  isAdding = false,
  isAuthPending = false,
  enabled = true,
  globallyDisabled = false,
  onClick,
  onToggle,
  onGlobalToggle,
  onNavigateToGlobalTools,
  onDelete,
  onCancel,
  onAdd,
  onCompleteAuth,
  className,
}: ToolCardProps) {
  const isSettingsMode = mode === 'edit';
  const isInstalled = !!tool;
  const isBuiltin = tool?.id.startsWith('builtin-') ?? false;
  const toolCount = tool?.state.tools?.length || 0;
  const isFailed = tool?.state.status === 'failed';
  const needsAuth = tool ? isToolServerAuthRequired(tool.state) : false;
  const isConnecting = tool?.state.status === 'connecting';
  const isConnected = tool
    ? isToolServerDisplayConnected({ state: tool.state, isBuiltin })
    : false;
  const isPending = needsAuth || isConnecting;

  const name = tool?.name || storeEntry?.name || 'Unknown';
  const description = storeEntry?.description || (isInstalled ? `${toolCount} tool${toolCount !== 1 ? 's' : ''}` : '');
  const isClickable = mode === 'edit' && onClick && !isPending && !globallyDisabled;

  const hasVisibleActions =
    (globallyDisabled && onNavigateToGlobalTools) ||
    (isPending && onCancel) ||
    (!isBuiltin && onDelete && !isPending && !globallyDisabled);

  const handleToggle = (checked: boolean) => {
    if (onToggle && !globallyDisabled) {
      onToggle(checked);
    }
  };

  const handleGlobalToggle = (checked: boolean) => {
    if (onGlobalToggle) {
      onGlobalToggle(checked);
    }
  };

  const renderIcon = () => {
    const iconWrapperStyle = {
      background: isBuiltin
        ? 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 58%, transparent)'
        : 'color-mix(in srgb, var(--oa-primary, var(--foreground)) 7%, var(--oa-bg-subtle, var(--muted)) 93%)',
      border: isSettingsMode
        ? 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)'
        : undefined,
    } as const;

    if (faviconUrl) {
      return (
        <div
          className="flex size-[30px] shrink-0 items-center justify-center overflow-hidden rounded-[9px]"
          style={{
            background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 58%, transparent)',
            border: isSettingsMode
              ? 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)'
              : undefined,
          }}
        >
          <img src={faviconUrl} alt="" className="size-4" loading="lazy" />
        </div>
      );
    }

    if (tool) {
      const Icon = getToolIcon(tool.id);
      return (
        <div
          className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px]"
          style={iconWrapperStyle}
        >
          <Icon className="size-4 text-muted-foreground" />
        </div>
      );
    }

    return (
      <div
        className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px]"
        style={{
          background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 58%, transparent)',
          border: isSettingsMode
            ? 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)'
            : undefined,
        }}
      >
        <Server className="size-4 text-muted-foreground" />
      </div>
    );
  };

  const renderStatus = () => {
    if (!isInstalled || isBuiltin) return null;

    if (needsAuth) {
      return (
        <span className="flex items-center gap-1 text-ui-xs text-primary shrink-0">
          <Loader2 className="size-3 animate-spin" />
          Complete in browser
        </span>
      );
    }

    if (isConnecting) {
      return (
        <span className="flex items-center gap-1 text-ui-xs text-muted-foreground shrink-0">
          <Loader2 className="size-3 animate-spin" />
        </span>
      );
    }

    if (isFailed) {
      if (isSettingsMode) {
        return <span className="shrink-0 text-[11px] font-medium text-destructive">Failed</span>;
      }

      return <span className="shrink-0 text-ui-xs font-medium text-destructive">Failed</span>;
    }

    if (isConnected) {
      return (
        <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" role="status" aria-label="Connected" />
      );
    }

    return null;
  };

  const renderPrimaryControl = () => {
    if (!isInstalled && onAdd) {
      return (
        <Button
          variant={isSettingsMode ? 'ghost' : 'outline'}
          size={isSettingsMode ? 'xs' : 'sm'}
          className={isSettingsMode ? 'text-muted-foreground hover:text-foreground' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (isAdding) return;
            onAdd();
          }}
          aria-label={isAdding ? `Loading ${name}` : `Add ${name}`}
          disabled={isAdding}
          aria-busy={isAdding}
        >
          {isAdding ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          {isAdding ? 'Loading...' : 'Add'}
        </Button>
      );
    }

    if (mode === 'edit' && isInstalled && needsAuth && onCompleteAuth) {
      return (
        <Button
          variant="ghost"
          size="xs"
          className="text-primary hover:text-primary"
          onClick={(e) => {
            e.stopPropagation();
            if (isAuthPending) return;
            onCompleteAuth();
          }}
          aria-label={isAuthPending ? `Waiting for sign-in for ${name}` : `Complete auth for ${name}`}
          disabled={isAuthPending}
          aria-busy={isAuthPending}
        >
          {isAuthPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Globe className="size-3.5" />
          )}
          {isAuthPending ? 'Waiting for sign-in' : 'Complete auth'}
        </Button>
      );
    }

    if (mode === 'edit' && isInstalled && onGlobalToggle) {
      return (
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={!globallyDisabled}
            onCheckedChange={handleGlobalToggle}
            aria-label={`${globallyDisabled ? 'Enable' : 'Disable'} ${name} globally`}
          />
        </div>
      );
    }

    if (mode === 'toggle' && isInstalled) {
      return (
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={enabled && !globallyDisabled}
            onCheckedChange={handleToggle}
            disabled={globallyDisabled}
            aria-label={`${enabled ? 'Disable' : 'Enable'} ${name}`}
          />
        </div>
      );
    }

    return null;
  };

  const hasPrimaryControl = (!isInstalled && onAdd) ||
    (mode === 'edit' && isInstalled && needsAuth && onCompleteAuth) ||
    (mode === 'edit' && isInstalled && onGlobalToggle) ||
    (mode === 'toggle' && isInstalled);

  return (
    <div
      className={cn(
        'group/card',
        isSettingsMode && 'flex flex-col gap-1.5 px-3.5 py-3',
        !isSettingsMode && 'flex h-full flex-col gap-2 rounded-control border p-4',
        isSettingsMode && isClickable && 'hover:bg-[color-mix(in_srgb,var(--oa-bg-subtle,var(--muted))_54%,transparent)]',
        mode === 'toggle' && !enabled && !globallyDisabled && 'opacity-50',
        className
      )}
      style={
        isSettingsMode
          ? undefined
          : { borderWidth: 'var(--border-width)' }
      }
    >
      {/* Header row: Icon + Title + Status + Control */}
      <div className={cn('flex min-w-0 flex-1 items-start gap-3', !isSettingsMode && 'items-center gap-2.5')}>
        {renderIcon()}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'min-w-0 truncate text-foreground',
                isSettingsMode ? 'text-ui-sm font-medium' : 'text-ui-base font-medium',
              )}
            >
              {name}
            </span>
            {storeEntry && (
              <BadgeCheck className="size-3 shrink-0 text-muted-foreground/70" aria-label="Verified" />
            )}
            {renderStatus()}
          </div>
          {description && (
            <p
              className={cn(
                isSettingsMode
                  ? 'mt-0.5 line-clamp-2 text-ui-xs text-muted-foreground'
                  : 'mt-1 line-clamp-2 text-ui-sm text-muted-foreground',
                isClickable && 'cursor-pointer decoration-dotted underline-offset-2 group-hover/card:underline'
              )}
              onClick={isClickable ? onClick : undefined}
            >
              {description}
            </p>
          )}
        </div>
        {hasPrimaryControl && (
          <div className="shrink-0 pt-0.5">
            {renderPrimaryControl()}
          </div>
        )}
      </div>

      {/* Action row - special states and MCP delete only */}
      {mode === 'edit' && isInstalled && hasVisibleActions && (
        <div className={cn('mt-auto flex items-center gap-3', isSettingsMode && 'pl-10')}>
          {globallyDisabled && onNavigateToGlobalTools && (
            <>
              <span className="text-ui-xs text-muted-foreground">Disabled globally</span>
              <button
                type="button"
                className="text-ui-xs text-primary hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigateToGlobalTools();
                }}
              >
                Enable
              </button>
            </>
          )}

          {isPending && onCancel && (
            <button
              type="button"
              className="flex items-center gap-1 text-ui-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              <X className="size-3" />
              Cancel
            </button>
          )}

          {!isBuiltin && onDelete && !isPending && !globallyDisabled && (
            <button
              type="button"
              className="text-ui-xs text-muted-foreground hover:text-destructive transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
