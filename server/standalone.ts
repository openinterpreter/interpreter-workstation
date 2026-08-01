/**
 * Standalone Server / Headless Task Entry Point
 *
 * Run the workstation server without Electron as a sidecar process.
 * It can either:
 * 1. stay up as a normal headless app server
 * 2. run one headless task on startup, optionally shut down after completion
 *
 * Usage:
 *   bun server/standalone.ts
 *   bun server/standalone.ts --message "Summarize the repo" --shutdown-after-task
 *   bun server/standalone.ts --thread-id thr_123 --message "Continue and finish this"
 *   node dist/sidecar.js --message "Do the task" --shutdown-after-task
 */

import "./logger";

import dotenv from "dotenv";
dotenv.config();

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import getPort from "get-port";
import { agentTabManager } from "./agentTabManager";
import { approvalManager } from "./approvalManager";
import {
  setInterpreterHomeDir,
} from "./configStore";
import {
  startInterpreterCliSocketServer,
  type InterpreterCliSocketServerHandle,
} from "./utils/interpreterCliSocketServer";
import {
  startInterpreterCliFileBridge,
  type InterpreterCliFileBridgeHandle,
} from "./utils/interpreterCliFileBridge";
import {
  buildInterpreterCliServerConnection,
  materializeInterpreterCliLauncher,
} from "./utils/interpreterCliRuntime";
import {
  getHeadlessTaskCliWorkspaceError,
  hasHeadlessTaskRequest,
  printHeadlessTaskHelp,
  runHeadlessTaskCli,
} from "./headlessTaskCli";
import { parseCliOptions, type CliOptions } from "./standaloneOptions";
import {
  ensureBrowserExtensionRelayRunning,
  formatOptionalBrowserExtensionRelayStartupFailureLog,
  shutdownBrowserExtensionRelay,
} from "./utils/browserExtensionRelay";

const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5177;
const DEFAULT_WORKSPACE = process.env.WORKSPACE || process.cwd();
const STANDALONE_HOST = "127.0.0.1";


async function shutdownServer(
  server: http.Server,
  exitCode: number,
  deps: {
    interpreterCliFileBridge: InterpreterCliFileBridgeHandle;
    interpreterCliSocketServer: InterpreterCliSocketServerHandle | null;
    cleanupFileWatcher: () => Promise<void>;
    cleanupSandbox: () => Promise<void>;
    cleanupAllACPProviders: () => Promise<void>;
    toolManager: { shutdown: () => Promise<void> };
  },
): Promise<never> {
  console.log("\n[Sidecar] Shutting down...");

  await deps.cleanupFileWatcher();
  await deps.cleanupSandbox();
  await deps.cleanupAllACPProviders();
  await deps.toolManager.shutdown();
  await shutdownBrowserExtensionRelay();
  await deps.interpreterCliFileBridge.close();
  if (deps.interpreterCliSocketServer) {
    await deps.interpreterCliSocketServer.close();
  }

  await new Promise<void>((resolve) => {
    server.close(() => {
      console.log("[Sidecar] Server closed");
      resolve();
    });

    setTimeout(() => {
      console.log("[Sidecar] Force exit");
      resolve();
    }, 5000);
  });

  process.exit(exitCode);
}

