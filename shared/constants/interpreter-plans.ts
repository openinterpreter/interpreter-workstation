export const INTERPRETER_TOKEN_PRICE_USD = 0.000003;
export const INTERPRETER_STARTER_CREDITS = 1_666_667;

export const WORKSTATION_PRO_PRICE_ID = 'price_1RlbGLJzsyMetvgcJrgxB9hX';
export const WORKSTATION_BUSINESS_PRICE_ID = 'price_1RlbH4JzsyMetvgc2HtmmDOa';

export interface WorkstationPlan {
  id: 'pro' | 'business';
  name: string;
  priceId: string;
  monthlyPriceUsd: number;
  monthlyCredits: number;
}

export interface SubscriptionPriceInfo {
  id?: string | null;
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
}

export interface SubscriptionLike {
  price_id: string | null;
  metadata: Record<string, unknown> | null;
}

export function dollarsToInterpreterCredits(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return 0;
  }

  return Math.ceil(dollars / INTERPRETER_TOKEN_PRICE_USD);
}

export const WORKSTATION_PRO_MONTHLY_PRICE_USD = 20;
export const WORKSTATION_BUSINESS_MONTHLY_PRICE_USD = 60;

export const WORKSTATION_PRO_MONTHLY_CREDITS = dollarsToInterpreterCredits(
  WORKSTATION_PRO_MONTHLY_PRICE_USD,
);
export const WORKSTATION_BUSINESS_MONTHLY_CREDITS = dollarsToInterpreterCredits(
  WORKSTATION_BUSINESS_MONTHLY_PRICE_USD,
);
export const WORKSTATION_BUSINESS_DELTA_CREDITS =
  WORKSTATION_BUSINESS_MONTHLY_CREDITS - WORKSTATION_PRO_MONTHLY_CREDITS;
export const WORKSTATION_BUSINESS_USAGE_MULTIPLIER =
  WORKSTATION_BUSINESS_MONTHLY_PRICE_USD / WORKSTATION_PRO_MONTHLY_PRICE_USD;

const WORKSTATION_PLANS: readonly WorkstationPlan[] = [
  {
    id: 'pro',
    name: 'Workstation Pro',
    priceId: WORKSTATION_PRO_PRICE_ID,
    monthlyPriceUsd: WORKSTATION_PRO_MONTHLY_PRICE_USD,
    monthlyCredits: WORKSTATION_PRO_MONTHLY_CREDITS,
  },
  {
    id: 'business',
    name: 'Workstation Business',
    priceId: WORKSTATION_BUSINESS_PRICE_ID,
    monthlyPriceUsd: WORKSTATION_BUSINESS_MONTHLY_PRICE_USD,
    monthlyCredits: WORKSTATION_BUSINESS_MONTHLY_CREDITS,
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSubscriptionPriceInfo(
  subscription: SubscriptionLike | null | undefined,
): SubscriptionPriceInfo | null {
  if (!isRecord(subscription?.metadata)) {
    return null;
  }

  const priceInfo = subscription.metadata.price_info;
  return isRecord(priceInfo) ? priceInfo as SubscriptionPriceInfo : null;
}

export function getWorkstationPlanByPriceId(
  priceId: string | null | undefined,
): WorkstationPlan | null {
  if (!priceId) {
    return null;
  }

  const normalizedPriceId = priceId.toLowerCase();
  return WORKSTATION_PLANS.find((plan) => plan.priceId.toLowerCase() === normalizedPriceId) ?? null;
}

export function getSubscriptionPriceId(
  subscription: SubscriptionLike | null | undefined,
): string | null {
  if (subscription?.price_id) {
    return subscription.price_id;
  }

  const priceInfo = getSubscriptionPriceInfo(subscription);
  return typeof priceInfo?.id === 'string' && priceInfo.id.trim()
    ? priceInfo.id
    : null;
}

export function getSubscriptionMonthlyPriceUsd(
  subscription: SubscriptionLike | null | undefined,
): number | null {
  const plan = getWorkstationPlanByPriceId(getSubscriptionPriceId(subscription));
  if (plan) {
    return plan.monthlyPriceUsd;
  }

  const priceInfo = getSubscriptionPriceInfo(subscription);
  if (typeof priceInfo?.unit_amount === 'number' && Number.isFinite(priceInfo.unit_amount)) {
    return Math.max(priceInfo.unit_amount, 0) / 100;
  }

  if (typeof priceInfo?.unit_amount_decimal === 'string' && priceInfo.unit_amount_decimal.trim()) {
    const parsed = Number(priceInfo.unit_amount_decimal);
    if (Number.isFinite(parsed)) {
      return Math.max(parsed, 0) / 100;
    }
  }

  return null;
}

export function getSubscriptionMonthlyCredits(
  subscription: SubscriptionLike | null | undefined,
): number | null {
  const plan = getWorkstationPlanByPriceId(getSubscriptionPriceId(subscription));
  if (plan) {
    return plan.monthlyCredits;
  }

  const monthlyPriceUsd = getSubscriptionMonthlyPriceUsd(subscription);
  return monthlyPriceUsd === null ? null : dollarsToInterpreterCredits(monthlyPriceUsd);
}
