import { describe, expect, test } from "bun:test";
import {
  buildUsageInsights,
  type PricingLedgerRow,
} from "./planUsageInsights";

function makeRow(
  id: number,
  overrides: Partial<PricingLedgerRow> = {},
): PricingLedgerRow {
  return {
    id,
    created_at: "2026-03-31T10:00:00.000Z",
    description: "test",
    dollar_amount: 0.01,
    monthly_tokens: 1000,
    purchased_tokens: 0,
    metadata: {
      feature: "interpreter_overlay",
      billing_model: "gpt-5.4-mini",
      charged_interpreter_tokens: 1000,
      usage: {
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
      },
    },
    ...overrides,
  };
}

describe("buildUsageInsights", () => {
  test("aggregates per-model requests and charged token percentages", () => {
    const insights = buildUsageInsights([
      makeRow(1),
      makeRow(2, {
        metadata: {
          feature: "interpreter_overlay",
          billing_model: "gpt-5.4-mini",
          charged_interpreter_tokens: 500,
          usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
        },
      }),
      makeRow(3, {
        metadata: {
          feature: "interpreter_overlay",
          billing_model: "gpt-5.4-nano",
          charged_interpreter_tokens: 250,
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        },
      }),
    ]);

    expect(insights.totalRequests).toBe(3);
    expect(insights.totalChargedTokens).toBe(1750);
    expect(insights.byModel).toEqual([
      expect.objectContaining({
        model: "gpt-5.4-mini",
        requests: 2,
        chargedTokens: 1500,
      }),
      expect.objectContaining({
        model: "gpt-5.4-nano",
        requests: 1,
        chargedTokens: 250,
      }),
    ]);
    expect(insights.byModel[0]?.percentage).toBeCloseTo((1500 / 1750) * 100, 5);
  });

  test("uses row token deltas when charged token metadata is missing", () => {
    const insights = buildUsageInsights([
      makeRow(1, {
        monthly_tokens: 640,
        purchased_tokens: 360,
        metadata: {
          feature: "interpreter_overlay",
          billing_model: "gpt-5.4",
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        },
      }),
    ]);

    expect(insights.totalChargedTokens).toBe(1000);
    expect(insights.byModel[0]?.chargedTokens).toBe(1000);
  });

  test("aggregates desktop chat rows when feature metadata is missing", () => {
    const insights = buildUsageInsights([
      makeRow(1, {
        metadata: {
          model: "openai/gpt-5.3-codex",
          messages: [],
        },
      }),
      makeRow(2, {
        monthly_tokens: 750,
        metadata: {
          model: "openai/gpt-5.3-codex",
          provider: "openrouter",
        },
      }),
      makeRow(3, {
        metadata: {
          feature: "other_feature",
          billing_model: "gpt-5.4",
          charged_interpreter_tokens: 900,
        },
      }),
    ]);

    expect(insights.totalRequests).toBe(3);
    expect(insights.byModel).toEqual([
      expect.objectContaining({
        model: "openai/gpt-5.3-codex",
        chargedTokens: 1750,
        requests: 2,
      }),
      expect.objectContaining({ model: "gpt-5.4", chargedTokens: 900 }),
    ]);
  });

  test("falls back to provider when billing_model is missing", () => {
    const insights = buildUsageInsights([
      makeRow(1, {
        metadata: {
          feature: "interpreter_overlay",
          provider: "assemblyai",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
      }),
    ]);

    expect(insights.byModel[0]?.model).toBe("assemblyai");
  });

  test("falls back to tool_name when a row has no model metadata", () => {
    const insights = buildUsageInsights([
      makeRow(1, {
        monthly_tokens: 0,
        purchased_tokens: 28800,
        metadata: {
          type: "langtools",
          tool_name: "create_image",
          cost_estimate: 0.08,
        },
      }),
    ]);

    expect(insights.totalRequests).toBe(1);
    expect(insights.byModel[0]).toEqual(
      expect.objectContaining({
        model: "create_image",
        chargedTokens: 28800,
      }),
    );
  });
});
