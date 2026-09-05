// IMPORTANT: Import logger first to override console methods
import "./logger";

// Load environment variables from .env file
import dotenv from "dotenv";
dotenv.config();

import * as Sentry from "@sentry/node";
import { WORKSTATION_SENTRY_DSN } from "../shared/constants/sentry";

// Initialize Sentry for Express server
// In Electron: uses SENTRY_ENVIRONMENT set by main process (development/internal/production)
// In sidecar: falls back to NODE_ENV
const sentryEnvironment = process.env.SENTRY_ENVIRONMENT ||
  (process.env.NODE_ENV === 'production' ? 'production' : 'development');
Sentry.init({
  dsn: WORKSTATION_SENTRY_DSN,
  environment: sentryEnvironment,
  enabled: sentryEnvironment !== 'development' && Boolean(WORKSTATION_SENTRY_DSN),
  beforeSend: async (event) => {
    try {
      const { getTelemetryEnabled } = await import('./configStore');
      return (await getTelemetryEnabled()) ? event : null;
    } catch {
      return null;
    }
  },
  // Disable OpenTelemetry auto-instrumentation to reduce dependency footprint
  // and avoid electron-builder packaging issues on macOS
  registerEsmLoaderHooks: false,
});

import express from "express";
import { ToolManager } from "./tools/toolManager";
import { setToolManager } from "./tools/toolManagerAccessor";
import * as configStore from "./configStore";
import { approvalManager } from "./approvalManager";
import { agentTabManager } from "./agentTabManager";

// In test mode, enable auto-approve for approval requests
// This is needed because the sandbox often fails in test environments
// and we need to auto-approve dangerouslyDisableSandbox requests
if (process.env.NODE_ENV === 'test') {
  approvalManager.setAutoApprove(true);
  console.log('[Server] Test mode detected - auto-approve enabled for approval requests');
}
import { convertHeicToJpeg } from './utils/heicConverter';
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join as pathJoin, dirname, normalize as pathNormalize, resolve as pathResolve, sep as pathSep } from "node:path";
import os from "node:os";
import agentRouter from "./routes/agent";
import authRouter from "./routes/auth";
import workspaceRouter from "./routes/workspace";
import activityRouter from "./routes/activity";
import nylasRouter from "./routes/nylas";
import whatsappRouter from "./routes/whatsapp";
import telegramRouter from "./routes/telegram";
import inboxRouter from "./routes/inbox";
import pdfRouter from "./routes/pdf";
import ipcRouter from "./routes/ipc";
import mcpRouter from "./routes/mcp";
import interpreterCliRouter from "./routes/interpreterCli";
import publicThreadRouter from "./routes/publicThread";
import publicWorkspaceRouter from "./routes/publicWorkspace";
import { addClient, removeClient, broadcast } from "./utils/sse";
import { IPC_CHANNELS } from '../electron/ipc/registry';
import { broadcastEvent } from './handlers/broadcast';
import { initializeWhatsAppBridge } from './services/whatsappBridge';
import { refreshImportedAiSetup } from './handlers/importedAiSetup';
import { PRELAUNCH_SECURITY_DISABLE_HTTP_TOOL_EXECUTION } from './securityFlags';
// normalizePath intentionally not used here - it converts Unicode chars to ASCII,
// breaking paths with smart quotes etc. Use path.normalize (pathNormalize) instead.
import { enterWorkspaceOverride } from "./utils/workspace";
import {
  assignWorkspaceToSessionsWithoutOverride,
  enterWindowSessionOverride,
  listWindowSessions,
  resolveSessionWorkspaceOverride,
} from "./utils/windowSessions";
import {
  bindWindowSessionWorkspace,
  clearGlobalWorkspaceWatch,
  initializeGlobalWorkspaceWatch,
  stopAllWorkspaceWatches,
} from "./workspaceWatchRegistry";
import {
  ensureWorkspaceInitialized,
  onWorkspaceInitialized,
  startWorkspaceInitialization,
} from './workspaceInitialization';
import { existsSync, statSync, realpathSync, readFileSync } from "node:fs";
import { canWritePathInWorkspace } from "./utils/workspacePathValidation";
import { isAbsoluteFilesystemPath, isTrustedAbsoluteFileReadRequest } from "./utils/fileApiAccess";
import { shouldServeBuiltRendererRequest } from "./utils/builtRendererRouting";
import {
  createWorkstationConnectionRouter,
  getWorkstationHostPolicy,
  isWorkstationSessionAuthenticated,
  workstationAccessMiddleware,
  workstationCorsMiddleware,
} from './workstationConnection';

