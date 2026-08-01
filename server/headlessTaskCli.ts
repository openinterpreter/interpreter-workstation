import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { approvalManager } from "./approvalManager";
import { getConfigPath } from "./configStore";
import {
  startAgentTask,
  type AgentTaskProgressEvent,
} from "./agentTaskService";
import { applyProgrammaticTaskRuntimeConfig } from "./programmaticTaskRuntimeConfig";
import {
  buildProgrammaticTaskRuntimeConfig,
  parseCliOptions,
  type CliOptions,
} from "./standaloneOptions";
import type { ProgrammaticTaskRuntimeConfig } from "./programmaticTaskRuntimeConfig";
import {
  getHeadlessTaskCliWorkspaceError as getCliWorkspaceError,
  normalizeHeadlessTaskWorkspace,
} from "./utils/headlessTaskWorkspace";
import { resolveDefaultCodexHome } from "../src/lib/codex/app-server-client";
import type { StreamSkillReference } from "../src/lib/codex/api-types";
import { formatTurnErrorDescriptor } from "../src/lib/codex/errors";

export function printHeadlessTaskHelp(binaryLabel = "workstation-sidecar"): void {
  console.log(`
Workstation headless task runtime

Usage:
  ${binaryLabel} [options]

Task options:
  --message <text>                 Run a headless task with the given message
  --message-file <path>            Read the initial message from a file
  --system <text>                  Optional system prompt
  --system-file <path>             Read the system prompt from a file
  --thread-id <id>                 Resume an existing app thread before sending the message
  --timeout-ms <ms>                Task timeout in milliseconds
  --workspace <path>               Required workspace root for headless task runs
  --home <path>                    Isolated Interpreter home/config root for this run
  --result-file <path>             Write the final task result JSON to a file
  --skill <name|path>              Attach a skill by installed name or SKILL.md path
  --shutdown-after-task            Exit after the task completes
  --stream-jsonl                   Stream machine-readable progress events to stdout
  --quiet-startup                  Suppress banners/API help for machine-driven runs
  --dev-auto-approve-tools         Dev only: auto-approve app-tool approvals for manual CLI testing

Config options (writes the real app config before starting the task):
  Only passed flags override the existing app config for the run.
  --approval-policy <policy>       Override Codex approval policy: never | on-failure | on-request | untrusted
  --sandbox <mode>                 Override Codex sandbox mode: read-only | workspace-write | danger-full-access
  --network-access                 Override Codex sandbox network access to enabled
  --no-network-access              Override Codex sandbox network access to disabled
  --profile-id <id>                Write and use a programmatic profile for the run
  --profile-name <name>            Programmatic profile name for the run
  --model <id>                     Model ID for the programmatic profile
  --openai-api-key <key>           OpenAI API key for the programmatic profile
  --openai-api-key-env <name>      Environment variable to read for the OpenAI API key
`.trim());
}

