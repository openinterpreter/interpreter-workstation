import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePaidPlanStatus } from '@/hooks/usePaidPlanStatus';
import { supabase } from '@/utils/supabase/client';
import { calculatePercentRemaining } from '@/utils/modelCostSignals';
import {
  INTERPRETER_STARTER_CREDITS,
  getSubscriptionMonthlyCredits,
} from '../../shared/constants/interpreter-plans';
import { isMarketingDemoMode } from '../demo/marketingDemo';

interface UserTokens {
  monthly_tokens: number;
  purchased_tokens: number;
}

interface InterpreterTokenUsageState {
  loading: boolean;
  totalCredits: number | null;
  maxCredits: number | null;
  percentRemaining: number | null;
}

export function useInterpreterTokenUsage(): InterpreterTokenUsageState {
  "use no memo";

  const marketingDemoMode = isMarketingDemoMode();

  const { user, isAuthenticated } = useAuth();
  const {
    subscription,
    loading: subscriptionLoading,
  } = usePaidPlanStatus();
  const [loading, setLoading] = useState(false);
  const [totalCredits, setTotalCredits] = useState<number | null>(null);

  useEffect(() => {
    if (marketingDemoMode) {
      setLoading(false);
      setTotalCredits(null);
      return;
    }

    if (!isAuthenticated || !user?.id) {
      setLoading(false);
      setTotalCredits(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const loadUsage = async () => {
      const { data, error } = await supabase
        .from('desktop_user_tokens')
        .select('monthly_tokens, purchased_tokens')
        .eq('user_id', user.id)
        .maybeSingle();

      if (cancelled) return;
      setLoading(false);

      if (error || !data) {
        setTotalCredits(null);
        return;
      }

      const usage = data as UserTokens;
      setTotalCredits(Math.max(0, usage.monthly_tokens + usage.purchased_tokens));
    };

    void loadUsage();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, marketingDemoMode, user?.id]);

  const maxCredits = useMemo(() => {
    if (subscriptionLoading) {
      return null;
    }

    return getSubscriptionMonthlyCredits(subscription) ?? INTERPRETER_STARTER_CREDITS;
  }, [subscription, subscriptionLoading]);

  const percentRemaining = useMemo(() => {
    if (totalCredits === null || maxCredits === null) return null;
    return calculatePercentRemaining(totalCredits, maxCredits);
  }, [maxCredits, totalCredits]);

  if (marketingDemoMode) {
    return {
      loading: false,
      totalCredits: null,
      maxCredits: null,
      percentRemaining: null,
    };
  }

  return {
    loading: loading || subscriptionLoading,
    totalCredits,
    maxCredits,
    percentRemaining,
  };
}
