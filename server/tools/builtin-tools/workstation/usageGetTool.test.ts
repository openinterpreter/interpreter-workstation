import { afterEach, describe, expect, mock, test } from 'bun:test';

const getCurrentServerAccessTokenSyncMock = mock(() => 'jwt_test_123');

mock.module('../../../lib/authTokens', () => ({
  getCurrentServerAccessTokenSync: getCurrentServerAccessTokenSyncMock,
}));

mock.module('../../../utils/hostedProvider', () => ({
  HOSTED_LLM_SERVER: 'https://api.example.invalid',
}));

const { WORKSTATION_PRO_PRICE_ID } = await import('../../../../shared/constants/interpreter-plans');
const { usageGetTool } = await import('./usageGetTool');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  getCurrentServerAccessTokenSyncMock.mockReset();
  getCurrentServerAccessTokenSyncMock.mockImplementation(() => 'jwt_test_123');
});

describe('usageGetTool', () => {
  test('returns remaining balance and plan allowance', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({
        monthly_tokens: 2_500_000,
        purchased_tokens: 500_000,
        total_credits: 3_000_000,
        usd_balance: 9,
        interpreter_token_price_usd: 0.000003,
        interpreter_profit_margin_percent: 8,
        subscription: {
          price_id: WORKSTATION_PRO_PRICE_ID,
          metadata: null,
          current_period_start: '2026-04-01T00:00:00.000Z',
          current_period_end: '2026-05-01T00:00:00.000Z',
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )) as typeof fetch;

    const result = await usageGetTool.handler({});

    expect(result.isError).toBe(false);
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    const payload = JSON.parse(String(text));

    expect(payload.remaining_credits).toBe(3_000_000);
    expect(payload.remaining_monthly_credits).toBe(2_500_000);
    expect(payload.remaining_purchased_credits).toBe(500_000);
    expect(payload.remaining_balance_usd).toBe(9);
    expect(payload.interpreter_token_price_usd).toBe(0.000003);
    expect(payload.interpreter_profit_margin_percent).toBe(8);
    expect(payload.plan_monthly_credits).toBe(6_666_667);
    expect(payload.plan_monthly_price_usd).toBe(20);
    expect(payload.percent_remaining).toBeCloseTo(44.99999775, 6);
    expect(payload.current_period_start).toBe('2026-04-01T00:00:00.000Z');
    expect(payload.current_period_end).toBe('2026-05-01T00:00:00.000Z');
    expect(payload.has_active_subscription).toBe(true);
  });

  test('fails cleanly when the user is signed out', async () => {
    getCurrentServerAccessTokenSyncMock.mockImplementation(() => null);

    const result = await usageGetTool.handler({});

    expect(result.isError).toBe(true);
    expect(String(result.content?.[0]?.text)).toContain(
      'You must be signed in to view Interpreter usage.',
    );
  });
});
