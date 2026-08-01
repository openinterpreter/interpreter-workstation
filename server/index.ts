// IMPORTANT: Import logger first to override console methods
import "./logger";

// Load environment variables from .env file
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "node:http";
import path from "node:path";
import getPort from "get-port";
import { ToolManager } from "./tools/toolManager";
import * as configStore from "./configStore";
import fs from 'node:fs';
import os from 'node:os';
import agentRouter from "./routes/agent";
import mcpRouter from "./routes/mcp";
import interpreterCliRouter from "./routes/interpreterCli";
import { initializeSandbox, cleanupSandbox } from "./utils/sandboxManager";
import { messageQueueStore } from "./utils/messageQueueStore";
import { cleanupAllACPProviders } from "./utils/acpProvider";
import { approvalManager } from "./approvalManager";
import { initializeWhatsAppBridge } from "./services/whatsappBridge";
import { PRELAUNCH_SECURITY_DISABLE_HTTP_TOOL_EXECUTION } from "./securityFlags";
import { setServerPort } from "./utils/serverPort";
import { startInterpreterCliSocketServer } from "./utils/interpreterCliSocketServer";

// Port is resolved dynamically at startup (see bottom of file).
let SERVER_PORT = 5177;

const app = express();

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

app.use(express.json());

// ============================================================================
// FEATURE FLAGS
// ============================================================================

/**
 * Enable direct HTTP endpoints for tool servers at /api/servers/*
 * When disabled, tool server access is only available via:
 * - IPC abstraction: /api/ipc/servers/* (for frontend)
 * - MCP server: /mcp (for external MCP clients)
 */
const ENABLE_DIRECT_TOOL_SERVER_HTTP = false;

/**
 * External MCP HTTP endpoint at /mcp.
 * In Electron runtime we keep this enabled for local app-server integration.
 * In sidecar/server-only runtime it remains gated by hardening.
 */
const ENABLE_EXTERNAL_MCP_HTTP = process.versions.electron
  ? true
  : !PRELAUNCH_SECURITY_DISABLE_HTTP_TOOL_EXECUTION;

// ============================================================================

// Server info endpoint
app.get("/api/server/info", (_req, res) => {
  res.json({ port: SERVER_PORT, wsUrl: `ws://localhost:${SERVER_PORT}` });
});

// SSE clients for browser dev mode
const sseClients: Set<http.ServerResponse> = new Set();

