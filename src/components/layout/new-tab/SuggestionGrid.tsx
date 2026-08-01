/**
 * SuggestionGrid
 *
 * Content-rich dashboard that replaces the pill row on the new tab. Each
 * cell is a CardSpec (see `suggestionCards.ts`) — a deterministic
 * combination of workspace contents, behavioral history, and clock signals.
 *
 * Collapsible: the user can hide the grid entirely. Preference is persisted
 * in localStorage. All data is local/offline/private.
 */

import { useCallback, useMemo, useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getIcon } from '../../../utils/iconMap';
import { recordCardClickActivity } from '../../../api';
import type { CardSpec } from './suggestionCards';
import type { LocaleKey } from '../../../i18n';

const COLLAPSE_STORAGE_KEY = 'interpreter.newtab.suggestions.collapsed';
const VISIBLE_CARDS_DEFAULT = 8;

export interface SuggestionGridProps {
  cards: CardSpec[];
  onInvokeCard: (card: CardSpec) => void;
}

function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  });

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
    } catch { /* best-effort */ }
  }, []);

  return [collapsed, setCollapsed];
}

function SuggestionCard({ card, onClick }: { card: CardSpec; onClick: () => void }) {
  const Icon = getIcon(card.icon);
  const isResume = card.kind === 'resume';
  return (
    <button
      type="button"
      data-testid={`suggestion-${card.id}`}
      onClick={onClick}
      className={`group flex w-full items-start gap-3 rounded-[14px] px-4 py-3 text-left transition-colors active:scale-[0.995] hover:bg-[var(--oa-button-hover-bg)] ${isResume ? 'sm:col-span-2' : ''}`}
      style={{
        border: '1px solid var(--oa-border, var(--border))',
        backgroundColor: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 92%, transparent)',
      }}
    >
      {Icon && (
        <span
          className="mt-0.5 flex size-8 flex-shrink-0 items-center justify-center rounded-[10px]"
          style={{
            background: isResume
              ? 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 60%, transparent)'
              : 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 40%, transparent)',
          }}
        >
          <Icon className="size-4 text-[var(--oa-text-muted)] group-hover:text-[var(--oa-text-strong)]" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-[var(--oa-text)]">
          {card.title}
        </div>
        {card.subtitle && (
          <div className="mt-0.5 truncate text-[11.5px] text-[var(--oa-text-muted)]">
            {card.subtitle}
          </div>
        )}
      </div>
    </button>
  );
}

export function SuggestionGrid({ cards, onInvokeCard }: SuggestionGridProps) {
  const { t } = useTranslation();
  const translate = useCallback((key: LocaleKey, options?: Record<string, unknown>) => t(key, options), [t]);
  const [collapsed, setCollapsed] = useCollapsed();
  const [showAll, setShowAll] = useState(false);

  const visibleCards = useMemo(() => {
    if (showAll) return cards;
    return cards.slice(0, VISIBLE_CARDS_DEFAULT);
  }, [cards, showAll]);

  const hasMore = cards.length > VISIBLE_CARDS_DEFAULT;

  // Reset "Show all" when the card list identity changes.
  useEffect(() => { setShowAll(false); }, [cards]);

  const handleCardClick = useCallback((card: CardSpec) => {
    void recordCardClickActivity(card.id);
    onInvokeCard(card);
  }, [onInvokeCard]);

  if (cards.length === 0) return null;

  return (
    <div className="mb-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 text-ui-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <span>{translate('newTab.suggestions')}</span>
        </button>
        {!collapsed && hasMore && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="text-ui-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAll ? translate('newTab.showLess') : translate('newTab.showAll', { count: cards.length })}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {visibleCards.map((card) => (
            <SuggestionCard key={card.id} card={card} onClick={() => handleCardClick(card)} />
          ))}
        </div>
      )}
    </div>
  );
}
