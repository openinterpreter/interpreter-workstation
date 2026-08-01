#!/usr/bin/env tsx
/**
 * Manual integration test for MCP Manager
 * Tests the full lifecycle: add server -> start -> call tool -> stop -> remove
 * Run with: pnpm exec tsx apps/server/src/mcp/__tests__/manual-manager-test.ts
 */

import path from 'node:path';
import { ToolManager } from '../toolManager';
import { setCurrentWorkspace } from '../../utils/workspace';
import { setConfigOverride, clearConfigCache, type AppConfig } from '../../configStore';

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error: any) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
    if (error.stack) {
      console.error(`  Stack: ${error.stack}`);
    }
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
  console.log('Running MCP Manager Integration Tests...\n');

  // Setup
  // Find the root of the project (go up from apps/server/src/mcp/__tests__ to root)
  const projectRoot = path.resolve(process.cwd(), '../..');
  const workspacePath = path.join(projectRoot, 'test-workspace');
  setCurrentWorkspace(workspacePath);

  const emptyConfig: AppConfig = {
    agents: {},
    mcpServers: {},
  };
  setConfigOverride(emptyConfig);

  const manager = new ToolManager();

  // Find the test MCP server (use absolute path)
  const testServerPath = path.join(workspacePath, 'test-mcp-server.ts');
  console.log('Using test server at:', testServerPath);

  let testServerId: string;

  await test('should initialize empty manager', async () => {
    await manager.initialize();
    const statuses = await manager.listServerStatuses();
    await assertTrue(statuses.length === 0, 'Should have no servers');
  });

  await test('should add a new MCP server', async () => {
    const tsxPath = path.join(projectRoot, 'node_modules', '.bin', 'tsx');
    console.log(`  Using tsx at: ${tsxPath}`);
    testServerId = await manager.addServer({
      name: 'Test Server',
      description: 'Test MCP server for integration tests',
      transport: 'stdio',
      command: tsxPath,
      args: [testServerPath],
      enabled: true,
    });

    await assertTrue(!!testServerId, 'Should return server ID');
    console.log(`  Created server with ID: ${testServerId}`);
  });

  await test('should list server in statuses', async () => {
    const statuses = await manager.listServerStatuses();
    await assertTrue(statuses.length === 1, 'Should have 1 server');
    await assertEquals(statuses[0].name, 'Test Server', 'Server name should match');
  });

  await test('should connect to server and list tools', async () => {
    // Give it a moment to connect
    await new Promise(resolve => setTimeout(resolve, 1000));

    const status = await manager.getServerStatus(testServerId);
    console.log(`  Connection status: ${status.state.status}`);

    if (status.state.status === 'connected') {
      console.log(`  Tools available: ${status.state.tools.length}`);
      console.log(`  Tool names:`, status.state.tools.map((t: any) => t.name).join(', '));
      await assertTrue(status.state.tools.length > 0, 'Should have tools');
    } else if (status.state.status === 'failed') {
      throw new Error(`Connection failed: ${status.state.error}`);
    } else {
      throw new Error(`Unexpected status: ${status.state.status}`);
    }
  });

  await test('should call a tool', async () => {
    const client = manager.getClient(testServerId);
    await assertTrue(!!client, 'Client should exist');

    const result = await client!.callTool({
      name: 'add',
      arguments: { a: 5, b: 3 },
    });

    console.log(`  Tool result:`, JSON.stringify(result, null, 2));
    await assertTrue(!result.isError, 'Should not be an error');
    await assertTrue(result.content.length > 0, 'Should have content');

    // Parse the result
    const text = result.content[0].text;
    const parsed = JSON.parse(text!);
    await assertEquals(parsed.result, 8, 'Result should be 8');
  });

  await test('should call echo tool', async () => {
    const client = manager.getClient(testServerId);
    const result = await client!.callTool({
      name: 'echo',
      arguments: { message: 'Hello MCP!' },
    });

    await assertTrue(!result.isError, 'Should not be an error');
    await assertEquals(result.content[0].text, 'Hello MCP!', 'Echo should return message');
  });

  await test('should stop server', async () => {
    await manager.stopServer(testServerId);
    const status = await manager.getServerStatus(testServerId);
    await assertEquals(status.state.status, 'disconnected', 'Should be disconnected');
  });

  await test('should restart server', async () => {
    await manager.startServer(testServerId);
    // Give it a moment to reconnect
    await new Promise(resolve => setTimeout(resolve, 1000));

    const status = await manager.getServerStatus(testServerId);
    await assertEquals(status.state.status, 'connected', 'Should be connected again');
  });

  await test('should remove server', async () => {
    await manager.removeServer(testServerId);
    const statuses = await manager.listServerStatuses();
    await assertTrue(statuses.length === 0, 'Should have no servers');
  });

  await test('should shutdown manager', async () => {
    await manager.shutdown();
  });

  // Cleanup
  clearConfigCache();

  console.log('\n✓ All integration tests passed!');
}

runTests().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
