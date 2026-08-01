#!/usr/bin/env tsx
/**
 * Manual test for MCP config store functions
 * Run with: tsx apps/server/src/mcp/__tests__/manual-config-test.ts
 */

import {
  addMcpServer,
  removeMcpServer,
  updateMcpServer,
  getMcpServer,
  listMcpServers,
  setConfigOverride,
  clearConfigCache,
  type AppConfig,
} from '../../configStore';
import type { McpServerConfig } from '../mcpTypes';

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error: any) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
    process.exit(1);
  }
}

async function assertEquals(actual: any, expected: any, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`);
  }
}

async function assertTrue(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runTests() {
  console.log('Running MCP Config Store Tests...\n');

  // Setup: Use override for testing
  const emptyConfig: AppConfig = {
    agents: {},
    mcpServers: {},
  };
  setConfigOverride(emptyConfig);

  await test('should add a new MCP server', async () => {
    const server: McpServerConfig = {
      id: 'test-server-1',
      name: 'Test Server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      enabled: true,
      createdAt: Date.now(),
    };

    await addMcpServer(server);
    const retrieved = await getMcpServer('test-server-1');
    await assertEquals(retrieved, server, 'Server should match');
  });

  await test('should list all MCP servers', async () => {
    const servers = await listMcpServers();
    await assertTrue(servers.length >= 1, 'Should have at least 1 server');
  });

  await test('should add another server', async () => {
    const server2: McpServerConfig = {
      id: 'test-server-2',
      name: 'HTTP Server',
      transport: 'http',
      url: 'http://localhost:3000',
      enabled: true,
      createdAt: Date.now(),
    };

    await addMcpServer(server2);
    const servers = await listMcpServers();
    await assertTrue(servers.length === 2, 'Should have 2 servers');
  });

  await test('should update an existing MCP server', async () => {
    await updateMcpServer('test-server-1', { name: 'Updated Name' });
    const updated = await getMcpServer('test-server-1');
    await assertEquals(updated?.name, 'Updated Name', 'Name should be updated');
    await assertEquals(updated?.command, 'node', 'Command should be unchanged');
  });

  await test('should remove an MCP server', async () => {
    await removeMcpServer('test-server-1');
    const retrieved = await getMcpServer('test-server-1');
    await assertEquals(retrieved, undefined, 'Server should be removed');

    const servers = await listMcpServers();
    await assertTrue(servers.length === 1, 'Should have 1 server left');
  });

  await test('should throw error when updating non-existent server', async () => {
    try {
      await updateMcpServer('non-existent', { name: 'New Name' });
      throw new Error('Should have thrown an error');
    } catch (error: any) {
      await assertTrue(
        error.message.includes('not found'),
        'Error should mention "not found"'
      );
    }
  });

  // Cleanup
  clearConfigCache();

  console.log('\n✓ All tests passed!');
}

runTests().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
