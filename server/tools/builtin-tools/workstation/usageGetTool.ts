import type { BuiltinToolDefinition } from '../../builtinTools';
import { getCurrentServerAccessTokenSync } from '../../../lib/authTokens';
import { HOSTED_LLM_SERVER } from '../../../utils/hostedProvider';
import { calculatePercentRemaining } from '../../../../src/utils/modelCostSignals';
import {
  INTERPRETER_STARTER_CREDITS,
  getSubscriptionMonthlyCredits,
  getSubscriptionMonthlyPriceUsd,
} from '../../../../shared/constants/interpreter-plans';

const ACCOUNT_USAGE_URL = `${HOSTED_LLM_SERVER}/v0/account/usage`;

interface UsageSubscription {
  price_id: string | null;
  metadata: Record<string, unknown> | null;
  current_period_start: string | null;
  current_period_end: string | null;
}

interface HostedUsageResponse {
  monthly_tokens: number;
  purchased_tokens: number;
  total_credits: number;
  usd_balance: number;
  interpreter_token_price_usd: number;
  interpreter_profit_margin_percent: number;
  subscription: UsageSubscription | null;
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatUsageError(payload: unknown, response: Response): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const detail = record.detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail.trim();
    }
    const error = record.error;
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const errorRecord = error as Record<string, unknown>;
      const nestedDetail = errorRecord.detail;
      if (typeof nestedDetail === 'string' && nestedDetail.trim()) {
        return nestedDetail.trim();
      }
    }
  }

  return `${response.status} ${response.statusText}`.trim();
}

async function fetchHostedUsage(): Promise<HostedUsageResponse> {
  const accessToken = getCurrentServerAccessTokenSync();
  if (!accessToken) {
    throw new Error('You must be signed in to view Interpreter usage.');
  }

  const response = await fetch(ACCOUNT_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await parseResponsePayload(response);
  if (!response.ok) {
    throw new Error(formatUsageError(payload, response));
  }
  return payload as HostedUsageResponse;
}

export const usageGetTool: BuiltinToolDefinition = {
  name: 'interpreter_usage_get',
  description:
    'Get the user\'s remaining Interpreter credits, approximate dollar-equivalent balance, current plan allowance, and percent remaining. Use this with `estimate_media_cost` when a task may spend Media AI credits.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async () => {
    try {
      const usage = await fetchHostedUsage();
      const totalCredits = Math.max(
        0,
        usage.monthly_tokens + usage.purchased_tokens,
      );
      const subscription = usage.subscription;
      const planMonthlyCredits = getSubscriptionMonthlyCredits(subscription)
        ?? INTERPRETER_STARTER_CREDITS;
      const planMonthlyPriceUsd = getSubscriptionMonthlyPriceUsd(subscription);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                remaining_credits: totalCredits,
                remaining_monthly_credits: Math.max(0, usage.monthly_tokens),
                remaining_purchased_credits: Math.max(0, usage.purchased_tokens),
                remaining_balance_usd: usage.usd_balance,
                interpreter_token_price_usd: usage.interpreter_token_price_usd,
                interpreter_profit_margin_percent:
                  usage.interpreter_profit_margin_percent,
                plan_monthly_credits: planMonthlyCredits,
                plan_monthly_price_usd: planMonthlyPriceUsd,
                percent_remaining: calculatePercentRemaining(
                  totalCredits,
                  planMonthlyCredits,
                ),
                current_period_start: subscription?.current_period_start ?? null,
                current_period_end: subscription?.current_period_end ?? null,
                has_active_subscription: Boolean(subscription),
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Failed to get Interpreter usage: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
