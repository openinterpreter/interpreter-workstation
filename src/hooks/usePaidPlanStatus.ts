import { useEffect, useState } from 'react';

import { isInterpreterOverlayAllowedProductId } from '../../shared/constants/interpreter-overlay-entitlement';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../utils/supabase/client';
import { isMarketingDemoMode } from '../demo/marketingDemo';

export interface ActiveSubscription {
  id: string;
  status: string | null;
  current_period_end: string;
  current_period_start: string;
  metadata: Record<string, unknown> | null;
  price_id: string | null;
  prices?:
    | {
        product_id: string | null;
      }
    | Array<{
        product_id: string | null;
      }>
    | null;
}

function getSubscriptionProductId(
  subscription: ActiveSubscription | null | undefined,
): string | null | undefined {
  const prices = subscription?.prices;
  if (Array.isArray(prices)) {
    return prices[0]?.product_id;
  }

  return prices?.product_id;
}

const paidPlanCache: {
  loaded: boolean;
  overlayEligible: boolean;
  subscription: ActiveSubscription | null;
  userId: string | null;
} = {
  loaded: false,
  overlayEligible: false,
  subscription: null,
  userId: null,
};

export function isActivePaidSubscription(
  subscription: Pick<ActiveSubscription, 'status'> | null | undefined,
): boolean {
  return subscription?.status === 'active';
}

export function clearPaidPlanCache(): void {
  paidPlanCache.loaded = false;
  paidPlanCache.overlayEligible = false;
  paidPlanCache.subscription = null;
  paidPlanCache.userId = null;
}

export function hasInterpreterOverlayEntitlement(
  subscription: ActiveSubscription | null | undefined,
): boolean {
  return isActivePaidSubscription(subscription)
    && isInterpreterOverlayAllowedProductId(getSubscriptionProductId(subscription));
}

export function usePaidPlanStatus(): {
  isPaid: boolean;
  isOverlayEligible: boolean;
  loading: boolean;
  subscription: ActiveSubscription | null;
} {
  "use no memo";

  const marketingDemoMode = isMarketingDemoMode();

  const { user, isAuthenticated } = useAuth();
  const hasCachedValue = paidPlanCache.loaded && paidPlanCache.userId === user?.id;

  const [subscription, setSubscription] = useState<ActiveSubscription | null>(
    hasCachedValue ? paidPlanCache.subscription : null,
  );
  const [loading, setLoading] = useState(
    Boolean(!marketingDemoMode && isAuthenticated && user?.id && !hasCachedValue),
  );

  useEffect(() => {
    if (marketingDemoMode) {
      clearPaidPlanCache();
      setSubscription(null);
      setLoading(false);
      return;
    }

    if (!isAuthenticated || !user?.id) {
      clearPaidPlanCache();
      setSubscription(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const loadSubscription = async (background = false) => {
      if (!background) {
        setLoading(true);
      }

      try {
        const { data, error } = await supabase
          .from('subscriptions')
          .select('id, status, current_period_end, current_period_start, metadata, price_id, prices!subscriptions_price_id_fkey(product_id)')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .order('current_period_end', { ascending: false })
          .limit(10);

        if (cancelled) return;

        if (error) {
          console.error('[usePaidPlanStatus] Failed to load subscription', error);
          paidPlanCache.subscription = null;
          paidPlanCache.overlayEligible = false;
        } else {
          const subscriptions = Array.isArray(data)
            ? (data as unknown as ActiveSubscription[])
            : [];
          paidPlanCache.subscription = subscriptions[0] ?? null;
          paidPlanCache.overlayEligible = subscriptions.some((subscription) =>
            hasInterpreterOverlayEntitlement(subscription),
          );
        }

        paidPlanCache.loaded = true;
        paidPlanCache.userId = user.id;
        setSubscription(paidPlanCache.subscription);
      } catch (error) {
        if (cancelled) return;
        console.error('[usePaidPlanStatus] Failed to load subscription', error);
        paidPlanCache.loaded = true;
        paidPlanCache.overlayEligible = false;
        paidPlanCache.subscription = null;
        paidPlanCache.userId = user.id;
        setSubscription(null);
      } finally {
        if (!cancelled && !background) {
          setLoading(false);
        }
      }
    };

    if (hasCachedValue) {
      setSubscription(paidPlanCache.subscription);
      setLoading(false);
    } else {
      setSubscription(null);
    }

    void loadSubscription(hasCachedValue);

    const handleWindowFocus = () => {
      void loadSubscription(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadSubscription(true);
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [hasCachedValue, isAuthenticated, marketingDemoMode, user?.id]);

  if (marketingDemoMode) {
    return {
      isPaid: false,
      isOverlayEligible: true,
      loading: false,
      subscription: null,
    };
  }

  return {
    isPaid: isActivePaidSubscription(subscription),
    isOverlayEligible: paidPlanCache.overlayEligible,
    loading,
    subscription,
  };
}
