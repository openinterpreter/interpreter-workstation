import type { UsageBreakdownLedgerRowWithOptionalDollarAmount } from "../../shared/types/usageBreakdown";

export type PricingLedgerRow = UsageBreakdownLedgerRowWithOptionalDollarAmount;

export interface ModelUsageInsight {
  model: string;
  requests: number;
  chargedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
  percentage: number;
}

export interface UsageInsights {
  totalRequests: number;
  totalChargedTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalUsageTokens: number;
  totalUsd: number;
  byModel: ModelUsageInsight[];
}

interface BillingMetadataUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface BillingMetadata {
  feature?: string;
  billing_model?: string;
  model?: string;
  provider?: string;
  requested_model?: string;
  tool_name?: string;
  usage?: BillingMetadataUsage;
  charged_interpreter_tokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

function parseBillingMetadata(value: PricingLedgerRow["metadata"]): BillingMetadata | null {
  if (!isRecord(value)) return null;

  const usageValue = value.usage;
  const usage = isRecord(usageValue)
    ? {
        prompt_tokens: toNonNegativeNumber(usageValue.prompt_tokens),
        completion_tokens: toNonNegativeNumber(usageValue.completion_tokens),
        total_tokens: toNonNegativeNumber(usageValue.total_tokens),
      }
    : undefined;

  return {
    feature: typeof value.feature === "string" ? value.feature : undefined,
    billing_model: typeof value.billing_model === "string" ? value.billing_model : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    provider: typeof value.provider === "string" ? value.provider : undefined,
    requested_model: typeof value.requested_model === "string" ? value.requested_model : undefined,
    tool_name: typeof value.tool_name === "string" ? value.tool_name : undefined,
    usage,
    charged_interpreter_tokens: toNonNegativeNumber(value.charged_interpreter_tokens),
  };
}

function getUsageLabel(metadata: BillingMetadata): string | null {
  const label = metadata.billing_model?.trim()
    || metadata.requested_model?.trim()
    || metadata.model?.trim()
    || metadata.tool_name?.trim()
    || metadata.provider?.trim();

  return label || null;
}

function getChargedTokens(row: PricingLedgerRow, metadata: BillingMetadata): number {
  const metadataChargedTokens = toNonNegativeNumber(metadata.charged_interpreter_tokens);
  if (metadataChargedTokens > 0) {
    return metadataChargedTokens;
  }

  return toNonNegativeNumber(row.monthly_tokens) + toNonNegativeNumber(row.purchased_tokens);
}

function getUsageTotals(usage: BillingMetadataUsage | undefined): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const promptTokens = toNonNegativeNumber(usage?.prompt_tokens);
  const completionTokens = toNonNegativeNumber(usage?.completion_tokens);
  const totalTokens = toNonNegativeNumber(usage?.total_tokens) || promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

export function buildUsageInsights(rows: PricingLedgerRow[]): UsageInsights {
  const byModel = new Map<string, ModelUsageInsight>();

  let totalRequests = 0;
  let totalChargedTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUsageTokens = 0;
  let totalUsd = 0;

  for (const row of rows) {
    const metadata = parseBillingMetadata(row.metadata);
    if (!metadata) continue;

    const model = getUsageLabel(metadata);
    if (!model) continue;
    const chargedTokens = getChargedTokens(row, metadata);
    const usageTotals = getUsageTotals(metadata.usage);
    const usd = toNonNegativeNumber(row.dollar_amount);

    totalRequests += 1;
    totalChargedTokens += chargedTokens;
    totalPromptTokens += usageTotals.promptTokens;
    totalCompletionTokens += usageTotals.completionTokens;
    totalUsageTokens += usageTotals.totalTokens;
    totalUsd += usd;

    const existing = byModel.get(model);
    if (existing) {
      existing.requests += 1;
      existing.chargedTokens += chargedTokens;
      existing.promptTokens += usageTotals.promptTokens;
      existing.completionTokens += usageTotals.completionTokens;
      existing.totalTokens += usageTotals.totalTokens;
      existing.usd += usd;
    } else {
      byModel.set(model, {
        model,
        requests: 1,
        chargedTokens,
        promptTokens: usageTotals.promptTokens,
        completionTokens: usageTotals.completionTokens,
        totalTokens: usageTotals.totalTokens,
        usd,
        percentage: 0,
      });
    }
  }

  const byModelSorted = Array.from(byModel.values())
    .sort((left, right) => {
      if (right.chargedTokens !== left.chargedTokens) {
        return right.chargedTokens - left.chargedTokens;
      }
      return right.requests - left.requests;
    })
    .map((entry) => ({
      ...entry,
      percentage: totalChargedTokens > 0 ? (entry.chargedTokens / totalChargedTokens) * 100 : 0,
    }));

  return {
    totalRequests,
    totalChargedTokens,
    totalPromptTokens,
    totalCompletionTokens,
    totalUsageTokens,
    totalUsd,
    byModel: byModelSorted,
  };
}
