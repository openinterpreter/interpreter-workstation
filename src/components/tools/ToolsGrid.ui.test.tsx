import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import type { ToolServer } from '../../api';
import { ToolsGrid } from './ToolsGrid';

describe('ToolsGrid', () => {
  test('renders store branding for an installed MCP when config.url matches a curated entry', async () => {
    const installedTool: ToolServer = {
      id: 'supabase',
      name: 'supabase',
      state: {
        status: 'connected',
        tools: [],
        resources: [],
        prompts: [],
      },
      config: {
        transport: 'http',
        url: 'https://mcp.supabase.com/mcp',
        enabled: true,
      },
    };

    const { container } = render(
      <ToolsGrid
        tools={[installedTool]}
        mode="edit"
        onAddFromStore={() => {}}
      />
    );

    expect(screen.getByText('Manage projects, run SQL, and inspect logs with AI')).toBeVisible();
    expect(container.querySelector('img[src*="supabase.com"]')).not.toBeNull();
  });

  test('matches an installed MCP store entry even when the runtime URL is normalized differently', async () => {
    const installedTool: ToolServer = {
      id: 'sentry',
      name: 'Sentry',
      state: {
        status: 'failed',
        error: 'OAuth login required',
        needsAuth: true,
      },
      config: {
        transport: 'http',
        url: 'https://mcp.sentry.dev',
        enabled: true,
      },
    };

    render(
      <ToolsGrid
        tools={[installedTool]}
        mode="edit"
        onAddFromStore={() => {}}
        onCompleteAuth={() => {}}
      />
    );

    expect(screen.queryByRole('button', { name: 'Add Sentry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete auth for Sentry' })).toBeVisible();
    expect(screen.getByText('Search, query, and debug errors intelligently')).toBeVisible();
  });

  test('shows explicit pending UI instead of the global toggle while auth is still required', () => {
    const pendingTool: ToolServer = {
      id: 'sentry',
      name: 'Sentry',
      state: {
        status: 'failed',
        error: 'OAuth login required',
        needsAuth: true,
      },
      config: {
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        enabled: true,
      },
    };

    render(
      <ToolsGrid
        tools={[pendingTool]}
        mode="edit"
        onAddFromStore={() => {}}
        onCompleteAuth={() => {}}
        onGlobalToggle={() => {}}
        onCancelServer={() => {}}
      />
    );

    expect(screen.getByRole('button', { name: 'Complete auth for Sentry' })).toBeVisible();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
