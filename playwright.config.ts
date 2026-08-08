import { defineConfig } from "@playwright/test";
import path from "path";

import fs from "fs";
import { fileURLToPath } from "url";
import os from "os";
import { normalizeCoverageFileUrl } from "./tests/coverage-urls";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const smokeSpecs = [
  "**/placeholder.spec.ts",
  "**/interpreter-identity.spec.ts",
  "**/file-open.spec.ts",
  "**/onboarding-first-run.spec.ts",
  "**/settings-hosted-model-picker.spec.ts",
  "**/pane-system.spec.ts",
];
const deterministicSpecs = [
  "**/workspace-switching.spec.ts",
  "**/agent-file-drop.spec.ts",
  "**/agent-file-permissions.spec.ts",
  "**/markdown-autosave-no-diff.spec.ts",
  "**/pdf-annotation-interactions.spec.ts",
  "**/reasoning-profile-switch.spec.ts",
];
const externalSpecs = [
  "**/agent-shell-permissions.spec.ts",
  "**/interpreter-managed-gpt54-mini.spec.ts",
  "**/media-ai-gpt-image-2.spec.ts",
];
const voiceDeterministicSpecs = [
  "**/voice-mode.spec.ts",
  "**/new-tab-voice-mode.spec.ts",
  "**/voice-ambient-ignore.spec.ts",
  "**/voice-ambient-send.spec.ts",
];
const voiceLiveSpecs = [
  "**/voice-realistic-commands.spec.ts",
  "**/voice-streaming-latency.spec.ts",
  "**/voice-pipeline-durability.spec.ts",
  "**/voice-latency-metrics.spec.ts",
];
const nonNightlySpecs = [
  ...smokeSpecs,
  ...deterministicSpecs,
  ...externalSpecs,
  ...voiceDeterministicSpecs,
  ...voiceLiveSpecs,
];

// Global test configuration constants
export const TEST_RETRY_COUNT = 0; // No retries - fail fast for debugging

const canUseMonocartReporter = (() => {
  try {
    // NOTE(victor): monocart-reporter crashes if os.cpus() returns empty array (some CI environments).
    // Also crashes if os.uptime() fails with EPERM (sandboxed environments).
    const hasCpus = Boolean(os.cpus?.()?.[0]?.model);
    if (!hasCpus) return false;
    // Test uptime - this will throw EPERM in sandboxed environments
    os.uptime();
    return true;
  } catch {
    return false;
  }
})();

// Create timestamped test run directory
const timestamp = new Date()
  .toISOString()
  .replace(/:/g, "-")
  .replace(/\./g, "-")
  .slice(0, 19);
const testRunDir = path.join(process.cwd(), "test-runs", timestamp);

// Create directories
fs.mkdirSync(path.join(testRunDir, "coverage"), { recursive: true });
fs.mkdirSync(path.join(testRunDir, "test-results"), { recursive: true });
fs.mkdirSync(path.join(testRunDir, "videos"), { recursive: true });
fs.mkdirSync(path.join(testRunDir, "logs"), { recursive: true });

// Write testRunDir to file for test-recorder to read
fs.writeFileSync(path.join(testRunDir, ".test-run-dir"), testRunDir);

// Print test run directory information
console.log("\n🧪 TEST RUN STARTED");
console.log(`📁 Test run directory: ${testRunDir}`);
console.log(`📝 Session log: ${path.join(testRunDir, "logs", "session.log")}`);
console.log(
  `📝 Per-test logs: ${path.join(testRunDir, "logs", "<test-name>.log")}`,
);
console.log(`📹 Videos:   ${path.join(testRunDir, "videos")}`);
console.log(`📊 Coverage: ${path.join(testRunDir, "coverage", "index.html")}`);
console.log(
  "💡 All logs are unified - frontend, backend, and Playwright events",
);
console.log("   are interleaved chronologically in each test log file.\n");

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: TEST_RETRY_COUNT,
  workers: 1,
  maxFailures: 2,
  globalTeardown: path.join(__dirname, "tests", "global-teardown.ts"),
  reporter: [
    ["list", { printSteps: false }],
    ["./tests/log-reporter.ts"],
    ...(canUseMonocartReporter
      ? [
          [
            "monocart-reporter",
            {
              name: "Interpreter E2E Coverage Report",
              outputFile: path.join(testRunDir, "coverage/index.html"),
              coverage: {
                v8Dir: [path.join(testRunDir, "coverage-backend")],
                sourceFilter: (sourcePath: string) => {
                  if (sourcePath.includes("/src/")) return true;
                  if (sourcePath.includes("/agent/")) return true;
                  if (sourcePath.includes("/server/")) return true;
                  if (sourcePath.includes("/electron/")) return true;
                  return false;
                },
                entryFilter: (entry: any) => {
                  if (entry.url.includes("node_modules")) return false;
                  if (entry.url.includes(".spec.")) return false;
                  if (entry.url.includes("/tests/")) return false;
                  return true;
                },
                outputDir: path.join(testRunDir, "coverage"),
                reports: [
                  ["v8"],
                  ["console-details"],
                  ["html"],
                  ["lcovonly", { file: "coverage.lcov" }],
                  ["text-summary", { file: null }],
                ],
                sourceMapResolver: async (
                  url: string,
                  defaultResolver: (resolvedUrl: string) => Promise<unknown>,
                ) => {
                  try {
                    return await defaultResolver(normalizeCoverageFileUrl(url));
                  } catch (error) {
                    if (
                      error instanceof TypeError &&
                      error.message.includes("File URL path must be absolute")
                    ) {
                      return undefined;
                    }
                    throw error;
                  }
                },
                sourceMap: true,
                watermarks: {
                  statements: [50, 80],
                  functions: [50, 80],
                  branches: [50, 80],
                  lines: [50, 80],
                },
              },
            },
          ] as const,
        ]
      : []),
  ],
  // CRITICAL: DO NOT CHANGE THIS TIMEOUT
  // The agent uses Groq which has ~2-3 second latency per request.
  // If a test takes longer than 30 seconds, there is a bug in the agent or tools.
  // Tests MUST complete within 30 seconds or they fail - this catches performance regressions.
  timeout: 30000, // 30 seconds - DO NOT INCREASE
  outputDir: path.join(testRunDir, "test-results"),
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure", // Screenshot on failure
    video: "retain-on-failure", // Video recording on failure
  },
  projects: [
    {
      name: "smoke",
      testMatch: smokeSpecs,
    },
    {
      name: "deterministic",
      testMatch: deterministicSpecs,
    },
    {
      name: "nightly",
      testMatch: /.*\.spec\.ts/,
      testIgnore: nonNightlySpecs,
    },
    {
      name: "external",
      testMatch: externalSpecs,
      retries: 1,
    },
    {
      name: "voice-deterministic",
      testMatch: voiceDeterministicSpecs,
    },
    {
      name: "voice-live",
      testMatch: voiceLiveSpecs,
    },
  ],
  // Live hosted-API tests use an already-running service selected with
  // INTERPRETER_HOSTED_API_BASE_URL (or USE_LOCAL_API + PYTHON_API_PORT).
  // This repository never assumes a private sibling service checkout.
});
