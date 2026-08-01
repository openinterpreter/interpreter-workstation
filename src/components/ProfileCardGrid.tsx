/**
 * ProfileCardGrid - Shared component for displaying profiles as a card grid.
 * Used in onboarding surfaces and settings (ProfileManager).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Server, Terminal, Key, Plus, ChevronRight, Check, Trash2, WifiOff } from 'lucide-react';
import type { Profile, ProfileSetupStatus } from '../../shared/types/profile';
import { PROFILE_CARD_ID } from '../../shared/element-ids';
import { Badge } from './ui/badge';
import { OpenAIIcon } from './icons/BrandIcons';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Button } from './ui/button';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../utils/supabase/client';
import { useInterpreterTokenUsage } from '../hooks/useInterpreterTokenUsage';
import { ExpensiveModelBadge, UsageRemainingBadge } from './ModelSignalBadges';
import {
  LOW_USAGE_PERCENT_THRESHOLD,
  formatRemainingPercentLabel,
  isExpensiveModelId,
} from '../utils/modelCostSignals';
import { ACTIVE_APP_BRAND } from '@/branding';

interface ProfileCardGridProps {
  mode: 'onboarding' | 'settings';
  profiles: Profile[];
  statuses: Record<string, ProfileSetupStatus>;
  statusesLoading: boolean;
  onCardClick: (profile: Profile) => void;
  onAddCustom?: () => void;
  onOpenSettings?: () => void;
  /** Compact list layout for popovers/overlays */
  compact?: boolean;
  /** Currently active profile (highlighted in compact mode) */
  selectedProfileId?: string | null;
  /** Optional call-to-action label shown on compact rows */
  compactActionLabel?: string;
  /** Optional per-profile action label shown on compact rows */
  getCompactActionLabel?: (profile: Profile) => string | null;
  /** Optional footer action label for compact mode */
  compactFooterLabel?: string;
  /** Optional inline delete affordance for the full settings list */
  onDeleteProfile?: (profileId: string) => void;
  /** Profile currently awaiting delete confirmation */
  confirmingDeleteProfileId?: string | null;
}

const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  hosted: <ACTIVE_APP_BRAND.SymbolMark aria-hidden="true" className="size-5 text-muted-foreground" />,
  local: <Server className="size-5 text-muted-foreground" />,
  terminal: <Terminal className="size-5 text-muted-foreground" />,
  agent: <Terminal className="size-5 text-muted-foreground" />,
  api: <Key className="size-5 text-muted-foreground" />,
  'openai-oauth': <OpenAIIcon className="size-5 text-muted-foreground" />,
};

function getProviderIcon(provider: string, profileName?: string): React.ReactNode {
  if (profileName === 'Offline Model') {
    return <WifiOff className="size-5 text-muted-foreground" />;
  }
  return PROVIDER_ICONS[provider] || <Key className="size-5 text-muted-foreground" />;
}

function getSubtitle(profile: Profile, status: ProfileSetupStatus | undefined, t: (key: string, opts?: Record<string, string>) => string, options?: { compact?: boolean }): string {
  if (profile.name === 'Offline Model') {
    const normalizedBaseURL = (profile.baseURL || '').toLowerCase();
    const runtimeName = normalizedBaseURL.includes(':1234') || normalizedBaseURL.includes('lmstudio') ? t('settings.profiles.card.lmStudio') : t('settings.profiles.card.ollama');
    if (status?.ready) return t('settings.profiles.card.ollamaRunning', { runtime: runtimeName });
    return status?.detail || runtimeName;
  }
  if (options?.compact && profile.provider === 'terminal') return t('settings.profiles.card.startNewChat');
  if (status?.detail) return status.detail;
  if (profile.provider === 'hosted') return t('settings.profiles.card.interpreterManaged');
  if (profile.provider === 'local') {
    const normalizedBaseURL = (profile.baseURL || '').toLowerCase();
    return normalizedBaseURL.includes(':1234') || normalizedBaseURL.includes('lmstudio') ? t('settings.profiles.card.lmStudio') : t('settings.profiles.card.ollama');
  }
  if (profile.provider === 'terminal' || profile.provider === 'agent') return profile.modelId;
  if ((profile.provider as string) === 'openai-oauth') return t('settings.profiles.card.openaiAccount');
  if (profile.provider === 'api') return profile.modelId || t('settings.profiles.card.api');
  return profile.modelId;
}

