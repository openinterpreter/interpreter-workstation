import { execFile } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveInterpreterHome } from "../../shared/interpreterHome";
import {
  resolveBundledResourceCandidates,
  uniquePaths,
} from "./bundledRuntimePaths";

const execFileAsync = promisify(execFile);
const PACKAGE_METADATA_FILE = "codex-package.json";
const WORKSTATION_TERMINAL_OWNER_FILE = "workstation-terminal.json";
const STANDALONE_SUBDIR = ["packages", "standalone"] as const;
const PROFILE_BLOCK_BEGIN = "# >>> Open Interpreter installer >>>";
const PROFILE_BLOCK_END = "# <<< Open Interpreter installer <<<";
const VALID_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VALID_TARGET = /^[0-9A-Za-z_.-]+$/;
const INSTALL_LOCK_DIR = ".workstation-install.lock";
const INSTALL_LOCK_OWNER_FILE = "owner.json";
const INSTALL_LOCK_RETRY_MS = 100;
const INSTALL_LOCK_TIMEOUT_MS = 120_000;
const INSTALL_LOCK_ORPHAN_MS = 10 * 60_000;
const installTails = new Map<string, Promise<void>>();

type OixPackageMetadata = {
  version: string;
  target: string;
  variant: "open-interpreter";
  entrypoint: string;
};

export type OixRuntimeResolution = {
  binaryPath: string;
  packageDir: string;
  source: "development" | "installed";
  version: string;
};

type ResolveOixRuntimeOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  bundledPackageCandidates?: string[];
  probeBinary?: (binaryPath: string) => Promise<boolean>;
  configureTerminalPath?: boolean;
};

type InstallLockOwner = {
  pid: number;
  acquiredAt: string;
};

function processIsRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function readInstallLockOwner(lockDir: string): InstallLockOwner | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(lockDir, INSTALL_LOCK_OWNER_FILE), "utf8"),
    ) as Partial<InstallLockOwner>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }
    return parsed as InstallLockOwner;
  } catch {
    return null;
  }
}

function lockDirectoryIsOrphaned(lockDir: string): boolean {
  const owner = readInstallLockOwner(lockDir);
  if (owner) {
    const acquiredAt = Date.parse(owner.acquiredAt);
    return (
      !processIsRunning(owner.pid) ||
      (Number.isFinite(acquiredAt) &&
        Date.now() - acquiredAt > INSTALL_LOCK_ORPHAN_MS)
    );
  }
  try {
    return Date.now() - statSync(lockDir).mtimeMs > INSTALL_LOCK_ORPHAN_MS;
  } catch {
    return false;
  }
}

async function acquireInstallFilesystemLock(
  standaloneRoot: string,
): Promise<() => void> {
  mkdirSync(standaloneRoot, { recursive: true });
  const lockDir = path.join(standaloneRoot, INSTALL_LOCK_DIR);
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(
          path.join(lockDir, INSTALL_LOCK_OWNER_FILE),
          `${JSON.stringify({
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          } satisfies InstallLockOwner)}\n`,
        );
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    if (lockDirectoryIsOrphaned(lockDir)) {
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const owner = readInstallLockOwner(lockDir);
      throw new Error(
        `[oix-runtime] Timed out waiting for the managed runtime install lock at ${lockDir}` +
          (owner
            ? ` (held by pid ${owner.pid} since ${owner.acquiredAt})`
            : ""),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, INSTALL_LOCK_RETRY_MS));
  }
}

async function withInstallLock<T>(
  standaloneRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = installTails.get(standaloneRoot) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  installTails.set(standaloneRoot, tail);

  await previous;
  let releaseFilesystemLock: (() => void) | undefined;
  try {
    releaseFilesystemLock = await acquireInstallFilesystemLock(standaloneRoot);
    return await operation();
  } finally {
    try {
      releaseFilesystemLock?.();
    } finally {
      release();
      if (installTails.get(standaloneRoot) === tail) {
        installTails.delete(standaloneRoot);
      }
    }
  }
}

