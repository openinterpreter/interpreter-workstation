import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../utils/supabase/client';
import { ExternalLink } from 'lucide-react';
import { Button } from '../ui/button';
import { openExternal } from '@/ipc';
import { isActivePaidSubscription } from '@/hooks/usePaidPlanStatus';
import { createProfile, getProfiles, setDefaultProfile, setFastProfile } from '../../api';
import { SettingsActionButton } from './SettingsSection';
import { useToast } from '@/contexts/ToastContext';
import { PROVIDER_MODEL_DEFAULTS } from '../../../shared/types/modelDefaults';
import { BUILTIN_PROVIDER_IDS } from '../../../shared/types/provider';
import type { Profile } from '../../../shared/types/profile';
import type {
  UsageBreakdownSummaryResponse,
  UsageBreakdownSummaryResponseData,
} from '../../../shared/types/usageBreakdown';
import {
  PlanUsageBreakdownCard,
  UsageBreakdownRow,
} from './PlanUsageBreakdown';
import { InterpreterLogoMark } from '../InterpreterLogoMark';
import { HostedProviderIcon } from '../icons/HostedProviderIcon';
import { getInterpreterHostedApiBaseUrl } from '../../../shared/hostedApi';
import {
  getUsageAccentColor,
  resolveUsageIconIdentity,
} from './planUsageAppearance';
import {
  INTERPRETER_STARTER_CREDITS,
  WORKSTATION_BUSINESS_PRICE_ID,
  WORKSTATION_PRO_PRICE_ID,
  getSubscriptionMonthlyCredits,
  getSubscriptionPriceId,
  getWorkstationPlanByPriceId,
} from '../../../shared/constants/interpreter-plans';

function getHostedBillingBaseUrl(): string {
  const baseUrl = getInterpreterHostedApiBaseUrl();
  if (!baseUrl) {
    throw new Error('Hosted billing is not configured for this distribution.');
  }
  return baseUrl;
}
const INTERPRETER_HOSTED_PROFILES = [
  { name: 'Interpreter Smart', modelId: PROVIDER_MODEL_DEFAULTS.hosted.main },
  { name: 'Interpreter Fast', modelId: PROVIDER_MODEL_DEFAULTS.hosted.fast },
] as const;

interface SubscriptionPriceInfo {
  id: string;
}

interface SubscriptionMetadata extends Record<string, unknown> {
  price_info?: SubscriptionPriceInfo;
}

interface Subscription {
  id: string;
  status: string | null;
  current_period_end: string;
  current_period_start: string;
  metadata: SubscriptionMetadata;
  price_id: string | null;
}

interface UserTokens {
  monthly_tokens: number;
  purchased_tokens: number;
}

interface StripePortalResponse {
  data?: {
    sessionUrl?: string;
  };
}

interface StripeCustomerResponse {
  data?: {
    customer_id?: string;
  };
}

interface StripeCheckoutResponse {
  data?: {
    sessionUrl?: string;
  };
  sessionUrl?: string;
  error?: string;
}

// Cache to persist values across remounts
const planCache: {
  subscription: Subscription | null;
  userTokens: UserTokens | null;
  loaded: boolean;
} = { subscription: null, userTokens: null, loaded: false };

function getBillingErrorMessage(defaultMessage: string, error?: unknown): string {
  return typeof error === 'string' && error.trim() ? error : defaultMessage;
}

function buildUniqueProfileName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) {
    existingNames.add(baseName);
    return baseName;
  }

  let suffix = 2;
  while (existingNames.has(`${baseName} ${suffix}`)) {
    suffix += 1;
  }
  const nextName = `${baseName} ${suffix}`;
  existingNames.add(nextName);
  return nextName;
}

function UsageBreakdownIcon({ label }: { label: string }) {
  const identity = resolveUsageIconIdentity(label);

  if (identity.type === 'interpreter') {
    return (
      <InterpreterLogoMark
        fitSquare
        size={16}
        segmentClassName="bg-current"
        className="text-foreground/80"
      />
    );
  }

  return (
    <HostedProviderIcon
      modelId={identity.modelId}
      provider={identity.provider}
      className="size-4 rounded-[4px] object-contain grayscale"
    />
  );
}

