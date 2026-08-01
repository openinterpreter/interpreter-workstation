import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearConfigCache, setConfigOverride } from '../../../configStore';
import { estimateMediaCostTool } from './estimateCostTool';

beforeEach(() => {
  clearConfigCache();
  setConfigOverride({
    agents: {},
    authToken: 'test-access-token',
  } as any);
});

afterEach(() => {
  setConfigOverride(null);
  clearConfigCache();
});

describe('estimateMediaCostTool', () => {
  test('returns raw fal and Interpreter-balance estimates', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      expect(url).toContain('/v0/media-ai/pricing?endpoint_id=fal-ai%2Fnano-banana-pro%2Fedit');
      return new Response(JSON.stringify({
        prices: [
          {
            endpoint_id: 'fal-ai/nano-banana-pro/edit',
            unit_price: 0.15,
            unit: 'image',
            currency: 'USD',
          },
        ],
        interpreter_pricing: {
          token_price_usd: 0.000003,
          profit_margin_percent: 8,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await estimateMediaCostTool.handler({
        endpoint_id: 'fal-ai/nano-banana-pro/edit',
        num_outputs: 2,
      });

      expect(result.isError).toBe(false);
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      const payload = JSON.parse(String(text));

      expect(payload).toEqual({
        endpoint_id: 'fal-ai/nano-banana-pro/edit',
        pricing: {
          raw_fal_per_unit_usd: 0.15,
          unit: 'image',
          currency: 'USD',
          num_outputs: 2,
          raw_fal_total_usd: 0.3,
          estimated_interpreter_credits: 108000,
          estimated_interpreter_charge_usd: 0.324,
          interpreter_token_price_usd: 0.000003,
          interpreter_profit_margin_percent: 8,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