function pathApi(
  platform: NodeJS.Platform,
): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "interpreter.exe" : "interpreter";
}

function readPackageMetadata(
  packageDir: string,
  platform: NodeJS.Platform,
): OixPackageMetadata | null {
  const platformPath = pathApi(platform);
  try {
    const parsed = JSON.parse(
      readFileSync(
        platformPath.join(packageDir, PACKAGE_METADATA_FILE),
        "utf8",
      ),
    ) as Partial<OixPackageMetadata>;
    if (
      parsed.variant !== "open-interpreter" ||
      typeof parsed.version !== "string" ||
      !VALID_VERSION.test(parsed.version) ||
      typeof parsed.target !== "string" ||
      !VALID_TARGET.test(parsed.target) ||
      typeof parsed.entrypoint !== "string" ||
      parsed.entrypoint.length === 0 ||
      platformPath.isAbsolute(parsed.entrypoint) ||
      parsed.entrypoint.split(/[\\/]/).includes("..")
    ) {
      return null;
    }

    const binaryPath = platformPath.join(packageDir, parsed.entrypoint);
    if (!existsSync(binaryPath)) {
      return null;
    }

    return parsed as OixPackageMetadata;
  } catch {
    return null;
  }
}

function packageForBinary(
  binaryPath: string,
  platform: NodeJS.Platform,
): {
  packageDir: string;
  metadata: OixPackageMetadata;
} | null {
  const platformPath = pathApi(platform);
  try {
    const realBinaryPath = realpathSync(binaryPath);
    const packageDir = platformPath.dirname(
      platformPath.dirname(realBinaryPath),
    );
    const metadata = readPackageMetadata(packageDir, platform);
    if (!metadata) {
      return null;
    }
    const declaredBinary = realpathSync(
      platformPath.join(packageDir, metadata.entrypoint),
    );
    if (declaredBinary !== realBinaryPath) {
      return null;
    }
    return { packageDir, metadata };
  } catch {
    return null;
  }
}

export function getOixStandalonePaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = platform === "win32"
    ? (env.USERPROFILE ?? env.HOME ?? os.homedir())
    : (env.HOME ?? env.USERPROFILE ?? os.homedir()),
): {
  interpreterHome: string;
  standaloneRoot: string;
  releasesDir: string;
  currentDir: string;
  managedBinary: string;
  visibleBinDir: string;
  visibleBinary: string;
  terminalOwnershipFile: string;
} {
  const platformPath = pathApi(platform);
  const interpreterHome = resolveInterpreterHome(platform, env, homeDir);
  const standaloneRoot = platformPath.join(
    interpreterHome,
    ...STANDALONE_SUBDIR,
  );
  const releasesDir = platformPath.join(standaloneRoot, "releases");
  const currentDir = platformPath.join(standaloneRoot, "current");
  const visibleBinDir =
    env.OPEN_INTERPRETER_INSTALL_DIR?.trim() ||
    (platform === "win32"
      ? platformPath.join(
          env.LOCALAPPDATA ?? platformPath.join(homeDir, "AppData", "Local"),
          "Programs",
          "Open Interpreter",
          "bin",
        )
      : platformPath.join(homeDir, ".local", "bin"));

  return {
    interpreterHome,
    standaloneRoot,
    releasesDir,
    currentDir,
    managedBinary: platformPath.join(
      currentDir,
      "bin",
      executableName(platform),
    ),
    visibleBinDir,
    visibleBinary: platformPath.join(visibleBinDir, executableName(platform)),
    terminalOwnershipFile: platformPath.join(
      standaloneRoot,
      WORKSTATION_TERMINAL_OWNER_FILE,
    ),
  };
}

function pathCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const platformPath = pathApi(platform);
  const pathValue =
    Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ??
    "";
  const names =
    platform === "win32"
      ? ["interpreter.exe", "interpreter.cmd", "interpreter.bat"]
      : ["interpreter"];
  return pathValue
    .split(platformPath.delimiter)
    .filter(Boolean)
    .flatMap((entry) => names.map((name) => platformPath.join(entry, name)));
}