export function PlanSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const { user, session, isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const [subscription, setSubscription] = useState<Subscription | null>(planCache.subscription);
  const [userTokens, setUserTokens] = useState<UserTokens | null>(planCache.userTokens);
  const [initialLoading, setInitialLoading] = useState(!planCache.loaded);
  const [usageInsights, setUsageInsights] = useState<UsageBreakdownSummaryResponseData | null>(null);
  const [usageInsightsLoading, setUsageInsightsLoading] = useState(false);
  const [advancedUsageExpanded, setAdvancedUsageExpanded] = useState(false);
  const genericBillingLoadError = t('settings.plan.billingLoadError');
  const genericCheckoutError = t('settings.plan.checkoutError');
  const genericPortalError = t('settings.plan.portalError');

  async function resolveStripeCustomerId(action: 'checkout' | 'billing'): Promise<string | null> {
    if (!session?.access_token) {
      const message = action === 'billing'
        ? t('settings.plan.portalReauth')
        : t('settings.plan.checkoutReauth');
      console.warn(`[PlanSection] ${action} aborted: no access token available`);
      showToast(message, 'error', 7000);
      return null;
    }

    const customerResponse = await fetch(`${getHostedBillingBaseUrl()}/v0/stripe/new_customer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': session.access_token
      },
      body: JSON.stringify({ customer_email: user?.email })
    });

    let customerResult: StripeCustomerResponse | null = null;
    try {
      customerResult = await customerResponse.json() as StripeCustomerResponse;
    } catch (parseError) {
      console.error(`[PlanSection] Failed to parse ${action} customer response`, parseError);
    }

    if (!customerResponse.ok) {
      console.error(`[PlanSection] Failed to resolve Stripe customer for ${action}`, {
        status: customerResponse.status,
        result: customerResult,
      });
      showToast(action === 'billing' ? genericPortalError : genericCheckoutError, 'error', 8000);
      return null;
    }

    const customerId = customerResult?.data?.customer_id;
    if (!customerId) {
      console.error(`[PlanSection] ${action} new_customer response missing customer_id`, customerResult);
      showToast(action === 'billing' ? genericPortalError : genericCheckoutError, 'error', 8000);
      return null;
    }

    return customerId;
  }

  useEffect(() => {
    async function fetchBillingInfo() {
      if (!user?.id) {
        setInitialLoading(false);
        return;
      }

      try {
        const { data: subData, error: subError } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("user_id", user.id)
          .eq("status", "active")
          .maybeSingle();

        if (subError) {
          console.error('[PlanSection] Failed to load subscription details', subError);
          showToast(genericBillingLoadError, 'error', 8000);
        } else if (subData) {
          setSubscription(subData);
          planCache.subscription = subData;
        } else {
          setSubscription(null);
          planCache.subscription = null;
        }

        const { data: tokenData, error: tokenError } = await supabase
          .from("desktop_user_tokens")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (tokenError) {
          console.error('[PlanSection] Failed to load token usage details', tokenError);
          showToast(genericBillingLoadError, 'error', 8000);
        } else if (tokenData) {
          setUserTokens(tokenData);
          planCache.userTokens = tokenData;
        } else {
          setUserTokens(null);
          planCache.userTokens = null;
        }

        planCache.loaded = true;
      } catch (error) {
        console.error("Error fetching billing info:", error);
        showToast(genericBillingLoadError, 'error', 8000);
      } finally {
        setInitialLoading(false);
      }
    }

    if (isAuthenticated) {
      fetchBillingInfo();
    } else {
      setInitialLoading(false);
    }
  }, [user?.id, isAuthenticated]);

  useEffect(() => {
    async function fetchUsageInsights() {
      if (!user?.id || !session?.access_token) {
        setUsageInsights(null);
        setUsageInsightsLoading(false);
        return;
      }

      setUsageInsightsLoading(true);

      try {
        const response = await fetch(`${getHostedBillingBaseUrl()}/v0/stripe/usage_breakdown_summary`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': session.access_token,
          },
          body: JSON.stringify({ userId: user.id }),
        });

        let result: UsageBreakdownSummaryResponse | null = null;
        try {
          result = await response.json() as UsageBreakdownSummaryResponse;
        } catch (parseError) {
          console.error('[PlanSection] Failed to parse advanced usage details response', parseError);
        }

        if (!response.ok) {
          console.error('[PlanSection] Failed to load advanced usage details', {
            status: response.status,
            result,
          });
          setUsageInsights(null);
          return;
        }

        setUsageInsights(result?.data ?? null);
      } catch (error) {
        console.error('[PlanSection] Failed to load advanced usage details', error);
        setUsageInsights(null);
      } finally {
        setUsageInsightsLoading(false);
      }
    }

    if (isAuthenticated) {
      fetchUsageInsights();
    } else {
      setUsageInsights(null);
      setUsageInsightsLoading(false);
    }
  }, [isAuthenticated, session?.access_token, subscription, user?.id]);

  async function ensureInterpreterModelsForUpgrade() {
    const { profiles, defaultProfileId, fastProfileId } = await getProfiles();
    const hasInterpreterHostedProfile = profiles.some((profile) => (
      profile.provider === 'hosted'
      && (
        profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.main
        || profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.fast
      )
    ));

    if (hasInterpreterHostedProfile) {
      return;
    }

    const existingNames = new Set(profiles.map((profile) => profile.name));
    const createdProfiles: Profile[] = [];
    let counter = 0;
    for (const interpreterProfile of INTERPRETER_HOSTED_PROFILES) {
      const profileId = `custom:${Date.now()}-${counter}`;
      counter += 1;
      const created = await createProfile({
        id: profileId,
        name: buildUniqueProfileName(interpreterProfile.name, existingNames),
        provider: 'hosted',
        providerId: BUILTIN_PROVIDER_IDS.HOSTED,
        modelId: interpreterProfile.modelId,
        isBuiltin: false,
      });
      createdProfiles.push(created.profile);
    }

    const createdSmartProfile = createdProfiles.find((profile) => profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.main);
    const createdFastProfile = createdProfiles.find((profile) => profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.fast);

    if (!defaultProfileId && createdSmartProfile) {
      await setDefaultProfile(createdSmartProfile.id);
    }
    if (!fastProfileId) {
      await setFastProfile((createdFastProfile || createdSmartProfile || createdProfiles[0]).id);
    }
    showToast(t('settings.plan.interpreterModelsAdded'), 'success', 5000);
  }

  async function handleUpgrade(priceId: string) {
    try {
      try {
        await ensureInterpreterModelsForUpgrade();
      } catch (profileErr) {
        console.error('[PlanSection] Failed to pre-create interpreter profiles, proceeding with upgrade', profileErr);
      }
      const customerId = await resolveStripeCustomerId('checkout');
      if (!customerId || !session?.access_token) {
        return;
      }

      const response = await fetch(`${getHostedBillingBaseUrl()}/v0/stripe/checkout_session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': session.access_token
        },
        body: JSON.stringify({
          customerId,
          priceId
        })
      });

      let result: StripeCheckoutResponse | null = null;
      try {
        result = await response.json() as StripeCheckoutResponse;
      } catch (parseError) {
        console.error('[PlanSection] Failed to parse checkout session response', parseError);
      }

      if (!response.ok) {
        console.error('[PlanSection] Checkout session request failed', {
          status: response.status,
          result,
        });
        showToast(getBillingErrorMessage(genericCheckoutError, result?.error), 'error', 9000);
        return;
      }

      const sessionUrl = result?.data?.sessionUrl || result?.sessionUrl;

      if (!sessionUrl) {
        console.error('[PlanSection] Checkout session response missing sessionUrl', result);
        showToast(genericCheckoutError, 'error', 8000);
        return;
      }

      await openExternal(sessionUrl);
    } catch (error) {
      console.error('Error creating checkout session:', error);
      showToast(genericCheckoutError, 'error', 8000);
    }
  }

  const formatCount = (value: number) => value.toLocaleString('en-US');
  if (!isAuthenticated) {
    return null;
  }

  const isPro = isActivePaidSubscription(subscription);
  const currentPriceId = getSubscriptionPriceId(subscription);
  const currentPlan = getWorkstationPlanByPriceId(currentPriceId);
  const hasBusinessPlan = currentPlan?.id === 'business';
  const planName = isPro
    ? currentPlan?.name ?? t('settings.plan.activeSubscription')
    : t('settings.plan.free');
  const monthlyCreditCap = getSubscriptionMonthlyCredits(subscription) ?? INTERPRETER_STARTER_CREDITS;
  const freePlanUpgrades = [
    {
      priceId: WORKSTATION_PRO_PRICE_ID,
      label: t('settings.plan.upgradeToPlan', {
        plan: t('settings.plan.proTier'),
      }),
    },
    {
      priceId: WORKSTATION_BUSINESS_PRICE_ID,
      label: t('settings.plan.upgradeToPlan', {
        plan: t('settings.plan.businessTier'),
      }),
    },
  ] as const;
  const paidPlanUpgrade = hasBusinessPlan
    ? null
    : {
        priceId: WORKSTATION_BUSINESS_PRICE_ID,
        label: t('settings.plan.upgradeToPlan', {
          plan: t('settings.plan.businessTier'),
        }),
      };
  const calculateTokensLeft = () => {
    if (!userTokens) return { percentLeft: 100 };

    const totalTokens = userTokens.monthly_tokens + userTokens.purchased_tokens;
    const percentLeft = Math.min(Math.max((totalTokens / monthlyCreditCap) * 100, 0), 100);

    return { percentLeft };
  };
  const { percentLeft } = calculateTokensLeft();

  if (initialLoading) {
    return <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  // Format renewal date
  const renewalDate = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  async function handleManageBilling() {
    console.log('[PlanSection] Manage billing clicked', {
      userId: user?.id ?? null,
      email: user?.email ?? null,
      hasAccessToken: !!session?.access_token,
      subscriptionId: subscription?.id ?? null,
      subscriptionStatus: subscription?.status ?? null,
    });

    if (!session?.access_token) {
      console.warn('[PlanSection] Manage billing aborted before customer resolution: no access token available');
      return;
    }

    try {
      const customerId = await resolveStripeCustomerId('billing');
      if (!customerId) {
        return;
      }

      const response = await fetch(`${getHostedBillingBaseUrl()}/v0/stripe/billing_portal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': session.access_token
        },
        body: JSON.stringify({ customerId })
      });

      let result: StripePortalResponse | null = null;
      try {
        result = await response.json() as StripePortalResponse;
      } catch (parseError) {
        console.error('[PlanSection] Failed to parse billing portal response', parseError);
      }

      console.log('[PlanSection] Billing portal response received', {
        ok: response.ok,
        status: response.status,
        hasPortalUrl: !!result?.data?.sessionUrl,
      });

      if (!response.ok) {
        console.error('[PlanSection] Billing portal request failed', {
          status: response.status,
          result,
        });
        const message = getBillingErrorMessage(genericPortalError, (result as { error?: unknown } | null)?.error);
        showToast(message, 'error', 9000);
        return;
      }

      const portalUrl = result?.data?.sessionUrl;
      if (!portalUrl) {
        console.error('[PlanSection] Billing portal response missing sessionUrl', result);
        showToast(genericPortalError, 'error', 8000);
        return;
      }

      console.log('[PlanSection] Opening billing portal URL', portalUrl);
      await openExternal(portalUrl);
      console.log('[PlanSection] Billing portal opened successfully');
    } catch (error) {
      console.error('Error opening billing portal:', error);
      showToast(genericPortalError, 'error', 8000);
    }
  }

  return (
    <div className="py-[18px]">
      <div className="space-y-5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-3 max-[560px]:grid-cols-1">
          <div className="min-w-0">
            <div className="text-[15px] font-medium leading-6 text-foreground">
              {planName}
            </div>
            <div className="mt-1 text-ui-sm leading-6 text-muted-foreground">
              {isPro
                ? renewalDate
                  ? t('settings.plan.renewsDate', { date: renewalDate })
                  : t('settings.plan.activeSubscription')
                : t('settings.plan.freeLimitDescription')}
            </div>
          </div>

          {isPro ? (
            <div className="flex shrink-0 flex-col items-end gap-2 max-[560px]:items-start">
              <div className="flex items-start gap-2 max-[560px]:flex-col max-[560px]:items-start">
                <SettingsActionButton
                  icon={ExternalLink}
                  className="shrink-0"
                  onClick={handleManageBilling}
                >
                  {t('settings.plan.manage')}
                </SettingsActionButton>
                {paidPlanUpgrade ? (
                  <Button
                    onClick={() => { void handleUpgrade(paidPlanUpgrade.priceId); }}
                    size="sm"
                    variant="outline"
                    className="shrink-0 px-3 max-[560px]:whitespace-normal"
                  >
                    {paidPlanUpgrade.label}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex shrink-0 flex-col items-end gap-2 max-[560px]:items-start">
              <div className="flex flex-wrap justify-end gap-2 max-[560px]:justify-start">
                {freePlanUpgrades.map((upgrade) => (
                  <div key={upgrade.priceId}>
                    <Button
                      onClick={() => { void handleUpgrade(upgrade.priceId); }}
                      size="sm"
                      variant="outline"
                      className="px-3 max-[560px]:whitespace-normal"
                    >
                      {upgrade.label}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          className="w-full pt-4"
          style={{
            borderTop:
              'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 42%, transparent)',
          }}
        >
          <PlanUsageBreakdownCard
            title={t('settings.plan.monthlyUsage')}
            toggleLabel={advancedUsageExpanded
              ? t('settings.plan.advanced.hide')
              : t('settings.plan.advanced.show')}
            expanded={advancedUsageExpanded}
            onToggle={() => setAdvancedUsageExpanded((expanded) => !expanded)}
          >
            <UsageBreakdownRow
              label="Interpreter"
              percentage={percentLeft}
              summary={`${Math.round(percentLeft)}% ${t('settings.plan.remaining')}`}
              icon={(
                <InterpreterLogoMark
                  fitSquare
                  size={16}
                  segmentClassName="bg-current"
                  className="text-foreground/80"
                />
              )}
            />

            {advancedUsageExpanded ? (
              <div
                className="space-y-5 pt-1"
                style={{
                  borderTop:
                    'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)',
                }}
              >
                {usageInsightsLoading ? (
                  <div className="text-ui-sm leading-6 text-muted-foreground">
                    {t('common.loading')}
                  </div>
                ) : usageInsights && usageInsights.totalRequests > 0 ? (
                  <div className="space-y-4">
                    <div className="text-ui-xs font-medium text-muted-foreground">
                      {t('settings.plan.advanced.modelBreakdown')}
                    </div>
                    <div className="space-y-4">
                      {usageInsights.byModel.map((entry) => (
                        <UsageBreakdownRow
                          key={entry.model}
                          label={entry.model}
                          percentage={entry.percentage}
                          summary={`${Math.round(entry.percentage)}%`}
                          detail={`${formatCount(entry.requests)} ${t('settings.plan.advanced.requests')} / ${formatCount(entry.chargedTokens)} ${t('settings.plan.advanced.tokens')}`}
                          accentColor={getUsageAccentColor(entry.model)}
                          icon={<UsageBreakdownIcon label={entry.model} />}
                          showBar={false}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-ui-sm leading-6 text-muted-foreground">
                    {t('settings.plan.advanced.emptyState')}
                  </div>
                )}
              </div>
            ) : null}
          </PlanUsageBreakdownCard>
        </div>
      </div>
    </div>
  );
}
