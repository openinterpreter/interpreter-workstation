import type { BuiltinToolDefinition } from "../../builtinTools";
import { clampLimit, formatToolError, normalizeEndpointId } from "./shared";
import { fetchMediaAiJson } from "./proxy";

interface FalPricingEntry {
  endpoint_id?: string;
  unit_price?: number;
  unit?: string;
  currency?: string;
}

interface FalPricingResponse {
  prices?: FalPricingEntry[];
  interpreter_pricing?: {
    token_price_usd?: number;
    profit_margin_percent?: number;
  };
}

function pickPriceEntry(response: FalPricingResponse): FalPricingEntry | null {
  if (!Array.isArray(response.prices) || response.prices.length === 0)
    return null;
  return response.prices[0] || null;
}

export const estimateMediaCostTool: BuiltinToolDefinition = {
  name: "estimate_media_cost",
  description: `Estimate Media AI cost before running a model.

Returns both the raw fal.ai price and the approximate charge against the user's Interpreter balance when pricing data is available.

Use this before \`run_media_model\`, then tell the user the expected cost clearly before spending it.`,
  inputSchema: {
    type: "object",
    properties: {
      endpoint_id: {
        type: "string",
        description: 'fal endpoint ID (for example: "fal-ai/flux/dev").',
      },
      num_outputs: {
        type: "number",
        description: "Number of outputs you expect to generate.",
        default: 1,
      },
    },
    required: ["endpoint_id"],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args: Record<string, unknown>) => {
    try {
      const endpointIdRaw =
        typeof args.endpoint_id === "string" ? args.endpoint_id : "";
      const endpointId = normalizeEndpointId(endpointIdRaw);
      if (!endpointId) {
        return {
          content: [{ type: "text", text: "Error: endpoint_id is required." }],
          isError: true,
        };
      }

      const numOutputs = clampLimit(args.num_outputs, 1, 1, 1000);

      const response = await fetchMediaAiJson<FalPricingResponse>(
        `/pricing?endpoint_id=${encodeURIComponent(endpointId)}`,
      );

      const price = pickPriceEntry(response);
      if (!price || typeof price.unit_price !== "number") {
        return {
          content: [
            {
              type: "text",
              text: `Pricing is not available for endpoint "${endpointId}".`,
            },
          ],
          isError: true,
        };
      }

      const total = price.unit_price * numOutputs;
      const interpreterTokenPriceUsd =
        typeof response.interpreter_pricing?.token_price_usd === "number"
          ? response.interpreter_pricing.token_price_usd
          : null;
      const interpreterProfitMarginPercent =
        typeof response.interpreter_pricing?.profit_margin_percent === "number"
          ? response.interpreter_pricing.profit_margin_percent
          : null;
      const estimatedInterpreterCredits = (
        interpreterTokenPriceUsd && interpreterTokenPriceUsd > 0
        && interpreterProfitMarginPercent !== null
      )
        ? Math.floor(
            (total / interpreterTokenPriceUsd)
              * (1 + interpreterProfitMarginPercent / 100),
          )
        : null;
      const estimatedInterpreterChargeUsd = (
        interpreterTokenPriceUsd && estimatedInterpreterCredits !== null
      )
        ? estimatedInterpreterCredits * interpreterTokenPriceUsd
        : null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                endpoint_id: endpointId,
                pricing: {
                  raw_fal_per_unit_usd: price.unit_price,
                  unit: price.unit || "unit",
                  currency: price.currency || "USD",
                  num_outputs: numOutputs,
                  raw_fal_total_usd: total,
                  estimated_interpreter_credits: estimatedInterpreterCredits,
                  estimated_interpreter_charge_usd:
                    estimatedInterpreterChargeUsd,
                  interpreter_token_price_usd: interpreterTokenPriceUsd,
                  interpreter_profit_margin_percent:
                    interpreterProfitMarginPercent,
                },
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to estimate media cost: ${formatToolError(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
};
