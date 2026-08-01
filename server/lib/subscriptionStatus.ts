import { isInterpreterOverlayAllowedProductId } from '../../shared/constants/interpreter-overlay-entitlement';
import { getCurrentServerAccessTokenSync } from './authTokens';
import { distributionProductConfig } from '../../shared/productConfig';

const SUPABASE_URL = distributionProductConfig.auth.url;
const SUPABASE_ANON_KEY = distributionProductConfig.auth.anonKey;
const SUBSCRIPTION_LOOKUP_TIMEOUT_MS = 5000;
const INTERPRETER_OVERLAY_ACCESS_CACHE_TTL_MS = 60000;

export interface SubscriptionBackendConfig {
  url: string;
  anonKey: string;
}

const DEFAULT_SUBSCRIPTION_BACKEND: SubscriptionBackendConfig = {
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
};

export type InterpreterOverlayAccessReason =
  | 'allowed'
  | 'signed-out'
  | 'unpaid'
  | 'error'
  | 'unsupported-platform';

export interface InterpreterOverlayAccessState {
  allowed: boolean;
  reason: InterpreterOverlayAccessReason;
  detail?: string;
}

interface SubscriptionRecord {
  status: string | null;
  prices?: {
    product_id: string | null;
  } | null;
}

class InvalidAuthSessionError extends Error {
  constructor(status: number) {
    super(`Subscription lookup rejected the auth session with ${status}`);
    this.name = 'InvalidAuthSessionError';
  }
}

let interpreterOverlayAccessCache: {
  accessToken: string | null;
  backendUrl: string;
  checkedAt: number;
  state: InterpreterOverlayAccessState;
} | null = null;

export function isActivePaidSubscription(
  subscription: SubscriptionRecord | null | undefined,
): boolean {
  return subscription?.status === 'active';
}

export function hasInterpreterOverlayEntitlement(
  subscription: SubscriptionRecord | null | undefined,
): boolean {
  return isActivePaidSubscription(subscription)
    && isInterpreterOverlayAllowedProductId(subscription?.prices?.product_id);
}

export async function hasActivePaidSubscriptionForAccessToken(
  accessToken: string | null,
  backend: SubscriptionBackendConfig = DEFAULT_SUBSCRIPTION_BACKEND,
): Promise<boolean> {
  if (!accessToken) {
    return false;
  }
  if (!backend.url || !backend.anonKey) {
    return false;
  }

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort(
      new Error(`Subscription lookup timed out after ${SUBSCRIPTION_LOOKUP_TIMEOUT_MS}ms`),
    );
  }, SUBSCRIPTION_LOOKUP_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(
      `${backend.url}/rest/v1/subscriptions?select=status,prices!subscriptions_price_id_fkey(product_id)&status=eq.active&order=current_period_end.desc&limit=10`,
      {
        headers: {
          apikey: backend.anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: timeoutController.signal,
      },
    );
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (response.status === 401 || response.status === 403) {
    throw new InvalidAuthSessionError(response.status);
  }

  if (!response.ok) {
    throw new Error(`Subscription lookup failed with ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Subscription lookup returned an unexpected payload');
  }

  return (payload as SubscriptionRecord[]).some((subscription) =>
    hasInterpreterOverlayEntitlement(subscription),
  );
}

export async function getInterpreterOverlayAccessStateForAccessToken(
  accessToken: string | null,
  options?: {
    forceRefresh?: boolean;
    subscriptionBackend?: SubscriptionBackendConfig;
  },
): Promise<InterpreterOverlayAccessState> {
  if (process.env.FORM_TESTS_MODE === 'true') {
    return { allowed: true, reason: 'allowed' };
  }

  const subscriptionBackend = options?.subscriptionBackend ?? DEFAULT_SUBSCRIPTION_BACKEND;

  // Community and self-managed distributions that do not configure a hosted
  // account backend get the local overlay feature without a subscription gate.
  if (!subscriptionBackend.url || !subscriptionBackend.anonKey) {
    return { allowed: true, reason: 'allowed' };
  }

  if (!accessToken) {
    return { allowed: false, reason: 'signed-out' };
  }

  const now = Date.now();
  if (
    !options?.forceRefresh
    && interpreterOverlayAccessCache?.accessToken === accessToken
    && interpreterOverlayAccessCache.backendUrl === subscriptionBackend.url
    && now - interpreterOverlayAccessCache.checkedAt < INTERPRETER_OVERLAY_ACCESS_CACHE_TTL_MS
  ) {
    return interpreterOverlayAccessCache.state;
  }

  let state: InterpreterOverlayAccessState;
  try {
    const allowed = await hasActivePaidSubscriptionForAccessToken(accessToken, subscriptionBackend);
    state = allowed
      ? { allowed: true, reason: 'allowed' }
      : { allowed: false, reason: 'unpaid' };
  } catch (error) {
    if (error instanceof InvalidAuthSessionError) {
      state = {
        allowed: false,
        reason: 'signed-out',
        detail: 'Please sign in again to verify your plan.',
      };
    } else {
      state = {
        allowed: false,
        reason: 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  interpreterOverlayAccessCache = {
    accessToken,
    backendUrl: subscriptionBackend.url,
    checkedAt: now,
    state,
  };
  return state;
}

export async function getInterpreterOverlayAccessState(
  options?: { forceRefresh?: boolean },
): Promise<InterpreterOverlayAccessState> {
  return getInterpreterOverlayAccessStateForAccessToken(
    getCurrentServerAccessTokenSync(),
    options,
  );
}

export function clearInterpreterOverlayAccessStateCacheForTest(): void {
  interpreterOverlayAccessCache = null;
}
