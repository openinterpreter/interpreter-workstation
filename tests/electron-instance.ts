import { _electron as electron, ElectronApplication } from "@playwright/test";
import path from "path";
import os from "os";
import { execFileSync, execSync } from "child_process";
import { getTestRunDir } from "./test-recorder";
import { getTestConfig } from "./test-config";
import fs from "fs";

/**
 * Global Electron instance manager
 * This ensures ONE Electron instance is shared across ALL tests
 * Automatically recovers from crashes by re-launching
 */
class ElectronInstanceManager {
  private static instance: ElectronApplication | null = null;
  private static launchCount = 0;
  private static isAlive = false;
  private static launchSignature: string | null = null;
  private static lastValidatedSourceMtimeMs: number | null = null;
  private static lastBuiltOutputMtimeMs: number | null = null;
  private static readonly TEST_RUN_ID_FLAG_PREFIX = "--playwright-test-run-id=";

  private static getDefaultInterpreterAppSupportDir(): string {
    if (process.platform === "darwin") {
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "interpreter",
      );
    }

    return "";
  }

  private static readonly SOURCE_PATHS = [
    "agent",
    "apps",
    "electron",
    "server",
    "shared",
    "src",
    "build-electron.mjs",
    "package.json",
    "playwright.config.ts",
    "vite.config.ts",
  ];

  private static readonly OUTPUT_PATHS = [
    path.join("dist", "index.html"),
    path.join("dist-electron", "electron", "main.cjs"),
  ];

  private static readonly SOURCE_FILE_EXTENSIONS = new Set([
    ".cjs",
    ".css",
    ".html",
    ".js",
    ".json",
    ".mjs",
    ".rs",
    ".swift",
    ".ts",
    ".tsx",
  ]);

  private static listProcesses(): Array<{ pid: number; command: string }> {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf-8" },
      );

      const parsed = JSON.parse(output || "[]") as
        | Array<{ ProcessId?: number | string; CommandLine?: string | null }>
        | { ProcessId?: number | string; CommandLine?: string | null };
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      return entries
        .map((entry) => ({
          pid: Number(entry.ProcessId),
          command:
            typeof entry.CommandLine === "string" ? entry.CommandLine : "",
        }))
        .filter(
          (entry) =>
            Number.isFinite(entry.pid) &&
            entry.pid > 0 &&
            entry.command.length > 0,
        );
    }

    const output = execSync("ps -axo pid=,command=", { encoding: "utf-8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) {
          return null;
        }

        return {
          pid: Number(match[1]),
          command: match[2],
        };
      })
      .filter(
        (entry): entry is { pid: number; command: string } => entry !== null,
      );
  }

  private static getNewestMtimeMs(targetPath: string): number {
    const stats = fs.statSync(targetPath);
    if (stats.isFile()) {
      const extension = path.extname(targetPath);
      return this.SOURCE_FILE_EXTENSIONS.has(extension) ? stats.mtimeMs : 0;
    }

    let newest = stats.mtimeMs;
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      if (
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "dist-electron" ||
        entry.name === "node_modules" ||
        entry.name === "target" ||
        entry.name === "test-runs"
      ) {
        continue;
      }

      const childPath = path.join(targetPath, entry.name);
      const childNewest = this.getNewestMtimeMs(childPath);
      if (childNewest > newest) {
        newest = childNewest;
      }
    }
    return newest;
  }

  private static getNewestSourceMtimeMs(): number {
    let newest = 0;
    for (const relativePath of this.SOURCE_PATHS) {
      const absolutePath = path.join(process.cwd(), relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const candidate = this.getNewestMtimeMs(absolutePath);
      if (candidate > newest) {
        newest = candidate;
      }
    }
    return newest;
  }

  private static getOldestOutputMtimeMs(): number | null {
    let oldest = Number.POSITIVE_INFINITY;
    for (const relativePath of this.OUTPUT_PATHS) {
      const absolutePath = path.join(process.cwd(), relativePath);
      if (!fs.existsSync(absolutePath)) {
        return null;
      }
      const stats = fs.statSync(absolutePath);
      oldest = Math.min(oldest, stats.mtimeMs);
    }
    return Number.isFinite(oldest) ? oldest : null;
  }

  private static ensureFreshBuild(): void {
    if (process.env.INTERPRETER_SKIP_TEST_ELECTRON_REBUILD === "1") {
      return;
    }

    const newestSourceMtimeMs = this.getNewestSourceMtimeMs();
    const oldestOutputMtimeMs = this.getOldestOutputMtimeMs();

    const alreadyValidated =
      this.lastValidatedSourceMtimeMs === newestSourceMtimeMs &&
      this.lastBuiltOutputMtimeMs != null &&
      oldestOutputMtimeMs != null &&
      this.lastBuiltOutputMtimeMs === oldestOutputMtimeMs;

    if (alreadyValidated) {
      return;
    }

    const needsBuild =
      oldestOutputMtimeMs == null || oldestOutputMtimeMs < newestSourceMtimeMs;

    if (needsBuild) {
      console.log(
        "🔨 Detected stale Electron test build, rebuilding before launch...",
      );
      execSync("pnpm run build:locked", {
        cwd: process.cwd(),
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_ENV: "production",
        },
      });
    }

    this.lastValidatedSourceMtimeMs = newestSourceMtimeMs;
    this.lastBuiltOutputMtimeMs = this.getOldestOutputMtimeMs();
  }

  private static getLaunchConfig() {
    const fakeAudioPath = process.env.TEST_FAKE_AUDIO_FILE?.trim();
    const fakeAsrText = process.env.TEST_FAKE_ASR_TEXT?.trim();
    const qwenInstallRoot = process.env.TEST_QWEN_ASR_INSTALL_ROOT?.trim();
    const moonshineInstallRoot =
      process.env.TEST_MOONSHINE_INSTALL_ROOT?.trim();
    const ttsInstallRoot = process.env.TEST_TTS_INSTALL_ROOT?.trim();
    const testRunIdFlag = `${this.TEST_RUN_ID_FLAG_PREFIX}${path.basename(getTestRunDir())}`;
    const args = [
      getTestConfig().electronMainPath,
      testRunIdFlag,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-software-rasterizer",
      "--disable-setuid-sandbox",
      "--disable-extensions",
    ];

    if (fakeAudioPath) {
      const fakeAudioCapturePath = fakeAudioPath.endsWith("%noloop")
        ? fakeAudioPath
        : `${fakeAudioPath}%noloop`;
      args.push(
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${fakeAudioCapturePath}`,
      );
      console.log(`🎤 Using fake audio capture file: ${fakeAudioCapturePath}`);
    }

    const signature = JSON.stringify({
      fakeAudioPath: fakeAudioPath || null,
      fakeAsrText: fakeAsrText || null,
      qwenInstallRoot: qwenInstallRoot || null,
      moonshineInstallRoot: moonshineInstallRoot || null,
      ttsInstallRoot: ttsInstallRoot || null,
      formTestsMode: process.env.FORM_TESTS_MODE || null,
      formTestsDebugPort: process.env.FORM_TESTS_DEBUG_PORT || null,
      overlayDebugPort: process.env.INTERPRETER_OVERLAY_DEBUG_PORT || null,
      overlayDebugToken: process.env.INTERPRETER_OVERLAY_DEBUG_TOKEN || null,
      disableAdvancedVoiceCreateCall:
        process.env.INTERPRETER_OVERLAY_DISABLE_ADVANCED_VOICE_CREATE_CALL || null,
    });

    return { args, signature, testRunIdFlag };
  }

  private static async killStalePlaywrightElectronProcesses(): Promise<void> {
    try {
      const { testRunIdFlag } = this.getLaunchConfig();
      const stalePids = this.listProcesses()
        .map(({ pid, command }) => {
          const isPlaywrightElectron =
            command.includes("playwright-core/lib/server/electron/loader.js") &&
            command.includes("dist-electron/electron/main.cjs");
          const belongsToCurrentRun = command.includes(testRunIdFlag);

          if (
            !isPlaywrightElectron ||
            !belongsToCurrentRun ||
            pid === process.pid
          ) {
            return null;
          }

          return pid;
        })
        .filter((pid): pid is number => pid !== null);

      if (stalePids.length === 0) return;

      console.log(
        `🧹 Found ${stalePids.length} stale Electron process(es): ${stalePids.join(", ")}`,
      );

      for (const pid of stalePids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process may have exited between scan and kill
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 800));

      for (const pid of stalePids) {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
          console.log(`🧹 Force-killed stale Electron pid ${pid}`);
        } catch {
          // Already gone
        }
      }
    } catch (error) {
      console.warn(
        "⚠️  Failed to check/cleanup stale Electron processes:",
        error,
      );
    }
  }

  private static async launchNewInstance(): Promise<ElectronApplication> {
    this.launchCount++;
    console.log(
      `🚀 Launching shared Electron instance (launch #${this.launchCount})...`,
    );
    this.ensureFreshBuild();
    await this.killStalePlaywrightElectronProcesses();

    const testRunDir = getTestRunDir();
    const logsDir = path.join(testRunDir, "logs");
    const sessionLogPath = path.join(logsDir, "session.log");

    // Print log file path immediately
    console.log(`📝 Session log: ${sessionLogPath}`);

    const { args, signature } = this.getLaunchConfig();
    const envEntries = Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    const launchEnv: Record<string, string> = {
      ...Object.fromEntries(envEntries),
      ...(process.platform === "darwin"
        ? {
            INTERPRETER_HOME:
              process.env.INTERPRETER_HOME?.trim() ||
              this.getDefaultInterpreterAppSupportDir(),
            INTERPRETER_USER_DATA_DIR:
              process.env.INTERPRETER_USER_DATA_DIR?.trim() ||
              this.getDefaultInterpreterAppSupportDir(),
          }
        : {}),
      NODE_ENV: "test",
      INTERPRETER_APP_NAME: process.env.INTERPRETER_APP_NAME || "Interpreter",
      INTERPRETER_DEV_APP_NAME:
        process.env.INTERPRETER_DEV_APP_NAME || "Interpreter",
      PLAYWRIGHT_ELECTRON_REPL: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      NODE_V8_COVERAGE: path.join(testRunDir, "coverage-backend"),
      LOG_FILE: sessionLogPath,
    };
    if (process.env.SHOW_WINDOW !== undefined) {
      launchEnv.SHOW_WINDOW = process.env.SHOW_WINDOW;
    } else if (process.platform === "win32") {
      launchEnv.SHOW_WINDOW = "1";
    }

    const app = await electron.launch({
      args,
      env: launchEnv,
      timeout: 600000,
    });

    // Track when app exits so we know to re-launch
    this.isAlive = true;
    this.launchSignature = signature;
    app.on("close", () => {
      console.log(
        "⚠️  Electron app closed/crashed - will re-launch on next test",
      );
      this.isAlive = false;
      this.instance = null;
    });

    console.log(
      `✅ Shared Electron instance ready (total launches: ${this.launchCount})`,
    );
    return app;
  }

  static async getInstance(): Promise<ElectronApplication> {
    const { signature } = this.getLaunchConfig();

    if (this.instance && this.isAlive && this.launchSignature !== signature) {
      console.log(
        "🔄 Electron launch options changed; relaunching shared instance...",
      );
      try {
        await this.instance.close();
      } catch (error) {
        console.error("Error closing Electron for relaunch:", error);
      }
      this.isAlive = false;
      this.instance = null;
      this.launchSignature = null;
    }

    if (!this.instance || !this.isAlive) {
      if (this.instance && !this.isAlive) {
        console.log("🔄 Previous Electron instance died, launching new one...");
      }
      this.instance = await this.launchNewInstance();
    } else {
      console.log(
        `♻️  Reusing existing Electron instance (total launches: ${this.launchCount})`,
      );
    }

    return this.instance;
  }

  /**
   * Mark the current instance as dead so next getInstance() will launch fresh
   * Call this when you detect the app has crashed (e.g., page operations fail)
   */
  static invalidate() {
    console.log("🔥 Invalidating Electron instance (detected crash)");
    this.isAlive = false;
    this.instance = null;
    this.launchSignature = null;
  }

  static async cleanup() {
    if (this.instance) {
      console.log("🔄 Closing shared Electron instance...");
      try {
        await this.instance.close();
        console.log("✅ Shared Electron instance closed");
      } catch (error) {
        console.error("Error closing Electron:", error);
      }
      this.instance = null;
    }
    this.isAlive = false;
    this.launchSignature = null;

    await this.killStalePlaywrightElectronProcesses();
  }
}

export { ElectronInstanceManager };
