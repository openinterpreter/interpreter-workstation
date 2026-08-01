import { describe, expect, test } from 'bun:test';

import {
  hasInterpreterOverlayEntitlement,
  isActivePaidSubscription,
} from './usePaidPlanStatus';

describe('isActivePaidSubscription', () => {
  test('returns false when subscription is missing', () => {
    expect(isActivePaidSubscription(null)).toBe(false);
    expect(isActivePaidSubscription(undefined)).toBe(false);
  });

  test('returns false for non-active statuses', () => {
    expect(isActivePaidSubscription({ status: 'trialing' })).toBe(false);
    expect(isActivePaidSubscription({ status: 'canceled' })).toBe(false);
    expect(isActivePaidSubscription({ status: null })).toBe(false);
  });

  test('returns true for active subscriptions', () => {
    expect(isActivePaidSubscription({ status: 'active' })).toBe(true);
  });

  test('returns true for overlay-entitled subscriptions only', () => {
    expect(
      hasInterpreterOverlayEntitlement({
        status: 'active',
        prices: { product_id: 'prod_R6DVWtAxxJZHHW' },
      } as never),
    ).toBe(true);
    expect(
      hasInterpreterOverlayEntitlement({
        status: 'active',
        prices: { product_id: 'prod_not_allowed' },
      } as never),
    ).toBe(false);
    expect(
      hasInterpreterOverlayEntitlement({
        status: 'trialing',
        prices: { product_id: 'prod_R6DVWtAxxJZHHW' },
      } as never),
    ).toBe(false);
  });
});
