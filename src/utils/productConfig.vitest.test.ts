import { describe, expect, test } from 'vitest';

import {
  hasHostedAccountProvider,
  hasHostedApi,
  hasUpdateFeed,
} from '../../shared/productConfig';

describe('community product configuration', () => {
  test('does not silently enable hosted services', () => {
    expect(hasHostedAccountProvider()).toBe(false);
    expect(hasHostedApi()).toBe(false);
    expect(hasUpdateFeed()).toBe(false);
  });
});
