import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  clearInterpreterOverlayAccessStateCacheForTest,
  getInterpreterOverlayAccessStateForAccessToken,
  hasInterpreterOverlayEntitlement,
  hasActivePaidSubscriptionForAccessToken,
  isActivePaidSubscription,
} from './subscriptionStatus';

describe('subscriptionStatus', () => {
  const originalFetch = global.fetch;
  const hostedSubscriptionOptions = {
    subscriptionBackend: {
      url: 'https://auth.example.test',
      anonKey: 'public-client-config',
    },
  } as const;

  beforeEach(() => {
    mock.restore();
    clearInterpreterOverlayAccessStateCacheForTest();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('isActivePaidSubscription returns true only for active subscriptions', () => {
    expect(isActivePaidSubscription(null)).toBe(false);
    expect(isActivePaidSubscription(undefined)).toBe(false);
    expect(isActivePaidSubscription({ status: 'canceled' })).toBe(false);
    expect(isActivePaidSubscription({ status: 'active' })).toBe(true);
  });

  test('hasInterpreterOverlayEntitlement only accepts allowed paid products', () => {
    expect(
      hasInterpreterOverlayEntitlement({
        status: 'active',
        prices: { product_id: 'prod_R6DVWtAxxJZHHW' },
      }),
    ).toBe(true);
    expect(
      hasInterpreterOverlayEntitlement({
        status: 'active',
        prices: { product_id: 'prod_not_allowed' },
      }),
    ).toBe(false);
  });

  test('hasActivePaidSubscriptionForAccessToken returns false when token is missing', async () => {
    await expect(hasActivePaidSubscriptionForAccessToken(null)).resolves.toBe(false);
  });

  test('hasActivePaidSubscriptionForAccessToken returns true when the configured backend reports an active subscription', async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([{ status: 'active', prices: { product_id: 'prod_R6DVWtAxxJZHHW' } }]),
        { status: 200 },
      ),
    ) as typeof global.fetch;

    await expect(hasActivePaidSubscriptionForAccessToken(
      'token',
      hostedSubscriptionOptions.subscriptionBackend,
    )).resolves.toBe(true);
  });

  test('hasActivePaidSubscriptionForAccessToken throws for auth failures', async () => {
    global.fetch = mock(async () => new Response('unauthorized', { status: 401 })) as typeof global.fetch;

    await expect(hasActivePaidSubscriptionForAccessToken(
      'token',
      hostedSubscriptionOptions.subscriptionBackend,
    )).rejects.toThrow(
      'Subscription lookup rejected the auth session with 401',
    );
  });

  test('a hosted subscription gate requires a signed-in token', async () => {
    const result = await getInterpreterOverlayAccessStateForAccessToken(
      null,
      hostedSubscriptionOptions,
    );
    expect(result).toEqual({ allowed: false, reason: 'signed-out' });
  });

  test('community distribution allows the local overlay without account billing', async () => {
    global.fetch = mock(async () => new Response('unexpected')) as typeof global.fetch;
    const result = await getInterpreterOverlayAccessStateForAccessToken(null);
    expect(result).toEqual({ allowed: true, reason: 'allowed' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('getInterpreterOverlayAccessState denies overlay when the token has no paid subscription', async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    ) as typeof global.fetch;

    const result = await getInterpreterOverlayAccessStateForAccessToken('token', hostedSubscriptionOptions);
    expect(result).toEqual({ allowed: false, reason: 'unpaid' });
    expect(global.fetch).toHaveBeenCalled();
  });

  test('getInterpreterOverlayAccessState treats auth failures as signed out', async () => {
    global.fetch = mock(async () => new Response('forbidden', { status: 403 })) as typeof global.fetch;

    const result = await getInterpreterOverlayAccessStateForAccessToken('token', hostedSubscriptionOptions);
    expect(result).toEqual({
      allowed: false,
      reason: 'signed-out',
      detail: 'Please sign in again to verify your plan.',
    });
    expect(global.fetch).toHaveBeenCalled();
  });

  test('getInterpreterOverlayAccessState denies overlay on transient subscription errors', async () => {
    global.fetch = mock(async () =>
      new Response('bad gateway', { status: 502 }),
    ) as typeof global.fetch;

    const result = await getInterpreterOverlayAccessStateForAccessToken('token', hostedSubscriptionOptions);
    expect(result).toEqual({
      allowed: false,
      reason: 'error',
      detail: 'Subscription lookup failed with 502',
    });
    expect(global.fetch).toHaveBeenCalled();
  });

  test('getInterpreterOverlayAccessState allows overlay when the token has a paid subscription', async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([{ status: 'active', prices: { product_id: 'prod_R6DVWtAxxJZHHW' } }]),
        { status: 200 },
      ),
    ) as typeof global.fetch;

    const result = await getInterpreterOverlayAccessStateForAccessToken('token', hostedSubscriptionOptions);
    expect(result).toEqual({ allowed: true, reason: 'allowed' });
    expect(global.fetch).toHaveBeenCalled();
  });

  test('getInterpreterOverlayAccessState caches access state briefly per token', async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([{ status: 'active', prices: { product_id: 'prod_R6DVWtAxxJZHHW' } }]),
        { status: 200 },
      ),
    ) as typeof global.fetch;

    await expect(getInterpreterOverlayAccessStateForAccessToken('token', hostedSubscriptionOptions)).resolves.toEqual({
      allowed: true,
      reason: 'allowed',
    });
    await expect(getInterpreterOverlayAccessStateForAccessToken('token', hostedSubscriptionOptions)).resolves.toEqual({
      allowed: true,
      reason: 'allowed',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