async function defaultProbeBinary(binaryPath: string): Promise<boolean> {
  try {
    const [
      { stdout: versionOut, stderr: versionErr },
      { stdout: helpOut, stderr: helpErr },
    ] = await Promise.all([
      execFileAsync(binaryPath, ["--version"], {
        timeout: 10_000,
        encoding: "utf8",
      }),
      execFileAsync(binaryPath, ["app-server", "--help"], {
        timeout: 10_000,
        encoding: "utf8",
      }),
    ]);
    return (
      /\binterpreter\s+\d+\.\d+\.\d+/i.test(`${versionOut}\n${versionErr}`) &&
      /--listen\b/.test(`${helpOut}\n${helpErr}`)
    );
  } catch {
    return false;
  }
}

function bundledOixPackageCandidates(
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  return resolveBundledResourceCandidates({
    packagedSegments: ["oix"],
    sourceSegments: ["oix", `${platform}-${arch}`],
  });
}

function replaceSymlink(
  linkPath: string,
  targetPath: string,
  type?: "dir" | "junction",
): void {
  try {
    const linkStat = lstatSync(linkPath);
    if (linkStat.isSymbolicLink()) {
      const actualTarget = realpathSync(linkPath);
      const requestedTarget = realpathSync(targetPath);
      const sameTarget =
        process.platform === "win32"
          ? actualTarget.replace(/^\\\\\?\\/, "").toLowerCase() ===
            requestedTarget.replace(/^\\\\\?\\/, "").toLowerCase()
          : actualTarget === requestedTarget;
      if (sameTarget) {
        return;
      }
    }
  } catch {
    // Missing and broken links are handled by the replacement path below.
  }
  const temporaryLink = `${linkPath}.workstation-${process.pid}`;
  rmSync(temporaryLink, { recursive: true, force: true });
  symlinkSync(targetPath, temporaryLink, type);
  try {
    renameSync(temporaryLink, linkPath);
  } catch {
    rmSync(linkPath, { recursive: true, force: true });
    renameSync(temporaryLink, linkPath);
  }
}

/**
 * Stable directory inside the runtime home that always points at the `bin`
 * directory of the runtime the app is currently running. Agent shells put it
 * first on PATH (see `buildInterpreterCliShellEnvironmentPolicy`) so that the
 * bare `interpreter` command there is the same runtime, with the same home,
 * rather than another installation found later on the user's PATH.
 */
export function getOixRuntimeCommandDir(
  runtimeHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathApi(platform).join(runtimeHome, "runtime", "interpreter-bin");
}

/**
 * Points the runtime command directory at the directory containing
 * `runtimeBinary`. A directory link keeps the runtime's sibling executables
 * next to the entrypoint. An existing non-link path is never replaced.
 */
export function linkOixRuntimeCommandDir(
  runtimeHome: string,
  runtimeBinary: string,
): string {
  const linkPath = getOixRuntimeCommandDir(runtimeHome);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = null;
  }
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(
      `[oix-runtime] Refusing to replace non-link path at ${linkPath}`,
    );
  }
  mkdirSync(path.dirname(linkPath), { recursive: true });
  replaceSymlink(
    linkPath,
    path.dirname(path.resolve(runtimeBinary)),
    process.platform === "win32" ? "junction" : "dir",
  );
  return linkPath;
}

function assertReplaceableManagedLink(
  linkPath: string,
  managedRoot: string,
): void {
  if (!existsSync(linkPath)) {
    return;
  }
  if (!canReplaceManagedLink(linkPath, managedRoot)) {
    throw new Error(
      `[oix-runtime] Refusing to replace non-managed path at ${linkPath}. Move it aside or install OIX explicitly.`,
    );
  }
}

function canReplaceManagedLink(linkPath: string, managedRoot: string): boolean {
  if (!existsSync(linkPath)) {
    return true;
  }
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    const target = readlinkSync(linkPath);
    const resolvedTarget = path.resolve(path.dirname(linkPath), target);
    return (
      resolvedTarget.startsWith(`${managedRoot}${path.sep}`) ||
      resolvedTarget === managedRoot
    );
  } catch {
    return false;
  }
}