export async function runStandaloneCli(argv: string[] = process.argv.slice(2)) {
  const cliOptions = parseCliOptions(argv);
  if (cliOptions.help) {
    printHeadlessTaskHelp("bun server/standalone.ts");
    return;
  }
  const hasTaskRequest = hasHeadlessTaskRequest(cliOptions);
  if (hasTaskRequest) {
    const workspaceError = getHeadlessTaskCliWorkspaceError(cliOptions);
    if (workspaceError) {
      throw new Error(workspaceError);
    }
  }
  const workspace = cliOptions.workspace?.trim() || DEFAULT_WORKSPACE;

  if (cliOptions.home) {
    const resolvedHome = path.resolve(cliOptions.home);
    process.env.HOME = resolvedHome;
    setInterpreterHomeDir(resolvedHome);
  }
  // Headless Bun sidecars do not need workspace file watching, and on Windows
  // the native watcher crashes reliably enough to break browser-control flows.
  process.env.INTERPRETER_DISABLE_FILE_WATCHER = '1';
  const interpreterCliPath = materializeInterpreterCliLauncher();
  const devCallerToken = "dev-tools-cli";
  if (cliOptions.devAutoApproveTools) {
    approvalManager.setAutoApprove(true);
    agentTabManager.registerAgentRuntime({
      agentId: "dev-tools-cli",
      callerToken: devCallerToken,
      workspacePath: path.resolve(workspace),
    });
  }

  process.env.WORKSTATION_EXPLICIT_WORKSPACE = path.resolve(workspace);

  const serverModule = await import("./server");
  const sandboxModule = await import("./utils/sandboxManager");
  const acpProviderModule = await import("./utils/acpProvider");
  const workspaceModule = await import("./utils/workspace");

  const {
    app,
    toolManager,
    initializeFileWatcher,
    cleanupFileWatcher,
    setServerPort,
  } = serverModule;
  const { initializeSandbox, cleanupSandbox } = sandboxModule;
  const { cleanupAllACPProviders } = acpProviderModule;
  const { setWorkspace } = workspaceModule;

  const requestedPort = cliOptions.port ?? DEFAULT_PORT;
  const serverPort = requestedPort === "auto"
    ? await getPort()
    : requestedPort;

  if (!cliOptions.quietStartup) {
    console.log("\n" + "=".repeat(60));
    console.log("  WORKSTATION SIDECAR");
    console.log("=".repeat(60));
    console.log(`  Mode: Standalone (no Electron)`);
    console.log(`  Workspace: ${workspace}`);
    if (cliOptions.home) {
      console.log(`  Home: ${path.resolve(cliOptions.home)}`);
    }
    console.log("=".repeat(60) + "\n");
  }

  setWorkspace(workspace);

  await initializeSandbox();
  await toolManager.initialize();
  await initializeFileWatcher();
  // Browser control is optional in headless mode too. Let the sidecar continue
  // serving other capabilities even when the relay cannot start.
  void ensureBrowserExtensionRelayRunning().catch((error) => {
    console.warn(formatOptionalBrowserExtensionRelayStartupFailureLog(error));
  });

  const portAvailable = requestedPort === "auto"
    ? true
    : (await getPort({ port: serverPort })) === serverPort;
  if (!portAvailable) {
    console.error("\n" + "=".repeat(60));
    console.error(`  ERROR: Port ${serverPort} is already in use`);
    console.error(`  Try: --port auto or PORT=${serverPort + 1} bun server/standalone.ts`);
    console.error("=".repeat(60) + "\n");
    process.exit(1);
  }

  setServerPort(serverPort);

  const server = http.createServer(app);
  const interpreterCliFileBridge = await startInterpreterCliFileBridge(serverPort);
  const interpreterCliSocketServer = await startInterpreterCliSocketServer(app, serverPort);
  const interpreterCliServerConnection = buildInterpreterCliServerConnection(serverPort);
  await new Promise<void>((resolve) => {
    server.listen(serverPort, STANDALONE_HOST, () => {
      if (cliOptions.streamJsonl && cliOptions.quietStartup) {
        console.log(JSON.stringify({
          type: "server_ready",
          host: STANDALONE_HOST,
          port: serverPort,
          workspace,
          home: cliOptions.home ? path.resolve(cliOptions.home) : undefined,
          interpreterCliPath,
          interpreterCliServerConnection,
          interpreterCallerToken: cliOptions.devAutoApproveTools ? devCallerToken : undefined,
          devAutoApproveTools: cliOptions.devAutoApproveTools,
        }));
      } else if (!cliOptions.quietStartup) {
        console.log("\n" + "=".repeat(60));
        console.log("  WORKSTATION SIDECAR READY");
        console.log(`  http://${STANDALONE_HOST}:${serverPort}`);
        console.log("=".repeat(60));
        console.log(`  Interpreter CLI: ${interpreterCliPath}`);
        console.log(`  Interpreter CLI connection: ${interpreterCliServerConnection}`);
        if (cliOptions.devAutoApproveTools) {
          console.log(`  Interpreter CLI caller token: ${devCallerToken}`);
        }
        if (cliOptions.devAutoApproveTools) {
          console.log("  Tool approvals: dev auto-approve ENABLED");
        }
        console.log("\n  API Endpoints:");
        console.log(`    GET  http://${STANDALONE_HOST}:${serverPort}/api/server/info`);
        console.log(`    GET  http://${STANDALONE_HOST}:${serverPort}/api/agent/threads`);
        console.log(`    POST http://${STANDALONE_HOST}:${serverPort}/api/agent/tasks`);
        console.log(`    POST http://${STANDALONE_HOST}:${serverPort}/api/agent/tasks/stream`);
        console.log(`    POST http://${STANDALONE_HOST}:${serverPort}/api/agent/chat`);
        console.log(`    GET  http://${STANDALONE_HOST}:${serverPort}/api/events (SSE)`);
        console.log("\n  Press Ctrl+C to stop\n");
      }
      resolve();
    });
  });

  let shuttingDown = false;
  const cleanup = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownServer(server, exitCode, {
      interpreterCliFileBridge,
      interpreterCliSocketServer,
      cleanupFileWatcher,
      cleanupSandbox,
      cleanupAllACPProviders,
      toolManager,
    });
  };

  process.on("SIGTERM", () => {
    void cleanup(0);
  });
  process.on("SIGINT", () => {
    void cleanup(0);
  });

  if (hasTaskRequest) {
    const exitCode = await runHeadlessTaskCli(argv);
    if (cliOptions.shutdownAfterTask) {
      await cleanup(exitCode);
    }
  }

  // Keep standalone sidecars alive until an explicit signal or cleanup path exits.
  await new Promise<void>(() => {});
}

const standaloneEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedPath === standaloneEntryPath) {
  runStandaloneCli().catch((err) => {
    console.error("[Sidecar] Fatal error:", err);
    process.exit(1);
  });
}
