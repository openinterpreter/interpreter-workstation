import { rmSync } from "node:fs";

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "../app-server-client";
import {
  buildProfileFromPreset,
  getCustomPreset,
  providerConfigToJsonValue,
} from "../profiles";
import type { ProfileId } from "../profile-options";
import type { WireApi } from "../../../../shared/types/model";
import { NotificationRecorder } from "./notification-recorder";
import {
  ScriptedLocalProvider,
  type ScriptedScenario,
} from "./scripted-local-provider";
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from "./interpreter-app-server-test-binary";

/**
 * Test harness that wires together a ScriptedLocalProvider (fake HTTP server),
 * an OIX interpreter-app-server process, and a NotificationRecorder.
 *
 * NOTE(victor): This is Layer 2 (Mock Integration) of a 4-layer test strategy:
 *   Layer 1: Unit tests -- pure logic, no I/O (profiles.test.ts, validators.test.ts, etc.)
 *   Layer 2: Mock integration -- real interpreter-app-server + scripted HTTP server (this harness)
 *   Layer 3: Live contract -- real Ollama/LM Studio, opt-in (*.live.test.ts)
 *   Layer 4: E2E Electron -- full app via Playwright (tests/*.spec.ts)
 *
 * Remaining test gaps (not yet implemented):
 *   - Tool call lifecycle integration tests (codex -> tool call -> resume -> final text)
 *   - E2E tests for local provider settings UI and error message rendering
 *
 * NOTE(victor): Uses a unique provider name ("fake-{presetId}") to avoid
 * colliding with codex's built-in provider handling for "ollama"/"lmstudio".
 * The codex binary has hardcoded base URLs for known provider names and
 * ignores config overrides for them.
 *
 * Usage:
 *   const harness = new CodexTestHarness("/tmp/test-codex-home");
 *   await harness.start("ollama", scenario);
 *   // use harness.modelProvider for startThread calls
 *   await harness.stop();
 */
export class CodexTestHarness {
  private _transport: StdioJsonRpcTransport | null = null;
  private _client: CodexAppServerClient | null = null;
  private _recorder: NotificationRecorder | null = null;
  private _fakeServer: ScriptedLocalProvider;
  private _codexHome: string;
  private _extraEnv: NodeJS.ProcessEnv;
  private _modelProvider: string | null = null;

  constructor(codexHome: string, extraEnv: NodeJS.ProcessEnv = {}) {
    this._codexHome = codexHome;
    this._extraEnv = extraEnv;
    this._fakeServer = new ScriptedLocalProvider();
  }

  /** Returns true when the platform-specific interpreter-app-server binary exists on disk. */
  static get appServerAvailable(): boolean {
    return interpreterAppServerTestBinaryAvailable;
  }

  get client(): CodexAppServerClient {
    if (!this._client) throw new Error("Harness not started");
    return this._client;
  }

  get recorder(): NotificationRecorder {
    if (!this._recorder) throw new Error("Harness not started");
    return this._recorder;
  }

  get fakeServer(): ScriptedLocalProvider {
    return this._fakeServer;
  }

  /** The provider name registered with codex (use for startThread calls). */
  get modelProvider(): string {
    if (!this._modelProvider) throw new Error("Harness not started");
    return this._modelProvider;
  }

  /**
   * Boots the fake provider server, spawns interpreter-app-server, connects the
   * JSON-RPC client, and writes the provider config so codex targets the
   * fake server.
   */
  async start(
    presetId: ProfileId,
    scenario: ScriptedScenario,
    options: { wireApi?: WireApi } = {},
  ): Promise<void> {
    rmSync(this._codexHome, { recursive: true, force: true });

    this._fakeServer.setScenario(scenario);
    const baseUrl = await this._fakeServer.start();

    this._transport = new StdioJsonRpcTransport(
      (_command, args, env) =>
        spawnInterpreterAppServerForTest(args, env, this._extraEnv),
      this._codexHome,
    );
    this._client = new CodexAppServerClient(this._transport, null);
    this._recorder = new NotificationRecorder(this._client);

    await this._client.ensureConnected();

    const preset = getCustomPreset(presetId);
    if (!preset) {
      throw new Error(`Unknown preset: ${presetId}`);
    }

    const profile = buildProfileFromPreset(preset, {
      baseUrl,
      wireApi: options.wireApi,
    });
    if (!profile.providerConfig) {
      throw new Error("Profile missing providerConfig");
    }

    // Use a unique provider name to avoid codex built-in provider handling.
    this._modelProvider = `fake-${presetId}`;

    await this._client.configValueWrite(
      `model_providers.${this._modelProvider}`,
      providerConfigToJsonValue(profile.providerConfig),
    );
    await this._client.configValueWrite("web_search", "disabled");
  }

  /**
   * Tears down the codex process, stops the fake server, and removes the
   * temporary codex home directory.
   */
  async stop(): Promise<void> {
    this._recorder?.dispose();
    await this._transport?.stop();
    await this._fakeServer.stop();
    rmSync(this._codexHome, { recursive: true, force: true });

    this._transport = null;
    this._client = null;
    this._recorder = null;
    this._modelProvider = null;
  }
}
