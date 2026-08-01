import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import type { ToolServer } from '@/api';
import { MCP_STORE_ENTRIES } from '@/components/tools/mcpStoreData';
import {
  matchesToolSearch,
  normalizeToolSearchQuery,
} from '@/lib/tool-search';

function getStripeEntry() {
  const entry = MCP_STORE_ENTRIES.find((candidate) => candidate.id === 'stripe');
  assert.ok(entry, 'expected Stripe MCP store entry to exist');
  return entry;
}

describe('tool search helpers', () => {
  test('normalizes search queries for live filtering', () => {
    assert.equal(normalizeToolSearchQuery('  Stripe   MCP  '), 'stripe mcp');
  });

  test('matches Stripe store entries by name, category, and transport', () => {
    const stripe = getStripeEntry();

    assert.equal(matchesToolSearch('stripe', { storeEntry: stripe }), true);
    assert.equal(matchesToolSearch('finance', { storeEntry: stripe }), true);
    assert.equal(matchesToolSearch('http', { storeEntry: stripe }), true);
    assert.equal(matchesToolSearch('github', { storeEntry: stripe }), false);
  });

  test('matches installed servers by nested tool metadata', () => {
    const server: ToolServer = {
      id: 'stripe-custom',
      name: 'Stripe Sandbox',
      state: {
        status: 'connected',
        tools: [
          {
            name: 'search_payments',
            description: 'Search Stripe payments by customer or invoice',
          },
        ],
      },
      config: {
        transport: 'http',
        url: 'https://mcp.stripe.com/',
      },
    };

    assert.equal(matchesToolSearch('stripe payments', { tool: server }), true);
    assert.equal(matchesToolSearch('invoice', { tool: server }), true);
    assert.equal(matchesToolSearch('github', { tool: server }), false);
  });
});