const FILE_WATCHER_DISABLED_FOR_RUNTIME = process.env.INTERPRETER_DISABLE_FILE_WATCHER === '1';
const app = express();

// Browser and Electron requests share one HTTP surface. Remote hosting narrows
// CORS to configured origins and enables credentialed sessions.
app.use(workstationCorsMiddleware);

app.use(express.json({ limit: '50mb' }));

// NOTE(victor): express.json() throws a SyntaxError with status 400 for malformed
// JSON bodies. Without this handler, the error reaches the unhandled-rejection path
// and fires a Sentry event on every bad request (Sentry issue #1572).
app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && err.status === 400 && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON in request body' });
    return;
  }
  next(err);
});

app.use('/api/workstation-connection', createWorkstationConnectionRouter());
app.use(workstationAccessMiddleware);

app.use((req, _res, next) => {
  const headerSessionKey = req.headers['x-interpreter-window-session'];
  const querySessionKey = req.query.windowSessionKey;
  const windowSessionKey = Array.isArray(headerSessionKey)
    ? headerSessionKey[0]
    : typeof headerSessionKey === 'string'
      ? headerSessionKey
      : typeof querySessionKey === 'string'
        ? querySessionKey
        : null;

  enterWindowSessionOverride(windowSessionKey);
  const workspaceOverride = resolveSessionWorkspaceOverride(windowSessionKey);
  if (workspaceOverride !== undefined) {
    enterWorkspaceOverride(workspaceOverride);
  }
  next();
});

// ============================================================================
// FEATURE FLAGS
// ============================================================================

