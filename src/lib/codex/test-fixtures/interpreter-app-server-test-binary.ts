import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const INTERPRETER_BINARY_NAME =
  process.platform === "win32" ? "interpreter.exe" : "interpreter";

export const INTERPRETER_APP_SERVER_TEST_BINARY = join(
  ROOT,
  "resources",
  "oix",
  `${process.platform}-${process.arch}`,
  "bin",
  INTERPRETER_BINARY_NAME,
);

export const interpreterAppServerTestBinaryAvailable = existsSync(
  INTERPRETER_APP_SERVER_TEST_BINARY,
);

export function spawnInterpreterAppServerForTest(
  args: string[],
  env: NodeJS.ProcessEnv,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  return spawn(INTERPRETER_APP_SERVER_TEST_BINARY, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, ...extraEnv },
  });
}
