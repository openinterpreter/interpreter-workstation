/**
 * Environment for the native desktop driver process.
 *
 * The driver runs as a long-lived daemon, and apps it starts through
 * `launch_app` inherit its environment. Interpreter keeps its own wiring in
 * the host process environment (data directory, log file, CLI connection,
 * runtime homes, asset directories). A launched app must never receive that
 * wiring: another copy of Interpreter would adopt the running instance's live
 * data directory, and a third-party app has no use for it.
 *
 * Everything else is passed through unchanged, including what GUI apps and
 * the driver itself rely on (DISPLAY, WAYLAND_DISPLAY, XAUTHORITY,
 * DBUS_SESSION_BUS_ADDRESS, XDG_*, HOME, PATH, LANG, CUA_*).
 */

/** Variables Interpreter sets on its own process for itself and its children. */
const INTERPRETER_INTERNAL_ENV_NAMES: ReadonlySet<string> = new Set([
  'LOG_FILE',
  'SENTRY_ENVIRONMENT',
  'VITE_PORT',
  'CODEX_HOME',
  'QWEN_ASR_ASSET_DIR',
  'MOONSHINE_ASSET_DIR',
  'PLAYWRITER_AUTO_ENABLE',
]);

/**
 * Interpreter's own configuration namespaces (for example
 * INTERPRETER_USER_DATA_DIR, INTERPRETER_HOME, INTERPRETER_CLI_PATH,
 * INTERPRETER_CLI_SERVER_CONNECTION, INTERPRETER_WORKSTATION_*,
 * WORKSTATION_EXPLICIT_WORKSPACE). The driver reads only CUA_* variables.
 */
const INTERPRETER_INTERNAL_ENV_PREFIXES: readonly string[] = ['INTERPRETER_', 'WORKSTATION_'];

export function isInterpreterInternalEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return INTERPRETER_INTERNAL_ENV_NAMES.has(upper)
    || INTERPRETER_INTERNAL_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Returns a copy of `env` without Interpreter's internal variables. */
export function cuaDriverProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isInterpreterInternalEnvName(name)) continue;
    next[name] = value;
  }
  return next;
}