/**
 * Enable direct HTTP endpoints for tool servers at /api/servers/*
 * When disabled, tool server access is only available via:
 * - IPC abstraction: /api/ipc/servers/* (for frontend)
 * - MCP server: /mcp (for external MCP clients)
 *
 * Set to false to reduce API surface area and enforce use of proper abstractions.
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

const serveBuiltRendererFromServer = !process.versions.electron
  || process.env.INTERPRETER_USE_BUILT_RENDERER === 'true';

// Serve frontend from dist/ when running sidecar/server-only or when unpackaged
// Electron explicitly requests the built renderer instead of Vite.
if (serveBuiltRendererFromServer) {
  const configuredRendererPath = process.env.INTERPRETER_WORKSTATION_RENDERER_DIR?.trim();
  const sourceRendererPath = pathJoin(process.cwd(), 'dist');
  const binaryRendererPath = dirname(process.execPath);
  const distPath = process.versions.electron
    ? pathJoin(__dirname, '../../dist')
    : configuredRendererPath
      ? pathResolve(configuredRendererPath)
      : existsSync(pathJoin(sourceRendererPath, 'index.html'))
        ? sourceRendererPath
        : binaryRendererPath;
  console.log('[Server] Serving static files from:', distPath);
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
  };

  app.use((req, res, next) => {
    if (!shouldServeBuiltRendererRequest(req.method, req.path)) {
      return next();
    }

    // Determine file path
    let filePath = req.path === '/' ? '/index.html' : req.path;
    const fullPath = pathJoin(distPath, filePath);

    try {
      // Check if file exists
      if (!existsSync(fullPath) || statSync(fullPath).isDirectory()) {
        // SPA fallback - serve index.html for client-side routes
        const indexPath = pathJoin(distPath, 'index.html');
        if (!existsSync(indexPath)) {
          return next(); // No index.html, let other handlers deal with it
        }
        const content = readFileSync(indexPath);
        res.setHeader('Content-Type', 'text/html');
        return res.send(content);
      }

      // Serve the file
      const ext = filePath.substring(filePath.lastIndexOf('.'));
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const content = readFileSync(fullPath);
      res.setHeader('Content-Type', contentType);
      res.send(content);
    } catch (err) {
      console.error('[Static] Error serving file:', fullPath, err);
      next(); // Let error handlers deal with it
    }
  });
}

// SSE endpoint for browser dev mode
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

  addClient(res);

  req.on('close', () => {
    console.log('[SSE] Client disconnected');
    clearInterval(keepalive);
    removeClient(res);
  });
});

// Re-export broadcast for backward compatibility
export const broadcastSSE = broadcast;

// Mount route modules
app.use('/api/auth', authRouter);
app.use('/api/agent', agentRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/activity', activityRouter);
app.use('/api/servers/nylas', nylasRouter);
app.use('/api/servers/whatsapp', whatsappRouter);
app.use('/api/servers/telegram', telegramRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/pdf', pdfRouter); // Direct PDF API (no IPC events) for UI use
app.use('/api/ipc', ipcRouter); // Browser mode IPC-equivalent endpoints
app.use('/api/interpreter-cli', interpreterCliRouter);
app.use('/api/public-thread', publicThreadRouter);
app.use('/api/public-workspace', publicWorkspaceRouter);
if (ENABLE_EXTERNAL_MCP_HTTP) {
  app.use('/mcp', mcpRouter); // MCP server endpoint (Streamable HTTP)
} else {
  console.log('[Server] External MCP HTTP endpoint disabled by pre-launch security hardening');
}

// Initialize WhatsApp bridge listeners once at server startup.
initializeWhatsAppBridge();

// Codex status endpoint (for tests and UI)
app.get('/api/providers/codex/status', async (_req, res) => {
  try {
    const { getCodexStatus } = await import('./handlers/providers');
    const status = await getCodexStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Initialize Tool Manager
const toolManager = new ToolManager();
setToolManager(toolManager);

void refreshImportedAiSetup().catch((error) => {
  console.error('[Server] Failed to refresh imported AI setup:', error);
});

onWorkspaceInitialized((workspacePath) => {
  if (FILE_WATCHER_DISABLED_FOR_RUNTIME) {
    return;
  }
  for (const record of assignWorkspaceToSessionsWithoutOverride(workspacePath)) {
    void bindWindowSessionWorkspace(record.sessionKey, workspacePath).catch((error: unknown) => {
      console.error('[Server] Failed to bind initialized workspace to window session:', error);
    });
    broadcastEvent(
      IPC_CHANNELS.WORKSPACE_CHANGED,
      { workspacePath },
      { windowSessionKey: record.sessionKey },
    );
  }
  void initializeFileWatcherForWorkspace(workspacePath).catch((error) => {
    console.error('[Server] Failed to initialize file watcher after workspace init:', error);
  });
});

// Start workspace initialization immediately so early workspace reads can await it.
startWorkspaceInitialization();

// Server port - use utility to avoid circular dependencies
import { setServerPort as _setServerPort, getServerPort as _getServerPort } from './utils/serverPort';
export const setServerPort = _setServerPort;
export const getServerPort = _getServerPort;

// Initialize file watcher for existing workspace
export async function initializeFileWatcher() {
  if (FILE_WATCHER_DISABLED_FOR_RUNTIME) {
    console.log('[Server] File watcher disabled for this runtime');
    return;
  }
  let currentWorkspace: string | null;
  try {
    currentWorkspace = await ensureWorkspaceInitialized();
  } catch (error) {
    console.error('[Server] Failed to initialize workspace before starting file watcher:', error);
    return;
  }
  await initializeFileWatcherForWorkspace(currentWorkspace);
}

async function initializeFileWatcherForWorkspace(currentWorkspace: string | null) {
  if (listWindowSessions().length > 0) {
    return;
  }
  await initializeGlobalWorkspaceWatch(currentWorkspace);
  console.log('[Server] File watcher initialized for workspace:', currentWorkspace);
}

// Cleanup file watcher
export async function cleanupFileWatcher() {
  if (FILE_WATCHER_DISABLED_FOR_RUNTIME) {
    return;
  }
  try {
    if (listWindowSessions().length === 0) {
      await clearGlobalWorkspaceWatch();
    }
    await stopAllWorkspaceWatches();
    console.log('[Server] File watcher stopped');
  } catch (error) {
    console.error('[Server] Error stopping file watcher:', error);
  }
}

app.get("/api/server/info", (_req, res) => {
  const port = getServerPort();
  res.json({ port, wsUrl: `ws://localhost:${port}` });
});

// Settings endpoint
app.get("/api/settings", async (_req, res) => {
  try {
    const config = await configStore.loadConfig();
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

// Get background opacity
app.get("/api/settings/background-opacity", async (_req, res) => {
  try {
    const opacity = await configStore.getBackgroundOpacity();
    res.json({ opacity });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to get background opacity" });
  }
});

// Set background opacity
app.post("/api/settings/background-opacity", async (req, res) => {
  try {
    const { opacity } = req.body;
    if (typeof opacity !== 'number') {
      return res.status(400).json({ error: "opacity must be a number" });
    }
    await configStore.setBackgroundOpacity(opacity);
    res.json({ success: true, opacity });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to set background opacity" });
  }
});

// PROFILE API ENDPOINTS

// Get all profiles (built-in + custom)
app.get("/api/profiles", async (_req, res) => {
  try {
    const { listProfiles } = await import('./handlers/profiles');
    res.json(await listProfiles());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to get profiles" });
  }
});

// Get a specific profile by ID
app.get("/api/profiles/:profileId", async (req, res) => {
  try {
    const profile = await configStore.getProfile(req.params.profileId);
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }
    res.json(profile);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to get profile" });
  }
});

// Create a new profile
app.post("/api/profiles", async (req, res) => {
  try {
    const profile = req.body;
    if (!profile.id || !profile.name || !profile.provider || !profile.modelId) {
      return res.status(400).json({ error: "Missing required fields: id, name, provider, modelId" });
    }
    await configStore.addProfile(profile);
    res.json({ success: true, profile });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to create profile" });
  }
});

// Update an existing profile
app.patch("/api/profiles/:profileId", async (req, res) => {
  try {
    await configStore.updateProfile(req.params.profileId, req.body);
    const updated = await configStore.getProfile(req.params.profileId);
    res.json({ success: true, profile: updated });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to update profile" });
  }
});

// Delete a profile
app.delete("/api/profiles/:profileId", async (req, res) => {
  try {
    const { deleteProfile } = await import('./handlers/profiles');
    res.json(await deleteProfile(req.params.profileId));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to delete profile" });
  }
});

// Set default profile
app.post("/api/profiles/default", async (req, res) => {
  try {
    const { profileId } = req.body;
    if (!profileId) {
      return res.status(400).json({ error: "profileId is required" });
    }
    await configStore.setDefaultProfileId(profileId);
    const fastProfileId = await configStore.getFastProfileId();
    res.json({ success: true, defaultProfileId: profileId, fastProfileId });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to set default profile" });
  }
});

// Set global fast profile
app.post("/api/profiles/fast", async (req, res) => {
  try {
    const { profileId } = req.body;
    if (!profileId) {
      return res.status(400).json({ error: "profileId is required" });
    }
    await configStore.setFastProfileId(profileId);
    const defaultProfileId = await configStore.getDefaultProfileId();
    res.json({ success: true, defaultProfileId, fastProfileId: profileId });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to set fast profile" });
  }
});

// Reset a built-in profile to its defaults
app.post("/api/profiles/:profileId/reset", async (req, res) => {
  try {
    const { profileId } = req.params;
    const profile = await configStore.resetProfile(profileId);
    res.json({ success: true, profile });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to reset profile" });
  }
});


// TOOL SERVER ROUTES
// These direct HTTP endpoints are disabled by default.
// Use the IPC abstraction (/api/ipc/servers/*) or MCP server (/mcp) instead.
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


// TOOL SETTINGS ROUTES (for tools that need to store configuration)

// Get tool settings
app.get('/api/tool-settings/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    const settingsPath = pathJoin(os.homedir(), '.interpreter', `${serverId}-settings.json`);

    try {
      const data = await readFile(settingsPath, 'utf-8');
      res.json(JSON.parse(data));
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'Settings not found' });
      } else {
        throw error;
      }
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Save tool settings
app.post('/api/tool-settings/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    const settingsDir = pathJoin(os.homedir(), '.interpreter');
    const settingsPath = pathJoin(settingsDir, `${serverId}-settings.json`);

    // Ensure directory exists
    await mkdir(settingsDir, { recursive: true });

    // Save settings
    await writeFile(settingsPath, JSON.stringify(req.body, null, 2));

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// FILE API ENDPOINTS

// Read file content
app.get('/api/files/:path(*)', async (req, res) => {
  try {
    const currentWorkspace = await ensureWorkspaceInitialized();
    const decodedPath = decodeURIComponent(req.params.path);
    const rawMode = req.query.raw === 'true';
    const isAbsolutePath = isAbsoluteFilesystemPath(decodedPath);
    const workstationPolicy = getWorkstationHostPolicy();
    const authenticatedRemoteRequest = workstationPolicy.remote
      && isWorkstationSessionAuthenticated(req, workstationPolicy);

    if (
      isAbsolutePath
      && !isTrustedAbsoluteFileReadRequest(req.headers)
      && !authenticatedRemoteRequest
    ) {
      return res.status(403).json({ error: "Access denied: absolute path reads require local origin" });
    }

    // Support both absolute and workspace-relative paths
    // If path is absolute, use it directly; otherwise, resolve relative to workspace
    // NOTE: Use path.normalize instead of normalizePath to preserve Unicode characters
    // in filesystem paths (e.g., smart quotes in folder names like "Kiman's")
    let fullPath: string;
    if (isAbsolutePath) {
      fullPath = pathNormalize(decodedPath);
    } else {
      if (!currentWorkspace) {
        return res.status(400).json({ error: "No workspace set for relative paths" });
      }
      fullPath = pathJoin(currentWorkspace, decodedPath);
    }

    try {
      const stats = await stat(fullPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: "Path is not a file" });
      }
    } catch {
      return res.status(404).json({ error: "File not found" });
    }

    // Resolve symlinks to get the real path for reading
    const realPath = realpathSync(fullPath);
    if (currentWorkspace && (!isAbsolutePath || authenticatedRemoteRequest)) {
      const realWorkspace = realpathSync(currentWorkspace);
      if (realPath !== realWorkspace && !realPath.startsWith(realWorkspace + pathSep)) {
        return res.status(403).json({ error: "Access denied: path outside workspace" });
      }
    }

    const { readFileSync } = await import('node:fs');

    if (rawMode) {
      // Raw binary mode - serve file with proper Content-Type
      const ext = fullPath.toLowerCase().split('.').pop();
      const contentTypes: Record<string, string> = {
        // Images
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'bmp': 'image/bmp',
        'ico': 'image/x-icon',
        // Video
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'ogg': 'video/ogg',
        'mov': 'video/quicktime',
        'avi': 'video/x-msvideo',
        // Audio
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'flac': 'audio/flac',
        'aac': 'audio/aac',
        'm4a': 'audio/mp4',
        'wma': 'audio/x-ms-wma',
        'aiff': 'audio/aiff',
        'opus': 'audio/opus',
        // Documents
        'pdf': 'application/pdf',
        // HTML
        'html': 'text/html',
        'htm': 'text/html',
      };
      // HEIC/HEIF: convert to JPEG for browser compatibility (Chromium can't render HEIC natively)
      if (ext === 'heic' || ext === 'heif') {
        const converted = await convertHeicToJpeg(realPath);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', converted.length);
        res.send(converted);
        return;
      }

      const contentType = contentTypes[ext || ''] || 'application/octet-stream';
      const fileBuffer = readFileSync(realPath);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileBuffer.length);
      res.send(fileBuffer);
    } else {
      // Text mode - return JSON with content
      const content = readFileSync(realPath, 'utf-8');
      res.json({ content });
    }
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to read file" });
  }
});

// Write file content
app.put('/api/files/:path(*)', async (req, res) => {
  try {
    const currentWorkspace = await ensureWorkspaceInitialized();
    if (!currentWorkspace) {
      return res.status(400).json({ error: "No workspace set" });
    }

    const decodedPath = decodeURIComponent(req.params.path);
    const isAbsolutePath = isAbsoluteFilesystemPath(decodedPath);

    // Support both absolute and workspace-relative paths
    // NOTE: Use path.normalize instead of normalizePath to preserve Unicode characters
    const fullPath = isAbsolutePath
      ? pathNormalize(decodedPath)
      : pathJoin(currentWorkspace, decodedPath);

    if (!canWritePathInWorkspace(fullPath, currentWorkspace)) {
      return res.status(403).json({ error: "Access denied: path outside workspace" });
    }

    const { content, binary } = req.body;
    if (content === undefined && binary === undefined) {
      return res.status(400).json({ error: "content or binary field required" });
    }

    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');

    // Ensure parent directory exists
    mkdirSync(dirname(fullPath), { recursive: true });

    if (binary) {
      // Handle binary data (base64 encoded)
      if (typeof binary !== 'string') {
        return res.status(400).json({ error: "binary field must be a base64 string" });
      }
      const buffer = Buffer.from(binary, 'base64');
      writeFileSync(fullPath, buffer);
    } else {
      // Handle text data
      if (typeof content !== 'string') {
        return res.status(400).json({ error: "content field must be a string" });
      }
      writeFileSync(fullPath, content, 'utf-8');
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to write file" });
  }
});

// APPROVAL API ENDPOINTS

const approvalPollState = new Map<string, { signature: string; emptyRepeatCount: number }>();

function logApprovalPoll(toolCallId: string | undefined, approvals: Array<{ id?: string }>): void {
  const key = toolCallId ?? '__all__';
  const signature = approvals.map((approval) => approval.id ?? 'unknown').sort().join(',');
  const previous = approvalPollState.get(key);

  if (!previous || previous.signature !== signature) {
    approvalPollState.set(key, {
      signature,
      emptyRepeatCount: 0,
    });
    console.log(
      `[APPROVAL] list_changed scope=${toolCallId ?? 'all'} count=${approvals.length}`,
    );
    return;
  }

  if (approvals.length > 0) {
    return;
  }

  const nextRepeatCount = previous.emptyRepeatCount + 1;
  approvalPollState.set(key, {
    signature,
    emptyRepeatCount: nextRepeatCount,
  });

  if (nextRepeatCount % 50 === 0) {
    console.log(
      `[APPROVAL] poll_empty scope=${toolCallId ?? 'all'} repeat=${nextRepeatCount}`,
    );
  }
}

// Get all pending approvals
app.get('/api/approvals', (req, res) => {
  try {
    const toolCallId = req.query.toolCallId as string | undefined;
    const approvals = approvalManager.getApprovals(toolCallId);
    logApprovalPoll(toolCallId, approvals);
    res.json({ approvals });
  } catch (error: any) {
    console.error('[Approvals API] Error getting approvals:', error);
    res.status(500).json({ error: error.message });
  }
});

// Approve an approval
app.post('/api/approvals/:id/approve', (req, res) => {
  try {
    const { id } = req.params;

    if (!approvalManager.hasApproval(id)) {
      return res.status(404).json({ error: 'Approval not found' });
    }

    approvalManager.approve(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Deny an approval
app.post('/api/approvals/:id/deny', (req, res) => {
  try {
    const { id } = req.params;

    if (!approvalManager.hasApproval(id)) {
      return res.status(404).json({ error: 'Approval not found' });
    }

    approvalManager.deny(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Sentry error handler - must be after all routes
Sentry.setupExpressErrorHandler(app);

export { app, toolManager, approvalManager, agentTabManager };
