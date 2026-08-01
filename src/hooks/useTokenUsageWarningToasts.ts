import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { usePaidPlanStatus } from '@/hooks/usePaidPlanStatus';
import { supabase } from '@/utils/supabase/client';
import { calculatePercentRemaining } from '@/utils/modelCostSignals';
import {
  INTERPRETER_STARTER_CREDITS,
  getSubscriptionMonthlyCredits,
} from '../../shared/constants/interpreter-plans';

const LOW_USAGE_WARNING_THRESHOLD_PERCENT = 25;
const CRITICAL_USAGE_WARNING_THRESHOLD_PERCENT = 5;

interface UserTokens {
  monthly_tokens: number;
  purchased_tokens: number;
}

function getWarningThreshold(percentRemaining: number): number | null {
  if (percentRemaining <= CRITICAL_USAGE_WARNING_THRESHOLD_PERCENT) {
    return CRITICAL_USAGE_WARNING_THRESHOLD_PERCENT;
  }
  if (percentRemaining <= LOW_USAGE_WARNING_THRESHOLD_PERCENT) {
    return LOW_USAGE_WARNING_THRESHOLD_PERCENT;
  }
  return null;
}

function buildStorageKey(userId: string, billingPeriodStart: string, thresholdPercent: number): string {
  return `workstation.token-usage-warning.${userId}.${billingPeriodStart}.${thresholdPercent}`;
}

export function useTokenUsageWarningToasts(): void {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { user, isAuthenticated } = useAuth();
  const { isPaid, loading, subscription } = usePaidPlanStatus();

  useEffect(() => {
    if (!isAuthenticated || !user?.id || loading || !isPaid) return;

    let cancelled = false;

    const checkUsageThreshold = async () => {
      const { data, error } = await supabase
        .from('desktop_user_tokens')
        .select('monthly_tokens, purchased_tokens')
        .eq('user_id', user.id)
        .maybeSingle();

      if (cancelled || error || !data) return;

      const userTokens = data as UserTokens;
      const remainingTokens = userTokens.monthly_tokens + userTokens.purchased_tokens;
      const maxCredits = getSubscriptionMonthlyCredits(subscription) ?? INTERPRETER_STARTER_CREDITS;
      const percentRemaining = calculatePercentRemaining(remainingTokens, maxCredits);
      const threshold = getWarningThreshold(percentRemaining);
      if (threshold === null) return;

      const billingPeriodStart = subscription?.current_period_start || 'unknown-period';
      const storageKey = buildStorageKey(user.id, billingPeriodStart, threshold);
      if (window.localStorage.getItem(storageKey) === 'shown') return;

      showToast(
        t('tokenUsage.warningRemaining', { percent: threshold }),
        'info',
        9000,
      );
      window.localStorage.setItem(storageKey, 'shown');
    };

    void checkUsageThreshold();

    return () => {
      cancelled = true;
    };
  }, [
    isAuthenticated,
    user?.id,
    loading,
    isPaid,
    subscription?.price_id,
    subscription?.current_period_start,
    showToast,
    t,
  ]);
}
