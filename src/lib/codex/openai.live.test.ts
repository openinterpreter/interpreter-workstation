import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "./app-server-client";
import { CodexService } from "./service";
import {
  buildAppManagedModelProviderId,
  buildProfileFromPreset,
  getCustomPreset,
} from "./profiles";
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from "./test-fixtures/interpreter-app-server-test-binary";
import { NotificationRecorder } from "./test-fixtures/notification-recorder";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const OPENAI_MODEL = process.env.OPENAI_LIVE_MODEL?.trim() || "gpt-5.4";
const liveTestEnabled = process.env.RUN_OPENAI_LIVE_TESTS === "1";
const describeIf = liveTestEnabled
  && OPENAI_API_KEY.length > 0
  && interpreterAppServerTestBinaryAvailable
  ? describe
  : describe.skip;

describeIf("OpenAI through the bundled OIX app-server (live)", () => {
  let codexHome = "";
  let transport: StdioJsonRpcTransport;
  let client: CodexAppServerClient;
  let service: CodexService;
  let recorder: NotificationRecorder;
  let permissionTestRoot = "";
  let permissionWorkspace = "";
  let outsideFile = "";

  beforeAll(async () => {
    codexHome = await mkdtemp(join(tmpdir(), "workstation-oix-openai-live-"));
    permissionTestRoot = await mkdtemp(join(process.cwd(), ".oix-permission-live-"));
    permissionWorkspace = join(permissionTestRoot, "workspace");
    outsideFile = join(permissionTestRoot, "outside.txt");
    await mkdir(permissionWorkspace);
    await writeFile(join(permissionWorkspace, "inside.txt"), "ALLOWED");
    await writeFile(outsideFile, "DENIED");
    transport = new StdioJsonRpcTransport(
      (_command, args, env) => spawnInterpreterAppServerForTest(args, env),
      codexHome,
    );
    client = new CodexAppServerClient(transport, null, async () => ({
      sandboxMode: "workspace-write",
      readAccessMode: "workspace-only",
      networkAccess: true,
      macosTempAccess: false,
      macosScreenshotAccess: false,
    }));
    service = new CodexService(client);
    recorder = new NotificationRecorder(client);
    await client.ensureConnected();

    const preset = getCustomPreset("openai-api");
    expect(preset).toBeDefined();
    const profile = buildProfileFromPreset(preset!, {
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
    });
    expect(profile.providerConfig).toBeDefined();

    await client.configValueWrite("web_search", "disabled");
  }, 30_000);

  afterAll(async () => {
    recorder?.dispose();
    await transport?.stop();
    if (codexHome) {
      rmSync(codexHome, { recursive: true, force: true });
    }
    if (permissionTestRoot) {
      rmSync(permissionTestRoot, { recursive: true, force: true });
    }
  });

  test("uses the Workstation provider config and completes a real model turn", async () => {
    const runtimeProviderId = buildAppManagedModelProviderId("openai");
    const preset = getCustomPreset("openai-api");
    expect(preset).toBeDefined();
    const profile = buildProfileFromPreset(preset!, {
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
    });
    expect(profile.providerConfig).toBeDefined();
    let turnId = "";
    const completedTurn = await service.runTurn({
      model: OPENAI_MODEL,
      modelProvider: runtimeProviderId,
      providerConfig: profile.providerConfig,
      cwd: process.cwd(),
      message: "Reply with exactly OIX_API_OK and nothing else.",
      onEvent: (event) => {
        if (event.kind === "turn") {
          turnId = event.turnId;
        }
      },
    });
    expect(completedTurn.status).toBe("completed");
    expect(turnId).toBeTruthy();
    expect(recorder.getStreamErrors(turnId)).toHaveLength(0);
    expect(recorder.collectAssistantText(turnId).trim()).toBe("OIX_API_OK");
  }, 120_000);

  test("uses OIX native view_image on the multithread app-server runtime", async () => {
    const runtimeProviderId = buildAppManagedModelProviderId("openai");
    const preset = getCustomPreset("openai-api");
    expect(preset).toBeDefined();
    const profile = buildProfileFromPreset(preset!, {
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
    });
    expect(profile.providerConfig).toBeDefined();

    const imagePath = resolve(process.cwd(), "resources/icons/app.png");
    let turnId = "";
    const completedTurn = await service.runTurn({
      model: OPENAI_MODEL,
      modelProvider: runtimeProviderId,
      providerConfig: profile.providerConfig,
      cwd: process.cwd(),
      message:
        `You must call the native view_image tool on ${JSON.stringify(imagePath)}. `
        + "After the tool succeeds, reply with exactly OIX_IMAGE_OK and nothing else.",
      onEvent: (event) => {
        if (event.kind === "turn") {
          turnId = event.turnId;
        }
      },
    });

    expect(completedTurn.status).toBe("completed");
    expect(turnId).toBeTruthy();
    expect(recorder.getStreamErrors(turnId)).toHaveLength(0);
    expect(recorder.collectAssistantText(turnId).trim()).toBe("OIX_IMAGE_OK");
  }, 120_000);

  test("allows workspace reads while denying OIX-native shell reads outside it", async () => {
    const runtimeProviderId = buildAppManagedModelProviderId("openai");
    const preset = getCustomPreset("openai-api");
    expect(preset).toBeDefined();
    const profile = buildProfileFromPreset(preset!, {
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
    });
    expect(profile.providerConfig).toBeDefined();

    const insideFile = join(permissionWorkspace, "inside.txt");
    const command =
      `if [ "$(cat ${JSON.stringify(insideFile)})" = "ALLOWED" ] `
      + `&& ! cat ${JSON.stringify(outsideFile)} >/dev/null 2>&1; `
      + "then printf OIX_SCOPE_OK; else printf OIX_SCOPE_BROKEN; fi";
    let turnId = "";
    const completedTurn = await service.runTurn({
      model: OPENAI_MODEL,
      modelProvider: runtimeProviderId,
      providerConfig: profile.providerConfig,
      cwd: permissionWorkspace,
      message:
        `Run this exact shell command and then reply with only its stdout: ${command}`,
      onEvent: (event) => {
        if (event.kind === "turn") {
          turnId = event.turnId;
        }
      },
    });

    expect(completedTurn.status).toBe("completed");
    expect(turnId).toBeTruthy();
    expect(recorder.getStreamErrors(turnId)).toHaveLength(0);
    expect(recorder.collectAssistantText(turnId).trim()).toBe("OIX_SCOPE_OK");
  }, 120_000);
});
