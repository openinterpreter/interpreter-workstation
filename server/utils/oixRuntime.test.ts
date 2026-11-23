import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getOixRuntimeCommandDir,
  getOixStandalonePaths,
  linkOixRuntimeCommandDir,
  resolveOrInstallOixRuntime,
} from "./oixRuntime";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePackage(
  packageDir: string,
  version: string,
  target = "aarch64-apple-darwin",
  entrypoint = "bin/interpreter",
): string {
  const binaryPath = path.join(packageDir, ...entrypoint.split("/"));
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  mkdirSync(path.join(packageDir, "codex-path"), { recursive: true });
  mkdirSync(path.join(packageDir, "codex-resources"), { recursive: true });
  writeFileSync(binaryPath, "#!/bin/sh\necho interpreter fixture\n");
  writeFileSync(
    path.join(packageDir, "bin", "i"),
    "#!/bin/sh\necho interpreter fixture\n",
  );
  writeFileSync(
    path.join(packageDir, "bin", "codex-code-mode-host"),
    "#!/bin/sh\nexit 0\n",
  );
  writeFileSync(
    path.join(packageDir, "codex-path", "rg"),
    "#!/bin/sh\nexit 0\n",
  );
  chmodSync(binaryPath, 0o755);
  writeFileSync(
    path.join(packageDir, "codex-package.json"),
    JSON.stringify({
      layoutVersion: 1,
      version,
      target,
      variant: "open-interpreter",
      entrypoint,
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
    }),
  );
  return binaryPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("OIX runtime command directory", () => {
  test("places the command directory inside the runtime home on each platform", () => {
    expect(getOixRuntimeCommandDir("/home/alex/.openinterpreter", "linux")).toBe(
      "/home/alex/.openinterpreter/runtime/interpreter-bin",
    );
    expect(
      getOixRuntimeCommandDir("C:\\Users\\alex\\.openinterpreter", "win32"),
    ).toBe("C:\\Users\\alex\\.openinterpreter\\runtime\\interpreter-bin");
  });

  test("links the running runtime's bin directory and follows runtime updates", async () => {
    const runtimeHome = await tempDir("oix-command-home-");
    const firstPackage = await tempDir("oix-command-first-");
    const secondPackage = await tempDir("oix-command-second-");
    const firstBinary = writePackage(firstPackage, "0.0.60");
    const secondBinary = writePackage(secondPackage, "0.0.61");
    const binaryName = path.basename(firstBinary);

    const linkPath = linkOixRuntimeCommandDir(runtimeHome, firstBinary);
    expect(linkPath).toBe(getOixRuntimeCommandDir(runtimeHome));
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(path.join(linkPath, binaryName))).toBe(
      realpathSync(firstBinary),
    );
    // Sibling executables stay next to the entrypoint.
    expect(existsSync(path.join(linkPath, "codex-code-mode-host"))).toBe(true);

    // Relinking to the same runtime is a no-op; a different runtime replaces it.
    linkOixRuntimeCommandDir(runtimeHome, firstBinary);
    linkOixRuntimeCommandDir(runtimeHome, secondBinary);
    expect(realpathSync(path.join(linkPath, binaryName))).toBe(
      realpathSync(secondBinary),
    );
  });

  test("replaces a dangling link left by a removed runtime", async () => {
    const runtimeHome = await tempDir("oix-command-dangling-");
    const packageDir = await tempDir("oix-command-package-");
    const binary = writePackage(packageDir, "0.0.61");
    const linkPath = getOixRuntimeCommandDir(runtimeHome);
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(path.join(runtimeHome, "missing-bin"), linkPath, "dir");

    linkOixRuntimeCommandDir(runtimeHome, binary);

    expect(realpathSync(linkPath)).toBe(realpathSync(path.dirname(binary)));
  });

  test("never replaces a real directory at the command directory path", async () => {
    const runtimeHome = await tempDir("oix-command-real-dir-");
    const packageDir = await tempDir("oix-command-real-package-");
    const binary = writePackage(packageDir, "0.0.61");
    const linkPath = getOixRuntimeCommandDir(runtimeHome);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(path.join(linkPath, "keep.txt"), "user file");

    expect(() => linkOixRuntimeCommandDir(runtimeHome, binary)).toThrow(
      /Refusing to replace non-link path/,
    );
    expect(readFileSync(path.join(linkPath, "keep.txt"), "utf8")).toBe(
      "user file",
    );
  });
});

