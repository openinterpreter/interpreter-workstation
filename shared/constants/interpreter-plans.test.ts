import { describe, expect, test } from 'bun:test';

import {
  INTERPRETER_STARTER_CREDITS,
  WORKSTATION_BUSINESS_DELTA_CREDITS,
  WORKSTATION_BUSINESS_MONTHLY_CREDITS,
  WORKSTATION_BUSINESS_PRICE_ID,
  WORKSTATION_BUSINESS_USAGE_MULTIPLIER,
  WORKSTATION_PRO_MONTHLY_CREDITS,
  WORKSTATION_PRO_PRICE_ID,
  dollarsToInterpreterCredits,
  getSubscriptionMonthlyCredits,
  getSubscriptionMonthlyPriceUsd,
  getSubscriptionPriceId,
  getWorkstationPlanByPriceId,
} from './interpreter-plans';

describe('interpreter plan constants', () => {
  test('converts plan dollars into the expected monthly credits', () => {
    expect(WORKSTATION_PRO_MONTHLY_CREDITS).toBe(6_666_667);
    expect(WORKSTATION_BUSINESS_MONTHLY_CREDITS).toBe(20_000_000);
    expect(WORKSTATION_BUSINESS_DELTA_CREDITS).toBe(13_333_333);
    expect(INTERPRETER_STARTER_CREDITS).toBe(1_666_667);
    expect(WORKSTATION_BUSINESS_USAGE_MULTIPLIER).toBe(3);
  });

  test('resolves known workstation plans by price id', () => {
    expect(getWorkstationPlanByPriceId(WORKSTATION_PRO_PRICE_ID)?.id).toBe('pro');
    expect(getWorkstationPlanByPriceId(WORKSTATION_BUSINESS_PRICE_ID)?.id).toBe('business');
    expect(getWorkstationPlanByPriceId('price_unknown')).toBeNull();
  });

  test('prefers canonical price ids when present', () => {
    const subscription = {
      price_id: WORKSTATION_BUSINESS_PRICE_ID,
      metadata: {
        price_info: {
          id: WORKSTATION_PRO_PRICE_ID,
          unit_amount: 2_000,
        },
      },
    };

    expect(getSubscriptionPriceId(subscription)).toBe(WORKSTATION_BUSINESS_PRICE_ID);
    expect(getSubscriptionMonthlyPriceUsd(subscription)).toBe(60);
    expect(getSubscriptionMonthlyCredits(subscription)).toBe(20_000_000);
  });

  test('uses metadata price info for unknown plans', () => {
    const subscription = {
      price_id: 'price_custom_enterprise',
      metadata: {
        price_info: {
          id: 'price_custom_enterprise',
          unit_amount: 12_345,
        },
      },
    };

    expect(getSubscriptionMonthlyPriceUsd(subscription)).toBe(123.45);
    expect(getSubscriptionMonthlyCredits(subscription)).toBe(
      dollarsToInterpreterCredits(123.45),
    );
  });
});
