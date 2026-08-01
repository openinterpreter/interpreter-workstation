import type { Tables } from "./supabase.types";

type DesktopUserLedgerRow = Tables<"desktop_user_ledger">;
type SubscriptionRow = Tables<"subscriptions">;

export type UsageBreakdownLedgerRow = Pick<
  DesktopUserLedgerRow,
  "id" | "created_at" | "description" | "monthly_tokens" | "purchased_tokens" | "metadata"
>;

export type UsageBreakdownLedgerRowWithOptionalDollarAmount = UsageBreakdownLedgerRow
  & Partial<Pick<DesktopUserLedgerRow, "dollar_amount">>;

export interface UsageBreakdownResponseData {
  currentPeriodStart: SubscriptionRow["current_period_start"] | null;
  currentPeriodEnd: SubscriptionRow["current_period_end"] | null;
  rows: UsageBreakdownLedgerRow[];
}

export interface UsageBreakdownResponse {
  data?: UsageBreakdownResponseData;
  error?: string;
}

export interface ModelUsageBreakdownSummary {
  model: string;
  requests: number;
  chargedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
  percentage: number;
}

export interface UsageBreakdownSummaryResponseData {
  currentPeriodStart: SubscriptionRow["current_period_start"] | null;
  currentPeriodEnd: SubscriptionRow["current_period_end"] | null;
  totalRequests: number;
  totalChargedTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalUsageTokens: number;
  totalUsd: number;
  byModel: ModelUsageBreakdownSummary[];
}

export interface UsageBreakdownSummaryResponse {
  data?: UsageBreakdownSummaryResponseData;
  error?: string;
}
