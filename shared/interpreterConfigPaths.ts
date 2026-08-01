import os from "node:os";
import path from "node:path";

function getElectronUserDataDir(): string | null {
  try {
    const { app } = require("electron") as { app?: { getPath(name: "userData"): string } };
    return app?.getPath("userData") ?? null;
  } catch {
    return null;
  }
}

type ElectronUserDataDirResolver = () => string | null;

export function resolveInterpreterDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  electronUserDataDirResolver: ElectronUserDataDirResolver = getElectronUserDataDir,
): string {
  if (env.INTERPRETER_USER_DATA_DIR) {
    return env.INTERPRETER_USER_DATA_DIR;
  }

  // NOTE(victor): Electron owns the real runtime userData path. Electron main
  // sets INTERPRETER_USER_DATA_DIR to this value after applying any explicit
  // override, so direct app calls and child/runtime calls resolve the same dir.
  const electronUserDataDir = electronUserDataDirResolver();
  if (electronUserDataDir) {
    return electronUserDataDir;
  }

  const platformPath = platform === "win32" ? path.win32 : path.posix;

  if (platform === "win32") {
    const appData = env.APPDATA;
    if (!appData) {
      throw new Error("APPDATA is required to resolve Interpreter data directory");
    }
    return platformPath.join(appData, "interpreter");
  }

  if (platform === "darwin") {
    return platformPath.join(
      homeDir,
      "Library",
      "Application Support",
      "interpreter",
    );
  }

  return platformPath.join(
    env.XDG_CONFIG_HOME ?? platformPath.join(homeDir, ".config"),
    "interpreter",
  );
}

export function resolveInterpreterConfigFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(resolveInterpreterDataDir(platform, env, homeDir), "config.json");
}

export function resolveLegacyInterpreterConfigDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".interpreter");
}

export function resolveLegacyInterpreterConfigFile(homeDir = os.homedir()): string {
  return path.join(resolveLegacyInterpreterConfigDir(homeDir), "config.json");
}