describe("OIX shared runtime resolution", () => {
  test("uses the official cross-platform managed install locations", () => {
    expect(
      getOixStandalonePaths("darwin", { HOME: "/Users/alex" }, "/Users/alex"),
    ).toMatchObject({
      interpreterHome: "/Users/alex/.openinterpreter",
      managedBinary:
        "/Users/alex/.openinterpreter/packages/standalone/current/bin/interpreter",
      visibleBinary: "/Users/alex/.local/bin/interpreter",
    });
    expect(
      getOixStandalonePaths(
        "win32",
        {
          USERPROFILE: "C:\\Users\\alex",
          LOCALAPPDATA: "C:\\Users\\alex\\AppData\\Local",
        },
        "C:\\Users\\alex",
      ),
    ).toMatchObject({
      interpreterHome: "C:\\Users\\alex\\.openinterpreter",
      managedBinary:
        "C:\\Users\\alex\\.openinterpreter\\packages\\standalone\\current\\bin\\interpreter.exe",
      visibleBinary:
        "C:\\Users\\alex\\AppData\\Local\\Programs\\Open Interpreter\\bin\\interpreter.exe",
    });
  });

  test("pins the bundled app runtime without moving an existing terminal selector", async () => {
    const homeDir = await tempDir("oix-existing-home-");
    const bundleDir = await tempDir("oix-unused-bundle-");
    const interpreterHome = path.join(homeDir, ".openinterpreter");
    const releaseDir = path.join(
      interpreterHome,
      "packages",
      "standalone",
      "releases",
      "0.0.29-aarch64-apple-darwin",
    );
    const existingBinary = writePackage(releaseDir, "0.0.29");
    const currentDir = path.join(
      interpreterHome,
      "packages",
      "standalone",
      "current",
    );
    mkdirSync(path.dirname(currentDir), { recursive: true });
    symlinkSync(releaseDir, currentDir, "dir");
    writePackage(bundleDir, "0.0.34");

    const result = await resolveOrInstallOixRuntime({
      platform: "darwin",
      arch: "arm64",
      env: { HOME: homeDir, PATH: "" },
      homeDir,
      bundledPackageCandidates: [bundleDir],
      probeBinary: async () => true,
      configureTerminalPath: false,
    });

    expect(result.source).toBe("installed");
    expect(result.version).toBe("0.0.34");
    expect(realpathSync(currentDir)).toBe(realpathSync(releaseDir));
    expect(realpathSync(result.binaryPath)).not.toBe(
      realpathSync(existingBinary),
    );
    expect(
      existsSync(
        path.join(
          interpreterHome,
          "packages",
          "standalone",
          "releases",
          "0.0.34-aarch64-apple-darwin",
        ),
      ),
    ).toBe(true);
  });

  test("uses an explicit development runtime without installing the bundle", async () => {
    const homeDir = await tempDir("oix-development-home-");
    const developmentDir = await tempDir("oix-development-runtime-");
    const developmentBinary = writePackage(developmentDir, "0.0.99");
    const bundleDir = await tempDir("oix-development-bundle-");
    writePackage(bundleDir, "0.0.34");

    const result = await resolveOrInstallOixRuntime({
      platform: "darwin",
      arch: "arm64",
      env: {
        HOME: homeDir,
        PATH: "",
        INTERPRETER_OIX_PATH: developmentBinary,
      },
      homeDir,
      bundledPackageCandidates: [bundleDir],
      probeBinary: async () => true,
      configureTerminalPath: false,
    });

    expect(result.source).toBe("development");
    expect(result.version).toBe("0.0.99");
    expect(realpathSync(result.binaryPath)).toBe(
      realpathSync(developmentBinary),
    );
    expect(
      existsSync(
        path.join(homeDir, ".openinterpreter", "packages", "standalone"),
      ),
    ).toBe(false);
  });

  test("installs the bundled package into OIX managed storage when OIX is absent", async () => {
    const homeDir = await tempDir("oix-install-home-");
    const bundleDir = await tempDir("oix-install-bundle-");
    writePackage(bundleDir, "0.0.34");

    const result = await resolveOrInstallOixRuntime({
      platform: "darwin",
      arch: "arm64",
      env: { HOME: homeDir, PATH: "", SHELL: "/bin/zsh" },
      homeDir,
      bundledPackageCandidates: [bundleDir],
      probeBinary: async () => true,
      configureTerminalPath: true,
    });
    const paths = getOixStandalonePaths("darwin", { HOME: homeDir }, homeDir);

    expect(result.source).toBe("installed");
    expect(result.version).toBe("0.0.34");
    expect(result.packageDir).toBe(
      path.join(paths.releasesDir, "0.0.34-aarch64-apple-darwin"),
    );
    expect(realpathSync(paths.managedBinary)).toBe(
      realpathSync(result.binaryPath),
    );
    expect(realpathSync(paths.visibleBinary)).toBe(
      realpathSync(result.binaryPath),
    );
    expect(
      readFileSync(path.join(result.packageDir, "codex-package.json"), "utf8"),
    ).toContain("open-interpreter");
    expect(readFileSync(path.join(homeDir, ".zprofile"), "utf8")).toContain(
      `export PATH="${paths.visibleBinDir}:$PATH"`,
    );
    expect(readFileSync(paths.terminalOwnershipFile, "utf8")).toContain(
      '"version":"0.0.34"',
    );

    const currentInode = lstatSync(paths.currentDir).ino;
    const visibleInode = lstatSync(paths.visibleBinary).ino;
    await resolveOrInstallOixRuntime({
      platform: "darwin",
      arch: "arm64",
      env: { HOME: homeDir, PATH: "", SHELL: "/bin/zsh" },
      homeDir,
      bundledPackageCandidates: [bundleDir],
      probeBinary: async () => true,
      configureTerminalPath: true,
    });
    expect(lstatSync(paths.currentDir).ino).toBe(currentInode);
    expect(lstatSync(paths.visibleBinary).ino).toBe(visibleInode);
  });

  test("serializes concurrent installs into the same managed home", async () => {
    const homeDir = await tempDir("oix-concurrent-install-home-");
    const bundleDir = await tempDir("oix-concurrent-install-bundle-");
    writePackage(bundleDir, "0.0.34");
    const options = {
      platform: "darwin" as const,
      arch: "arm64",
      env: { HOME: homeDir, PATH: "", SHELL: "/bin/zsh" },
      homeDir,
      bundledPackageCandidates: [bundleDir],
      probeBinary: async () => true,
      configureTerminalPath: false,
    };

    const [first, second] = await Promise.all([
      resolveOrInstallOixRuntime(options),
      resolveOrInstallOixRuntime(options),
    ]);
    const paths = getOixStandalonePaths("darwin", options.env, homeDir);

    expect(first.binaryPath).toBe(second.binaryPath);
    expect(realpathSync(paths.managedBinary)).toBe(
      realpathSync(first.binaryPath),
    );
    expect(readFileSync(paths.terminalOwnershipFile, "utf8")).toContain(
      '"version":"0.0.34"',
    );
  });

  test("serializes installs from separate app processes", async () => {
    const homeDir = await tempDir("oix-cross-process-install-home-");
    const bundleDir = await tempDir("oix-cross-process-install-bundle-");
    const targetArch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const target =
      process.platform === "win32"
        ? `${targetArch}-pc-windows-msvc`
        : process.platform === "darwin"
          ? `${targetArch}-apple-darwin`
          : `${targetArch}-unknown-linux-gnu`;
    const entrypoint =
      process.platform === "win32" ? "bin/interpreter.exe" : "bin/interpreter";
    writePackage(bundleDir, "0.0.34", target, entrypoint);
    const runtimeModule = new URL("./oixRuntime.ts", import.meta.url).href;
    const worker = `
      const { resolveOrInstallOixRuntime } = await import(process.env.OIX_RUNTIME_MODULE);
      await resolveOrInstallOixRuntime({
        platform: process.platform,
        arch: process.arch,
        env: {
          ...process.env,
          HOME: process.env.OIX_TEST_HOME,
          USERPROFILE: process.env.OIX_TEST_HOME,
          LOCALAPPDATA: process.env.OIX_TEST_LOCAL_APP_DATA,
          PATH: "",
          SHELL: "/bin/zsh",
        },
        homeDir: process.env.OIX_TEST_HOME,
        bundledPackageCandidates: [process.env.OIX_TEST_BUNDLE],
        probeBinary: async () => {
          await Bun.sleep(250);
          return true;
        },
        configureTerminalPath: false,
      });
    `;
    const spawnWorker = () =>
      Bun.spawn([process.execPath, "-e", worker], {
        env: {
          ...process.env,
          OIX_RUNTIME_MODULE: runtimeModule,
          OIX_TEST_HOME: homeDir,
          OIX_TEST_BUNDLE: bundleDir,
          OIX_TEST_LOCAL_APP_DATA: path.join(homeDir, "AppData", "Local"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

    const workers = [spawnWorker(), spawnWorker()];
    const results = await Promise.all(
      workers.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results).toEqual([
      { exitCode: 0, stderr: "" },
      { exitCode: 0, stderr: "" },
    ]);

    const paths = getOixStandalonePaths(
      process.platform,
      {
        HOME: homeDir,
        USERPROFILE: homeDir,
        LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
        PATH: "",
      },
      homeDir,
    );
    expect(realpathSync(paths.managedBinary)).toBe(
      realpathSync(
        path.join(
          paths.releasesDir,
          `0.0.34-${target}`,
          ...entrypoint.split("/"),
        ),
      ),
    );
    expect(
      existsSync(path.join(paths.standaloneRoot, ".workstation-install.lock")),
    ).toBe(false);
  });

  test("advances the terminal with app updates while Workstation still owns it", async () => {
    const homeDir = await tempDir("oix-owned-update-home-");
    const firstBundle = await tempDir("oix-owned-update-first-");
    const secondBundle = await tempDir("oix-owned-update-second-");
    writePackage(firstBundle, "0.0.34");
    writePackage(secondBundle, "0.0.35");
    const options = {
      platform: "darwin" as const,
      arch: "arm64",
      env: { HOME: homeDir, PATH: "", SHELL: "/bin/zsh" },
      homeDir,
      probeBinary: async () => true,
      configureTerminalPath: false,
    };

    await resolveOrInstallOixRuntime({
      ...options,
      bundledPackageCandidates: [firstBundle],
    });
    const second = await resolveOrInstallOixRuntime({
      ...options,
      bundledPackageCandidates: [secondBundle],
    });
    const paths = getOixStandalonePaths("darwin", options.env, homeDir);

    expect(second.version).toBe("0.0.35");
    expect(realpathSync(paths.managedBinary)).toBe(
      realpathSync(second.binaryPath),
    );
    expect(readFileSync(paths.terminalOwnershipFile, "utf8")).toContain(
      '"version":"0.0.35"',
    );
  });

  test("does not move the terminal after it updates independently", async () => {
    const homeDir = await tempDir("oix-independent-update-home-");
    const firstBundle = await tempDir("oix-independent-update-first-");
    const nextAppBundle = await tempDir("oix-independent-update-app-");
    writePackage(firstBundle, "0.0.34");
    writePackage(nextAppBundle, "0.0.36");
    const options = {
      platform: "darwin" as const,
      arch: "arm64",
      env: { HOME: homeDir, PATH: "", SHELL: "/bin/zsh" },
      homeDir,
      probeBinary: async () => true,
      configureTerminalPath: false,
    };

    await resolveOrInstallOixRuntime({
      ...options,
      bundledPackageCandidates: [firstBundle],
    });
    const paths = getOixStandalonePaths("darwin", options.env, homeDir);
    const terminalRelease = path.join(
      paths.releasesDir,
      "0.0.35-aarch64-apple-darwin",
    );
    const terminalBinary = writePackage(terminalRelease, "0.0.35");
    rmSync(paths.currentDir, { recursive: true, force: true });
    symlinkSync(terminalRelease, paths.currentDir, "dir");

    const appRuntime = await resolveOrInstallOixRuntime({
      ...options,
      bundledPackageCandidates: [nextAppBundle],
    });

    expect(appRuntime.version).toBe("0.0.36");
    expect(realpathSync(appRuntime.binaryPath)).not.toBe(
      realpathSync(terminalBinary),
    );
    expect(realpathSync(paths.managedBinary)).toBe(
      realpathSync(terminalBinary),
    );
    expect(existsSync(paths.terminalOwnershipFile)).toBe(false);
  });

  test("does not use a non-OIX interpreter on PATH as the app runtime", async () => {
    const homeDir = await tempDir("oix-path-home-");
    const unrelatedBinDir = await tempDir("oix-unrelated-bin-");
    const unrelatedBinary = path.join(unrelatedBinDir, "interpreter");
    writeFileSync(unrelatedBinary, "#!/bin/sh\necho unrelated\n");
    chmodSync(unrelatedBinary, 0o755);
    const bundleDir = await tempDir("oix-path-bundle-");
    writePackage(bundleDir, "0.0.34");

    const result = await resolveOrInstallOixRuntime({
      platform: "darwin",
      arch: "arm64",
      env: { HOME: homeDir, PATH: unrelatedBinDir },
      homeDir,
      bundledPackageCandidates: [bundleDir],
      probeBinary: async (candidate) => candidate !== unrelatedBinary,
      configureTerminalPath: false,
    });

    expect(result.source).toBe("installed");
    expect(result.binaryPath).not.toBe(unrelatedBinary);
  });

  test("fails clearly when neither an existing nor bundled OIX is valid", async () => {
    const homeDir = await tempDir("oix-missing-home-");
    await expect(
      resolveOrInstallOixRuntime({
        platform: "darwin",
        arch: "arm64",
        env: { HOME: homeDir, PATH: "" },
        homeDir,
        bundledPackageCandidates: [],
        probeBinary: async () => false,
        configureTerminalPath: false,
      }),
    ).rejects.toThrow("No valid bundled Open Interpreter runtime was found");
  });

  test("rejects package metadata that could escape the managed releases directory", async () => {
    const homeDir = await tempDir("oix-unsafe-home-");
    const bundleDir = await tempDir("oix-unsafe-bundle-");
    writePackage(bundleDir, "0.0.34", "../../outside");

    await expect(
      resolveOrInstallOixRuntime({
        platform: "darwin",
        arch: "arm64",
        env: { HOME: homeDir, PATH: "" },
        homeDir,
        bundledPackageCandidates: [bundleDir],
        probeBinary: async () => false,
        configureTerminalPath: false,
      }),
    ).rejects.toThrow("No valid bundled Open Interpreter runtime was found");
    expect(existsSync(path.join(homeDir, "outside"))).toBe(false);
  });
});