function HostedPlanBadge({ isPro }: { isPro: boolean }) {
  const { t } = useTranslation();
  const label = isPro ? t('settings.profiles.card.planBadgePro') : t('settings.profiles.card.planBadgeFree');
  const tooltipText = isPro
    ? t('settings.profiles.card.planTooltipPro')
    : t('settings.profiles.card.planTooltipFree');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge
            variant="outline"
            className={`rounded-full px-2.5 py-0 text-[10px] leading-[18px] ${
              isPro
                ? 'border-foreground/30 bg-foreground/10 text-foreground'
                : 'border-muted-foreground/30 bg-muted/40 text-muted-foreground'
            }`}
          >
            {label}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

export function ProfileCardGrid({
  mode,
  profiles,
  statuses,
  statusesLoading: _statusesLoading,
  onCardClick,
  onAddCustom,
  onOpenSettings,
  compact = false,
  selectedProfileId,
  compactActionLabel,
  getCompactActionLabel,
  compactFooterLabel,
  onDeleteProfile,
  confirmingDeleteProfileId = null,
}: ProfileCardGridProps) {
  const { t } = useTranslation();
  const { user, isAuthenticated } = useAuth();
  const [isProPlan, setIsProPlan] = useState(false);
  const { percentRemaining } = useInterpreterTokenUsage();
  const lowUsagePercentLabel = percentRemaining !== null && percentRemaining < LOW_USAGE_PERCENT_THRESHOLD
    ? `${formatRemainingPercentLabel(percentRemaining)} left`
    : null;

  useEffect(() => {
    let cancelled = false;

    async function loadPlanStatus() {
      if (!isAuthenticated || !user?.id) {
        if (!cancelled) setIsProPlan(false);
        return;
      }

      const { data, error } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

      if (!cancelled) setIsProPlan(!error && !!data);
    }

    void loadPlanStatus();
    return () => { cancelled = true; };
  }, [isAuthenticated, user?.id]);

  // Show all profiles - no advanced-mode gating.
  const allProfiles = profiles;

  // In onboarding mode, split into ready/not-ready
  // Profiles in ALWAYS_SHOW_AS_CARD always appear in the main grid
  const readyProfiles = mode === 'onboarding'
    ? allProfiles.filter(p => {
        const s = statuses[p.id];
        return !s || s.ready; // Show if no status yet (loading) or ready
      })
    : allProfiles;

  const notReadyProfiles = mode === 'onboarding'
    ? allProfiles.filter(p => {
        const s = statuses[p.id];
        return s && !s.ready;
      })
    : [];

  const displayProfiles = readyProfiles;

  if (compact) {
    return (
      <div className="space-y-0.5 px-1">
        {displayProfiles.map(profile => {
          const status = statuses[profile.id];
          const isSelected = profile.id === selectedProfileId;
          const subtitle = getSubtitle(profile, status, t, { compact });
          const actionLabel = isSelected
            ? null
            : getCompactActionLabel?.(profile) ?? compactActionLabel ?? null;
          const showUsageBadge = isSelected && profile.provider === 'hosted' && !!lowUsagePercentLabel;
          const showExpensiveBadge = isExpensiveModelId(profile.modelId);

          return (
            <button
              type="button"
              key={profile.id}
              onClick={() => {
                if (isSelected) return;
                onCardClick(profile);
              }}
              data-testid={PROFILE_CARD_ID(profile.id)}
              className={`profile-compact-card group w-full flex items-center gap-3 rounded-[10px] px-2.5 py-2.5 text-left transition-[background-color,color,opacity,box-shadow] duration-150 ${
                isSelected
                  ? 'profile-compact-card-selected'
                  : 'hover:text-foreground'
              } ${mode === 'settings' && status && !status.ready ? 'opacity-60' : ''}`}
            >
              <div className={`profile-compact-card-icon flex size-8 shrink-0 items-center justify-center text-muted-foreground/90 ${
                isSelected
                  ? 'text-foreground'
                  : ''
              }`}>
                {getProviderIcon(profile.provider, profile.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`profile-compact-card-title flex items-center gap-2 truncate text-ui-sm leading-5 ${isSelected ? 'font-medium text-foreground' : 'font-normal text-foreground'}`}>
                  {showUsageBadge ? <UsageRemainingBadge label={lowUsagePercentLabel ?? ''} /> : null}
                  <span className="truncate">{profile.name}</span>
                  {showExpensiveBadge ? <ExpensiveModelBadge /> : null}
                  {profile.provider === 'hosted' ? <HostedPlanBadge isPro={isProPlan} /> : null}
                </div>
                <div className="profile-compact-card-subtitle mt-0.5 flex items-center gap-1.5 truncate text-ui-xs leading-4.5 text-muted-foreground">
                  {profile.name === 'Offline Model' && status?.ready && (
                    <span className="inline-block size-1.5 rounded-full bg-green-500 shrink-0" />
                  )}
                  <span className="truncate">{subtitle}</span>
                </div>
              </div>
              <div className="ml-3 flex shrink-0 items-center gap-2">
                {actionLabel ? (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground"
                    style={{
                      background:
                        'color-mix(in srgb, var(--oa-hover-bg, var(--oa-bg-input, var(--background))) 94%, transparent)',
                      boxShadow:
                        'inset 0 0 0 var(--border-width) color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)',
                    }}
                  >
                    {actionLabel}
                  </span>
                ) : null}
                {isSelected ? <Check className="size-4 text-foreground/90" /> : null}
              </div>
            </button>
          );
        })}
        {onOpenSettings && (
          <>
            <div
              className="my-2 h-px"
              style={{
                background:
                  'color-mix(in srgb, var(--oa-border, var(--border)) 56%, transparent)',
              }}
            />
            <button
              type="button"
              onClick={onOpenSettings}
              className="group flex w-full items-center justify-between gap-3 rounded-[8px] px-3 py-2.5 text-left text-[13px] leading-5 text-muted-foreground transition-[background-color,color] duration-150 hover:bg-black/[0.025] hover:text-foreground dark:hover:bg-white/[0.045]"
            >
              <span>{compactFooterLabel || t('settings.profiles.card.settings')}</span>
              <ChevronRight className="size-4 transition-transform duration-150 group-hover:translate-x-0.5" />
            </button>
          </>
        )}
      </div>
    );
  }

  if (mode === 'settings') {
    return (
      <div className="space-y-0">
        {displayProfiles.map(profile => {
          const status = statuses[profile.id];
          const showExpensiveBadge = isExpensiveModelId(profile.modelId);
          const canDelete = !profile.isBuiltin && !!onDeleteProfile;
          const isConfirmingDelete = confirmingDeleteProfileId === profile.id;

          return (
            <div
              key={profile.id}
              className={`group flex items-center gap-2 rounded-[10px] border-b px-2 py-2 transition-[background-color,color] duration-150 hover:bg-black/[0.025] dark:hover:bg-white/[0.035] ${
                status && !status.ready ? 'opacity-60' : ''
              }`}
              style={{ borderColor: 'color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)' }}
            >
              <button
                type="button"
                onClick={() => onCardClick(profile)}
                data-testid={PROFILE_CARD_ID(profile.id)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-[8px] px-0 py-1 text-left"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.025] text-muted-foreground dark:bg-white/[0.04]">
                  {getProviderIcon(profile.provider, profile.name)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-ui-sm font-medium text-foreground">
                      {profile.name}
                    </div>
                    {showExpensiveBadge ? <ExpensiveModelBadge /> : null}
                    {profile.provider === 'hosted' ? <HostedPlanBadge isPro={isProPlan} /> : null}
                    {profile.isExperimental && (
                      <Badge variant="outline" className="rounded-full px-1.5 py-0 text-ui-xs">
                        {t('settings.profiles.card.experimental')}
                      </Badge>
                    )}
                  </div>

                  <div className="mt-1 flex items-center gap-1.5 text-ui-xs text-muted-foreground">
                    {profile.name === 'Offline Model' && status?.ready && (
                      <span className="inline-block size-1.5 rounded-full bg-green-500 shrink-0" />
                    )}
                    <span className="truncate">
                      {getSubtitle(profile, status, t, { compact })}
                    </span>
                  </div>
                </div>

                <div className="ml-3 flex shrink-0 items-center gap-2">
                  {status?.badge && (
                    <span className="text-ui-xs text-[var(--oa-text-faint)]">
                      {status.badge}
                    </span>
                  )}
                  <ChevronRight className="size-4 text-muted-foreground/70 transition-transform duration-150 group-hover:translate-x-0.5" />
                </div>
              </button>

              {canDelete && (
                <Button
                  type="button"
                  variant="utility"
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteProfile(profile.id);
                  }}
                  className={`shrink-0 rounded-full px-3 ${
                    isConfirmingDelete
                      ? 'bg-destructive/10 text-destructive hover:bg-destructive/16 hover:text-destructive'
                      : 'text-[var(--oa-text-faint)] hover:text-destructive'
                  }`}
                >
                  <Trash2 className="size-3.5" />
                  {isConfirmingDelete
                    ? t('settings.profiles.detail.clickToConfirm')
                    : t('common.delete')}
                </Button>
              )}
            </div>
          );
        })}

        {onAddCustom && (
          <button
            type="button"
            onClick={onAddCustom}
            className="group flex w-full items-center gap-3 rounded-[10px] px-2 py-3 text-left transition-[background-color,color] duration-150 hover:bg-black/[0.025] dark:hover:bg-white/[0.035]"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.025] text-muted-foreground dark:bg-white/[0.04]">
              <Plus className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-ui-sm font-medium text-foreground">
                {t('settings.profiles.card.newModel')}
              </div>
              <div className="mt-1 text-ui-xs text-muted-foreground">
                {t('settings.profiles.presetPicker.choosePresetDescription')}
              </div>
            </div>
            <ChevronRight className="size-4 text-muted-foreground/70 transition-transform duration-150 group-hover:translate-x-0.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Card grid */}
      <div className="grid grid-cols-2 @[500px]:grid-cols-4 gap-4">
        {displayProfiles.map(profile => {
          const status = statuses[profile.id];
          const showExpensiveBadge = isExpensiveModelId(profile.modelId);

          return (
            <button
              key={profile.id}
              onClick={() => onCardClick(profile)}
              data-testid={PROFILE_CARD_ID(profile.id)}
              className="flex flex-col items-center justify-center p-4 rounded-[var(--control-radius-lg)] transition-all hover:bg-hover text-center relative"
              style={{
                border: 'var(--border-width) solid var(--border)',
                height: 'calc(var(--unit-height) * 4)',
              }}
            >
              {/* Badges */}
              <div className="absolute top-2 right-2 flex items-center gap-1">
                {profile.isExperimental && (
                  <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-ui-xs font-medium">
                    {t('settings.profiles.card.experimentalFull')}
                  </Badge>
                )}
                {status?.badge && (
                  <Badge variant="secondary" className="rounded-full px-2.5 py-0.5 text-ui-xs font-medium">
                    {status?.badge}
                  </Badge>
                )}
              </div>

              {/* Icon */}
              <div className="mb-3">
                {getProviderIcon(profile.provider, profile.name)}
              </div>

              {/* Name */}
              <div className="flex items-center justify-center gap-2">
                <span className="text-ui-base font-medium text-foreground">
                  {profile.name}
                </span>
                {showExpensiveBadge ? <ExpensiveModelBadge /> : null}
              </div>

              {/* Subtitle */}
              <div className="text-ui-xs text-muted-foreground mt-1 line-clamp-2 flex items-center justify-center gap-1.5">
                {profile.name === 'Offline Model' && status?.ready && (
                  <span className="inline-block size-1.5 rounded-full bg-green-500 shrink-0" />
                )}
                {getSubtitle(profile, status, t, { compact })}
              </div>
            </button>
          );
        })}

      </div>

      {/* Not-ready profiles as text links (onboarding only) */}
      {mode === 'onboarding' && notReadyProfiles.length > 0 && (
        <div className="text-center">
          <p className="text-ui-xs text-muted-foreground">
            {t('settings.profiles.card.otherProviders')}{' '}
            {notReadyProfiles.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ', '}
                <button
                  onClick={() => onCardClick(p)}
                  className="underline hover:text-foreground transition-colors"
                >
                  {p.name}
                </button>
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}