type WorkstationTerminalOwnership = {
  version: string;
  target: string;
};

function readTerminalOwnership(
  ownershipFile: string,
): WorkstationTerminalOwnership | null {
  try {
    const parsed = JSON.parse(
      readFileSync(ownershipFile, "utf8"),
    ) as Partial<WorkstationTerminalOwnership>;
    if (
      typeof parsed.version !== "string" ||
      !VALID_VERSION.test(parsed.version) ||
      typeof parsed.target !== "string" ||
      !VALID_TARGET.test(parsed.target)
    ) {
      return null;
    }
    return parsed as WorkstationTerminalOwnership;
  } catch {
    return null;
  }
}

function writeTerminalOwnership(
  ownershipFile: string,
  metadata: OixPackageMetadata,
): void {
  const temporaryFile = `${ownershipFile}.workstation-${process.pid}`;
  writeFileSync(
    temporaryFile,
    `${JSON.stringify({
      version: metadata.version,
      target: metadata.target,
    })}\n`,
  );
  try {
    renameSync(temporaryFile, ownershipFile);
  } catch {
    rmSync(ownershipFile, { force: true });
    renameSync(temporaryFile, ownershipFile);
  }
}

function workstationOwnsTerminalSelector(
  paths: ReturnType<typeof getOixStandalonePaths>,
  platform: NodeJS.Platform,
): boolean {
  const ownership = readTerminalOwnership(paths.terminalOwnershipFile);
  if (!ownership) {
    return false;
  }
  const currentPackage = packageForBinary(paths.managedBinary, platform);
  return (
    currentPackage?.metadata.version === ownership.version &&
    currentPackage.metadata.target === ownership.target
  );
}

function ensureUnixVisibleCommands(
  packageDir: string,
  metadata: OixPackageMetadata,
  paths: ReturnType<typeof getOixStandalonePaths>,
): void {
  mkdirSync(paths.visibleBinDir, { recursive: true });
  const commands = [
    ["interpreter", metadata.entrypoint],
    ["i", "bin/i"],
    ["codex-code-mode-host", "bin/codex-code-mode-host"],
  ] as const;
  for (const [name, relativeTarget] of commands) {
    const source = path.join(packageDir, relativeTarget);
    if (!existsSync(source)) {
      continue;
    }
    chmodSync(source, 0o755);
    const visiblePath = path.join(paths.visibleBinDir, name);
    if (!canReplaceManagedLink(visiblePath, paths.standaloneRoot)) {
      console.warn(
        `[oix-runtime] leaving existing non-managed terminal command unchanged: ${visiblePath}`,
      );
      continue;
    }
    replaceSymlink(visiblePath, path.join(paths.currentDir, relativeTarget));
  }
}

function ensureUnixProfilePath(
  platform: NodeJS.Platform,
  visibleBinDir: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): void {
  const pathEntries = (env.PATH ?? "").split(path.posix.delimiter);
  if (pathEntries.includes(visibleBinDir)) {
    return;
  }
  const shell = env.SHELL ?? "";
  const profilePath =
    platform === "darwin"
      ? shell.endsWith("/bash")
        ? path.join(homeDir, ".bash_profile")
        : path.join(homeDir, ".zprofile")
      : shell.endsWith("/zsh")
        ? path.join(homeDir, ".zshrc")
        : shell.endsWith("/bash")
          ? path.join(homeDir, ".bashrc")
          : path.join(homeDir, ".profile");
  const pathLine = `export PATH="${visibleBinDir}:$PATH"`;
  const existing = existsSync(profilePath)
    ? readFileSync(profilePath, "utf8")
    : "";
  if (existing.includes(pathLine)) {
    return;
  }
  const block = `${PROFILE_BLOCK_BEGIN}\n${pathLine}\n${PROFILE_BLOCK_END}`;
  const next =
    existing.length === 0
      ? `${block}\n`
      : `${existing.replace(/\n?$/, "\n")}\n${block}\n`;
  writeFileSync(profilePath, next);
}