// SSE endpoint for browser dev mode (2-way communication)
app.get("/api/events", (req, res) => {
  console.log('[SSE] Client connected');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send keepalive every 30 seconds
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  sseClients.add(res);

  req.on('close', () => {
    console.log('[SSE] Client disconnected');
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

// Helper to broadcast SSE events to all connected clients
export function broadcastSSE(channel: string, data: any) {
  const message = JSON.stringify({ channel, data });
  sseClients.forEach(client => {
    client.write(`data: ${message}\n\n`);
  });
}

const server = http.createServer(app);

// Settings endpoint
app.get("/api/settings", async (_req, res) => {
  try {
    const config = await configStore.loadConfigWithModelState();
    res.json(config);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to load config" });
  }
});

app.get("/api/settings/custom-instructions", async (_req, res) => {
  try {
    const customInstructions = await configStore.getCustomInstructions();
    const onboardingCustomInstructionsDraft = await configStore.getOnboardingCustomInstructionsDraft();
    res.json({
      customInstructions: customInstructions ?? '',
      onboardingCustomInstructionsDraft,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to load custom instructions" });
  }
});

app.post("/api/settings/custom-instructions", async (req, res) => {
  try {
    const { customInstructions } = req.body;
    if (typeof customInstructions !== 'string') {
      return res.status(400).json({ error: "customInstructions must be a string" });
    }

    const saved = await configStore.setCustomInstructions(customInstructions);
    res.json({ success: true, customInstructions: saved ?? '' });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to set custom instructions" });
  }
});

// Reset settings to default
app.post("/api/settings/reset", async (_req, res) => {
  try {
    await configStore.resetConfig();
    await toolManager.shutdown();
    await toolManager.initialize();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to reset config" });
  }
});

// AGENT ROUTES
app.use("/api/agent", agentRouter);
app.use("/api/interpreter-cli", interpreterCliRouter);

// Initialize WhatsApp bridge listeners once at server startup.
initializeWhatsAppBridge();

// External MCP SERVER ENDPOINT (Streamable HTTP), optional via env flag.
if (ENABLE_EXTERNAL_MCP_HTTP) {
  app.use("/mcp", mcpRouter);
} else {
  console.log('[Server] External MCP HTTP endpoint disabled by pre-launch security hardening');
}

// MESSAGE QUEUE ROUTES

// Add message to queue
app.post("/api/agent/queue", (req, res) => {
  const { agentId, message } = req.body;

  if (!agentId || !message) {
    return res.status(400).json({ error: 'agentId and message required' });
  }

  const queued = messageQueueStore.add(agentId, message);

  const queue = messageQueueStore.peek(agentId);
  res.json({
    success: true,
    queued,
    queueLength: queue ? queue.length : 0,
  });
});

// Get queue status (for UI display)
app.get("/api/agent/queue/:agentId", (req, res) => {
  const { agentId } = req.params;
  const queue = messageQueueStore.peek(agentId);

  res.json({
    agentId,
    messages: queue,
    count: queue ? queue.length : 0,
  });
});

// Clear queue (user cancelled)
app.delete("/api/agent/queue/:agentId", (req, res) => {
  const { agentId } = req.params;
  messageQueueStore.clear(agentId);

  res.json({ success: true });
});

// TOOL SERVER ROUTES
// These direct HTTP endpoints are disabled by default.
// Use the IPC abstraction (/api/ipc/servers/*) or MCP server (/mcp) instead.

// Initialize Tool Manager
const toolManager = new ToolManager();

if (ENABLE_DIRECT_TOOL_SERVER_HTTP) {
  // List all tool servers
  app.get('/api/servers', async (_req, res) => {
    try {
      const statuses = await toolManager.listAllToolServers();
      res.json({ servers: statuses });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add new tool server
  app.post('/api/servers', async (req, res) => {
    try {
      const serverId = await toolManager.addServer(req.body);
      res.json({ serverId });
    } catch (error: any) {
      console.error('[API] Error adding server:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get specific tool server
  app.get('/api/servers/:serverId', async (req, res) => {
    try {
      const status = await toolManager.getToolServer(req.params.serverId);
      if (!status) {
        return res.status(404).json({ error: 'Tool server not found' });
      }
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update tool server
  app.patch('/api/servers/:serverId', async (req, res) => {
    try {
      await toolManager.updateServer(req.params.serverId, req.body);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete tool server
  app.delete('/api/servers/:serverId', async (req, res) => {
    try {
      await toolManager.removeServer(req.params.serverId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Toggle tool server (enable/disable)
  app.post('/api/servers/:serverId/toggle', async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled field required (boolean)' });
      }
      await toolManager.toggleToolServer(req.params.serverId, enabled);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Call a tool
  app.post('/api/servers/:serverId/tools/:toolName', async (req, res) => {
    try {
      const saveToDisk = req.query.saveToDisk === 'true';
      const result = await toolManager.callTool(
        req.params.serverId,
        req.params.toolName,
        req.body,
        saveToDisk
      );
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}

// Initialize on startup
(async () => {
  // NOTE: Auto-approve for test mode is set up in server/server.ts (the main server)
  // This standalone server is only used for development/testing

  // Initialize sandbox folder (cleans up old files)
  await initializeSandbox();

  await toolManager.initialize();

  // Dynamic port: try 5177-5196, same range as electron/main.ts
  const ports = Array.from({ length: 20 }, (_, i) => 5177 + i);
  SERVER_PORT = await getPort({ port: ports });
  setServerPort(SERVER_PORT);

  await startInterpreterCliSocketServer(app, SERVER_PORT);

  server.listen(SERVER_PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  INTERPRETER WORKSTATION SERVER READY`);
    console.log(`  http://localhost:${SERVER_PORT}`);
    console.log(`${'='.repeat(60)}\n`);
  });
})();

// Shutdown gracefully
const cleanup = async () => {
  // Clean up sandbox folder
  await cleanupSandbox();

  // Clean up ACP providers before exit
  await cleanupAllACPProviders();

  await toolManager.shutdown();
};

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});
