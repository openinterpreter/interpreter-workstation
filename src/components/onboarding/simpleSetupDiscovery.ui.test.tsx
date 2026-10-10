import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list, importedSetup, discover } = vi.hoisted(() => ({
  list: vi.fn(),
  importedSetup: vi.fn(),
  discover: vi.fn(),
}));

vi.mock('../../ipc', () => ({
  servers: { list },
  mcpDiscovery: { importedSetup, discover },
}));

import { discoverSimpleMcps, shouldShowSimpleMcpStep } from './simpleSetupDiscovery';

describe('Simple MCP onboarding visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue({ servers: [] });
    importedSetup.mockResolvedValue({ candidates: [], discovered: [] });
  });

  it('omits the entire step when no MCPs are detected or configured', async () => {
    const summary = await discoverSimpleMcps();
    expect(shouldShowSimpleMcpStep(summary)).toBe(false);
    expect(summary).toEqual({ configured: [], discovered: [] });
  });

  it('ignores built-in tool servers in the shared listing on a zero-MCP machine', async () => {
    list.mockResolvedValue({ servers: [
      { id: 'builtin-interpreter', name: 'Interpreter' },
      { id: 'builtin-browser', name: 'Browser', globallyDisabled: true },
      { name: 'Incomplete entry' },
    ] });
    const summary = await discoverSimpleMcps();
    expect(summary).toEqual({ configured: [], discovered: [] });
    expect(shouldShowSimpleMcpStep(summary)).toBe(false);
  });

  it('shows already-configured MCPs without disclosing server credentials', async () => {
    list.mockResolvedValue({ servers: [
      { id: 'builtin-interpreter', name: 'Interpreter' },
      { id: 'calendar', name: 'Calendar', secret: 'never-render-this' },
    ] });
    const summary = await discoverSimpleMcps();
    expect(summary).toEqual({ configured: ['Calendar'], discovered: [] });
    expect(shouldShowSimpleMcpStep(summary)).toBe(true);
  });

  it('shows detected MCPs without exposing their commands or environment', async () => {
    importedSetup.mockResolvedValue({ candidates: [{ name: 'Notes', env: { TOKEN: 'never-render-this' } }] });
    const summary = await discoverSimpleMcps();
    expect(summary).toEqual({ configured: [], discovered: ['Notes'] });
    expect(shouldShowSimpleMcpStep(summary)).toBe(true);
  });

  it('fails closed on discovery errors, rather than guessing that tools exist', async () => {
    importedSetup.mockRejectedValue(new Error('unavailable'));
    await expect(discoverSimpleMcps()).rejects.toThrow('unavailable');
    expect(shouldShowSimpleMcpStep(null)).toBe(false);
  });
});