async function ensureWindowsUserPath(
  visibleBinDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const script = [
    "$bin = $env:INTERPRETER_INSTALL_BIN",
    '$current = [Environment]::GetEnvironmentVariable("Path", "User")',
    '$parts = @($current -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })',
    'if (-not ($parts | Where-Object { [string]::Equals($_.TrimEnd("\\"), $bin.TrimEnd("\\"), [StringComparison]::OrdinalIgnoreCase) })) {',
    '  [Environment]::SetEnvironmentVariable("Path", (($bin) + ";" + ($parts -join ";")), "User")',
    "}",
  ].join("; ");
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...env, INTERPRETER_INSTALL_BIN: visibleBinDir },
      timeout: 15_000,
      encoding: "utf8",
    },
  );
}

async function hasValidTerminalOix(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  paths: ReturnType<typeof getOixStandalonePaths>,
  probeBinary: (binaryPath: string) => Promise<boolean>,
): Promise<boolean> {
  const candidates = uniquePaths([
    paths.managedBinary,
    paths.visibleBinary,
    ...pathCandidates(platform, env),
  ]);
  for (const candidate of candidates) {
    if (existsSync(candidate) && (await probeBinary(candidate))) {
      return true;
    }
  }
  return false;
}

async function installBundledPackageUnlocked(
  packageDir: string,
  metadata: OixPackageMetadata,
  probeBinary: (binaryPath: string) => Promise<boolean>,
  options: Required<
    Pick<ResolveOixRuntimeOptions, "platform" | "env" | "homeDir">
  > & {
    configureTerminalPath: boolean;
  },
): Promise<OixRuntimeResolution> {
  const platformPath = pathApi(options.platform);
  const paths = getOixStandalonePaths(
    options.platform,
    options.env,
    options.homeDir,
  );
  const releaseDir = platformPath.join(
    paths.releasesDir,
    `${metadata.version}-${metadata.target}`,
  );
  mkdirSync(paths.releasesDir, { recursive: true });

  if (!readPackageMetadata(releaseDir, options.platform)) {
    const stagingDir = platformPath.join(
      paths.releasesDir,
      `.staging.${metadata.version}-${metadata.target}.${process.pid}`,
    );
    rmSync(stagingDir, { recursive: true, force: true });
    cpSync(packageDir, stagingDir, { recursive: true });
    try {
      renameSync(stagingDir, releaseDir);
    } catch (error) {
      rmSync(stagingDir, { recursive: true, force: true });
      if (!readPackageMetadata(releaseDir, options.platform)) {
        throw error;
      }
    }
  }

  const ownsTerminalSelector = workstationOwnsTerminalSelector(
    paths,
    options.platform,
  );
  if (existsSync(paths.terminalOwnershipFile) && !ownsTerminalSelector) {
    rmSync(paths.terminalOwnershipFile, { force: true });
  }
  const shouldManageTerminal =
    ownsTerminalSelector ||
    !(await hasValidTerminalOix(
      options.platform,
      options.env,
      paths,
      probeBinary,
    ));

  if (shouldManageTerminal) {
    assertReplaceableManagedLink(paths.currentDir, paths.releasesDir);
    replaceSymlink(
      paths.currentDir,
      releaseDir,
      options.platform === "win32" ? "junction" : "dir",
    );
    writeTerminalOwnership(paths.terminalOwnershipFile, metadata);
  }

  if (shouldManageTerminal && options.platform === "win32") {
    if (existsSync(paths.visibleBinDir)) {
      const currentVisible = packageForBinary(
        paths.visibleBinary,
        options.platform,
      );
      if (
        !currentVisible ||
        !currentVisible.packageDir.startsWith(paths.standaloneRoot)
      ) {
        console.warn(
          `[oix-runtime] leaving existing non-managed terminal bin directory unchanged: ${paths.visibleBinDir}`,
        );
      } else {
        replaceSymlink(
          paths.visibleBinDir,
          platformPath.join(paths.currentDir, "bin"),
          "junction",
        );
      }
    } else {
      mkdirSync(platformPath.dirname(paths.visibleBinDir), { recursive: true });
      replaceSymlink(
        paths.visibleBinDir,
        platformPath.join(paths.currentDir, "bin"),
        "junction",
      );
    }
    if (options.configureTerminalPath) {
      await ensureWindowsUserPath(paths.visibleBinDir, options.env);
    }
  } else if (shouldManageTerminal) {
    ensureUnixVisibleCommands(releaseDir, metadata, paths);
    if (options.configureTerminalPath) {
      ensureUnixProfilePath(
        options.platform,
        paths.visibleBinDir,
        options.env,
        options.homeDir,
      );
    }
  }

  const installedBinary = platformPath.join(releaseDir, metadata.entrypoint);
  return {
    binaryPath: installedBinary,
    packageDir: releaseDir,
    source: "installed",
    version: metadata.version,
  };
}