function humanizeSkillLabel(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveHeadlessSkillReferences(rawSkills: string[] | undefined): StreamSkillReference[] {
  if (!rawSkills?.length) {
    return [];
  }

  const codexHome = process.env.CODEX_HOME?.trim() || resolveDefaultCodexHome();
  return rawSkills.map((rawSkill) => {
    const trimmed = rawSkill.trim();
    if (!trimmed) {
      throw new Error('--skill cannot be empty');
    }

    const looksLikePath = trimmed.includes('/') || trimmed.includes('\\') || trimmed.toLowerCase().endsWith('.md');
    const skillPath = looksLikePath
      ? path.resolve(trimmed)
      : path.join(codexHome, 'skills', trimmed, 'SKILL.md');
    const name = looksLikePath
      ? path.basename(path.dirname(skillPath))
      : trimmed;

    return {
      id: `headless:${name}:${skillPath}`,
      label: humanizeSkillLabel(name) || name,
      name,
      path: skillPath,
    };
  });
}

export function hasHeadlessTaskRequest(options: CliOptions): boolean {
  return Boolean(options.message || options.messageFile || options.threadId);
}

export function getHeadlessTaskCliWorkspaceError(options: Pick<CliOptions, "workspace">): string | null {
  return getCliWorkspaceError(options.workspace);
}

async function resolveOptionalText(
  inlineValue: string | undefined,
  filePath: string | undefined,
): Promise<string | undefined> {
  if (inlineValue !== undefined) {
    return inlineValue;
  }
  if (filePath) {
    return await readFile(path.resolve(filePath), "utf8");
  }
  return undefined;
}

function createProgressEmitter(streamJsonl: boolean) {
  let wroteInlineText = false;

  const ensureLineBreak = () => {
    if (wroteInlineText) {
      process.stdout.write("\n");
      wroteInlineText = false;
    }
  };

  const emitJson = (payload: Record<string, unknown>) => {
    console.log(JSON.stringify(payload));
  };

  const emit = (event: AgentTaskProgressEvent) => {
    if (streamJsonl) {
      emitJson({ type: "progress", ...event });
      return;
    }

    if (event.kind === "thread") {
      ensureLineBreak();
      console.log(`[thread] ${event.threadId}`);
      return;
    }

    if (event.kind === "turn") {
      ensureLineBreak();
      console.log(`[turn] ${event.turnId} (${event.status})`);
      return;
    }

    const uiEvent = event.event;
    switch (uiEvent.event) {
      case "delta":
      case "final":
        if (uiEvent.payload.text) {
          process.stdout.write(uiEvent.payload.text);
          wroteInlineText = true;
        }
        return;
      case "tool":
        ensureLineBreak();
        console.log(`[tool:${uiEvent.payload.phase}] ${uiEvent.payload.type}`);
        return;
      case "toolInput":
        return;
      case "toolDelta":
        ensureLineBreak();
        console.log(`[tool-output] ${uiEvent.payload.text}`);
        return;
      case "retrying":
        ensureLineBreak();
        console.log(`[retrying] ${formatTurnErrorDescriptor(uiEvent.payload.errorInfo)}`);
        return;
      case "error":
        ensureLineBreak();
        console.error(`[error] ${formatTurnErrorDescriptor(uiEvent.payload.errorInfo)}`);
        return;
      case "completed":
        ensureLineBreak();
        console.log(`[completed] ${uiEvent.payload.status}`);
        return;
      default:
        ensureLineBreak();
        console.log(JSON.stringify(uiEvent));
    }
  };

  const flush = () => {
    ensureLineBreak();
  };

  return { emit, flush };
}

export function applyMachineRuntimeDefaults(
  runtimeConfig: ProgrammaticTaskRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProgrammaticTaskRuntimeConfig {
  if (!env.INTERPRETER_MACHINE_RUN_DIR?.trim()) {
    return runtimeConfig;
  }

  return {
    ...runtimeConfig,
    codexApprovalPolicy: runtimeConfig.codexApprovalPolicy ?? "never",
    codexSandboxMode: runtimeConfig.codexSandboxMode ?? "danger-full-access",
    codexNetworkAccess: runtimeConfig.codexNetworkAccess ?? true,
  };
}

export async function runHeadlessTaskCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cliOptions = parseCliOptions(argv);
  const workspaceError = getHeadlessTaskCliWorkspaceError(cliOptions);
  if (workspaceError) {
    throw new Error(workspaceError);
  }
  const workspace = normalizeHeadlessTaskWorkspace(cliOptions.workspace);
  approvalManager.setAutoApprove(true);
  const message = await resolveOptionalText(cliOptions.message, cliOptions.messageFile);
  const system = await resolveOptionalText(cliOptions.system, cliOptions.systemFile);
  const runtimeConfig = applyMachineRuntimeDefaults(buildProgrammaticTaskRuntimeConfig(cliOptions));
  const skills = resolveHeadlessSkillReferences(cliOptions.skills);
  if (Object.values(runtimeConfig).some((value) => value !== undefined)) {
    await applyProgrammaticTaskRuntimeConfig(runtimeConfig);
  }

  const emitter = createProgressEmitter(cliOptions.streamJsonl);

  if (cliOptions.streamJsonl && cliOptions.quietStartup) {
    console.log(JSON.stringify({ type: "config", path: getConfigPath() }));
  } else {
    console.log(`[config] ${getConfigPath()}`);
  }

  const result = await startAgentTask({
    mode: "headless",
    message,
    system,
    timeoutMs: cliOptions.timeoutMs,
    workspace,
    threadId: cliOptions.threadId,
    skills,
    notifyStarted: true,
    onProgress: emitter.emit,
  });

  emitter.flush();

  if (cliOptions.resultFile) {
    const resultPath = path.resolve(cliOptions.resultFile);
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
  }

  if (cliOptions.streamJsonl) {
    console.log(JSON.stringify({ type: "result", result }));
  } else {
    console.log(`[task] completed=${result.completed}`);
    if (result.threadId) {
      console.log(`[thread-id] ${result.threadId}`);
    }
    if (result.threadPath) {
      console.log(`[thread-path] ${result.threadPath}`);
    }
    if (result.error) {
      console.error(`[task-error] ${result.error}`);
    }
  }

  return result.completed ? 0 : 1;
}