async function installBundledPackage(
  packageDir: string,
  metadata: OixPackageMetadata,
  probeBinary: (binaryPath: string) => Promise<boolean>,
  options: Required<
    Pick<ResolveOixRuntimeOptions, "platform" | "env" | "homeDir">
  > & {
    configureTerminalPath: boolean;
  },
): Promise<OixRuntimeResolution> {
  const paths = getOixStandalonePaths(
    options.platform,
    options.env,
    options.homeDir,
  );
  return await withInstallLock(paths.standaloneRoot, async () =>
    installBundledPackageUnlocked(packageDir, metadata, probeBinary, options),
  );
}

export async function resolveOrInstallOixRuntime(
  options: ResolveOixRuntimeOptions = {},
): Promise<OixRuntimeResolution> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const homeDir =
    options.homeDir ??
    (platform === "win32"
      ? (env.USERPROFILE ?? env.HOME)
      : (env.HOME ?? env.USERPROFILE)) ??
    os.homedir();
  const probeBinary = options.probeBinary ?? defaultProbeBinary;
  const explicitBinary = env.INTERPRETER_OIX_PATH?.trim();
  if (explicitBinary) {
    if (!existsSync(explicitBinary) || !(await probeBinary(explicitBinary))) {
      throw new Error(
        `[oix-runtime] INTERPRETER_OIX_PATH is not a valid Open Interpreter runtime: ${explicitBinary}`,
      );
    }
    const packageResolution = packageForBinary(explicitBinary, platform);
    if (packageResolution) {
      return {
        binaryPath: explicitBinary,
        packageDir: packageResolution.packageDir,
        source: "development",
        version: packageResolution.metadata.version,
      };
    }
    const versionOutput = await execFileAsync(explicitBinary, ["--version"], {
      timeout: 10_000,
      encoding: "utf8",
    });
    const version = `${versionOutput.stdout}\n${versionOutput.stderr}`.match(
      /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/,
    )?.[0];
    if (!version) {
      throw new Error(
        `[oix-runtime] Could not read a semantic version from INTERPRETER_OIX_PATH: ${explicitBinary}`,
      );
    }
    return {
      binaryPath: explicitBinary,
      packageDir: pathApi(platform).dirname(
        pathApi(platform).dirname(explicitBinary),
      ),
      source: "development",
      version,
    };
  }

  const bundledCandidates =
    options.bundledPackageCandidates ??
    bundledOixPackageCandidates(platform, arch);
  for (const packageDir of bundledCandidates) {
    const metadata = readPackageMetadata(packageDir, platform);
    if (!metadata) {
      continue;
    }
    const bundledBinary = pathApi(platform).join(
      packageDir,
      metadata.entrypoint,
    );
    if (!(await probeBinary(bundledBinary))) {
      continue;
    }
    return await installBundledPackage(packageDir, metadata, probeBinary, {
      platform,
      env,
      homeDir,
      configureTerminalPath: options.configureTerminalPath ?? true,
    });
  }

  throw new Error(
    `[oix-runtime] No valid bundled Open Interpreter runtime was found. Checked packages: ${bundledCandidates.join(", ")}`,
  );
}
