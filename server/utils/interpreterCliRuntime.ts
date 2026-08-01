import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getInterpreterHomeDir } from '../configStore';
import { resolveBundledResourceCandidates, uniquePaths } from './bundledRuntimePaths';
import {
  AGENT_SETTINGS_PATHS,
  INTERPRETER_CONFIG_PATH_ALIASES,
  SETTINGS_TABS,
} from '../../shared/settingsCatalog';

export const INTERPRETER_CALLER_TOKEN_ENV = 'INTERPRETER_CALLER_TOKEN';
export const INTERPRETER_CLI_COMMAND = 'interpreter-app';
export const INTERPRETER_CLI_CALLER_TOKEN_HEADER = 'X-Interpreter-Caller-Token';
export const INTERPRETER_CLI_PATH_ENV = 'INTERPRETER_CLI_PATH';
export const INTERPRETER_CLI_SERVER_CONNECTION_ENV = 'INTERPRETER_CLI_SERVER_CONNECTION';
export type InterpreterCliRuntimeTransport = 'file' | 'http' | 'unix';
export type InterpreterCliShellEnvironmentPolicyInherit = 'core' | 'all';

export type InterpreterCliShellEnvironmentPolicy = {
  inherit: InterpreterCliShellEnvironmentPolicyInherit;
  ignore_default_excludes?: boolean;
  set: Record<string, string>;
};

const FULL_ENV_MACHINE_MARKERS = [
  'INTERPRETER_MACHINE_RUN_ID',
  'INTERPRETER_MACHINE_RUN_DIR',
  'INTERPRETER_MACHINE_TASK_FILE',
  'INTERPRETER_MACHINE_ARTIFACT_DIR',
];

const INTERPRETER_CONFIG_ALIAS_LIST = INTERPRETER_CONFIG_PATH_ALIASES.map((entry) => entry.alias).join(', ');
const INTERPRETER_SETTINGS_TAB_LIST = SETTINGS_TABS.map((entry) => entry.defaultLabel).join(', ');
const INTERPRETER_CONFIG_COMMON_SETTINGS_LIST = AGENT_SETTINGS_PATHS
  .map((entry) => {
    const notes = [
      entry.note,
      entry.requiresApproval ? 'needs approval' : null,
      entry.restartRequired ? 'restart needed' : null,
    ].filter(Boolean).join(', ');
    return `  ${entry.path} - ${entry.defaultLabel}${notes ? ` (${notes})` : ''}`;
  })
  .join('\n');
const INTERPRETER_CONFIG_COMMON_SETTINGS_HELP = `Common settings you can change:\n${INTERPRETER_CONFIG_COMMON_SETTINGS_LIST}\n`;

function resolvePathEnvKey(env: NodeJS.ProcessEnv): string {
  const existingKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  return existingKey ?? 'PATH';
}

function resolveEnvKeyCaseInsensitive(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.win32.delimiter : path.posix.delimiter;
}

function prependPathEntry(existingPath: string | undefined, entry: string, platform: NodeJS.Platform): string {
  const delimiter = getPathDelimiter(platform);
  const normalizedEntry = entry.trim();
  const nextParts = (existingPath ?? '')
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== normalizedEntry);
  return [normalizedEntry, ...nextParts].join(delimiter);
}

const PDFCPU_DIR_NAME = 'pdfcpu';

function getPlatformResourceKey(platform: NodeJS.Platform = process.platform, arch = process.arch): string {
  const osPlatform = platform === 'win32' ? 'win32' : platform;
  return `${osPlatform}-${arch}`;
}

function resolveBundledPdfcpuDir(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
  pathExists: (candidatePath: string) => boolean = existsSync,
): string | null {
  const binaryName = platform === 'win32' ? 'pdfcpu.exe' : 'pdfcpu';
  const candidatePaths = uniquePaths([
    ...resolveBundledResourceCandidates({
      packagedSegments: [PDFCPU_DIR_NAME],
      sourceSegments: [PDFCPU_DIR_NAME, getPlatformResourceKey(platform, arch)],
    }),
  ]);

  for (const candidatePath of candidatePaths) {
    if (pathExists(path.join(candidatePath, binaryName))) {
      return candidatePath;
    }
  }

  return null;
}

export function getInterpreterCliRuntimeDir(
  platform: NodeJS.Platform = process.platform,
): string {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  return platformPath.join(getInterpreterHomeDir(), 'runtime', 'interpreter-cli');
}

function resolveInterpreterCliCodexHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = env.HOME ?? os.homedir(),
): string {
  const explicitCodexHome = env.CODEX_HOME?.trim();
  if (explicitCodexHome) {
    return explicitCodexHome;
  }

  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const explicitUserDataDir = env.INTERPRETER_USER_DATA_DIR?.trim();
  if (explicitUserDataDir) {
    if (path.isAbsolute(explicitUserDataDir)) {
      return path.join(explicitUserDataDir, 'codex-home');
    }
    return platformPath.join(platformPath.resolve(explicitUserDataDir), 'codex-home');
  }

  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (!appData) {
      throw new Error('APPDATA is required to resolve the Codex home');
    }
    return platformPath.join(appData, 'interpreter', 'codex-home');
  }

  if (platform === 'darwin') {
    return platformPath.join(
      homeDir,
      'Library',
      'Application Support',
      'interpreter',
      'codex-home',
    );
  }

  return platformPath.join(
    env.XDG_CONFIG_HOME ?? platformPath.join(homeDir, '.config'),
    'interpreter',
    'codex-home',
  );
}

function getInterpreterCliShellHomeDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fallbackHomeDir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    return env.USERPROFILE || env.HOME || fallbackHomeDir;
  }

  return path.join(resolveInterpreterCliCodexHome(platform, env, fallbackHomeDir), 'home');
}

export function getInterpreterCliShellRuntimeDir(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    return getInterpreterCliLauncherDir();
  }

  return path.join(homeDir, '.interpreter', 'runtime', 'interpreter-cli');
}

export function getInterpreterCliShellSandboxReadableRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform !== 'darwin') {
    return [];
  }

  return [getInterpreterCliShellRuntimeDir(platform, getInterpreterCliShellHomeDir(platform, env))];
}

function getInterpreterCliShellInitDir(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    return getInterpreterCliLauncherDir();
  }

  return path.join(getInterpreterCliShellRuntimeDir(platform, homeDir), 'shell-init');
}

function getInterpreterCliZshInitPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  return path.join(getInterpreterCliShellInitDir(platform, homeDir), '.zshenv');
}

function getInterpreterCliPosixShellInitPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  return path.join(getInterpreterCliShellInitDir(platform, homeDir), 'env.sh');
}

export function getInterpreterCliSocketPath(port: number): string {
  return path.join(os.tmpdir(), `interpreter-cli-server-${port}.sock`);
}

export function getInterpreterCliBridgeDir(
  port: number,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    // NOTE(victor): Packaged Windows startup can expose an unexpanded TEMP such
    // as `%USERP~1\\...`, which resolves under Program Files and makes mkdir
    // fail. Keep bridge state under app-owned userData-backed runtime storage.
    // VS Code sets userData before ready; Signal derives Electron temp/update
    // paths from userData instead of tmpdir().
    // Citations: microsoft/vscode/src/main.ts:56-64;
    // signalapp/Signal-Desktop/ts/updater/common.main.ts:1124-1151.
    return path.win32.join(getInterpreterCliRuntimeDir(platform), 'bridge', String(port));
  }

  return path.join(os.tmpdir(), `interpreter-cli-bridge-${port}`);
}

export function buildInterpreterCliServerConnection(
  port: number,
  options?: {
    transport?: InterpreterCliRuntimeTransport;
    platform?: NodeJS.Platform;
  },
): string {
  const platform = options?.platform ?? process.platform;
  const transport = options?.transport ?? (platform === 'win32' ? 'http' : 'unix');
  return transport === 'http'
    ? `http:http://127.0.0.1:${port}`
    : transport === 'unix'
      ? `unix:${getInterpreterCliSocketPath(port)}`
      : `file:${getInterpreterCliBridgeDir(port, platform)}`;
}

export function getInterpreterCliLauncherDir(): string {
  return path.join(getInterpreterCliRuntimeDir(), 'bin');
}

export function getInterpreterCliShellSafeLauncherDir(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    return getInterpreterCliLauncherDir();
  }
  return path.join(getInterpreterCliShellRuntimeDir(platform, homeDir), 'shell-safe-bin');
}

export function getInterpreterCliExecutablePath(
  platform: NodeJS.Platform = process.platform,
): string {
  const launcherDir = getInterpreterCliLauncherDir();
  return path.join(
    launcherDir,
    platform === 'win32' ? `${INTERPRETER_CLI_COMMAND}.cmd` : INTERPRETER_CLI_COMMAND,
  );
}

export function getInterpreterCliShellSafeExecutablePath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const launcherDir = getInterpreterCliShellSafeLauncherDir(platform, homeDir);
  return path.join(
    launcherDir,
    platform === 'win32' ? `${INTERPRETER_CLI_COMMAND}.cmd` : INTERPRETER_CLI_COMMAND,
  );
}

function getWindowsInterpreterCliPowerShellPath(): string {
  return path.join(getInterpreterCliLauncherDir(), `${INTERPRETER_CLI_COMMAND}.ps1`);
}

function getWindowsInterpreterCliNodeScriptPath(): string {
  return path.join(getInterpreterCliLauncherDir(), `${INTERPRETER_CLI_COMMAND}.cjs`);
}

function buildUnixInterpreterCliShellSafeScript(): string {
  return buildUnixInterpreterCliScript();
}

function buildUnixInterpreterCliShellInitScript(): string {
  const shellBody = buildUnixInterpreterCliScript().replace(/^#!\/bin\/sh\n/, '');
  return `interpreter-app() {
  /bin/sh -s -- "$@" <<'__INTERPRETER_CLI__'
${shellBody}__INTERPRETER_CLI__
}
`;
}

function removeLegacyInterpreterLaunchers(launcherDir: string): void {
  for (const filename of ['interpreter', 'interpreter-app.cmd', 'interpreter-app.ps1', 'interpreter-app.cjs']) {
    const filePath = path.join(launcherDir, filename);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }
}

function buildUnixInterpreterCliScript(): string {
  // NOTE(interpreter-cli-mcp): The generated `interpreter-app` command is a
  // shell/HTTP bridge into the running app, not an MCP client. It requires
  // INTERPRETER_CLI_SERVER_CONNECTION plus INTERPRETER_CALLER_TOKEN, sends the
  // token as X-Interpreter-Caller-Token, and maps `tools ...` subcommands onto
  // `/api/interpreter-cli/tools/*`; see `server/routes/interpreterCli.ts`.
  const jsonQuoteFunction = String.raw`
json_quote() {
  printf '%s' "$1" | awk '
    BEGIN { printf "\"" }
    {
      gsub(/\\/, "\\\\");
      gsub(/"/, "\\\"");
      gsub(/\t/, "\\t");
      gsub(/\r/, "\\r");
      if (NR > 1) {
        printf "\\n";
      }
      printf "%s", $0;
    }
    END { printf "\"" }
  '
}
`;

  return `#!/bin/sh
set -eu

WORKSTATION_SERVER_ID='builtin-interpreter'
WORKSTATION_CONFIG_GET_TOOL='interpreter_settings_get'
WORKSTATION_CONFIG_SET_TOOL='interpreter_settings_set'
WORKSTATION_LAYOUT_GET_TOOL='interpreter_get'
WORKSTATION_LAYOUT_SET_TOOL='interpreter_set'

usage() {
  cat >&2 <<'EOF'
Usage:
  interpreter-app tools list [server-id]
  interpreter-app tools find <query>
  interpreter-app tools <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]
  interpreter-app mcp list [server-id]
  interpreter-app mcp find <query>
  interpreter-app mcp <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]
  interpreter-app config get [path]
  interpreter-app config set <path> [<string-value> | --value <string> | --bool <true|false> | --number <number> | --null | --json <json> | --json-file <path> | --stdin-json] [--restart-runtime]
  interpreter-app config restart-runtime [--reason <text>]
  interpreter-app layout get [path]
  interpreter-app layout set <path> [<json-value> | --json <json> | --json-file <path> | --stdin-json]
EOF
}

usage_mcp() {
  cat >&2 <<'EOF'
Usage:
  interpreter-app mcp list [server-id]
  interpreter-app mcp find <query>
  interpreter-app mcp <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]

Tips:
  interpreter-app mcp list                  # list configured servers
  interpreter-app mcp list <server-id>      # list tools on that server
  interpreter-app mcp find "journal entries"
  interpreter-app mcp <server-id> <tool-name> --help
  interpreter-app mcp <server-id>__<tool-name> --help

Examples:
  interpreter-app mcp filesystem read_file --json '{"path":"README.md"}'
  interpreter-app mcp docs search --json '{"query":"release notes"}'
EOF
}

usage_tools() {
  cat >&2 <<'EOF'
Usage:
  interpreter-app tools list [server-id]
  interpreter-app tools find <query>
  interpreter-app tools <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]

Tips:
  interpreter-app tools list                  # list visible servers only
  interpreter-app tools list <server-id>      # list tools on that server
  interpreter-app tools find interpreter_vault
  interpreter-app tools find "read word docx"
  interpreter-app tools find "convert docx to pdf"
  interpreter-app tools <server-id> <tool-name> --help
  interpreter-app tools <server-id>__<tool-name> --help
  --stdin-arg <key> reads raw stdin (for example a heredoc) as that string argument, no JSON escaping; combine with --json for other fields.
  Top-level tools list does not list individual tools.
  Many built-in tools live on shared servers such as builtin-interpreter.

Examples:
  interpreter-app tools builtin-docx read_word --json '{"path":"Notes.docx"}'
  interpreter-app tools builtin-pdf read_pdf --json '{"path":"packet.pdf"}'
  interpreter-app tools builtin-converter convert_file --json '{"path":"Notes.docx","format":"pdf"}'
  interpreter-app tools builtin-interpreter interpreter_refresh_file --json '{"path":"report.xlsx"}'
EOF
}

usage_config() {
  cat >&2 <<'EOF'
Usage:
  interpreter-app config get [path]
  interpreter-app config set <path> [<string-value> | --value <string> | --bool <true|false> | --number <number> | --null | --json <json> | --json-file <path> | --stdin-json] [--restart-runtime]
  interpreter-app config restart-runtime [--reason <text>]

Examples:
  interpreter-app config get
  interpreter-app config get theme
  interpreter-app config get agentAccess
  interpreter-app config set theme dark
  interpreter-app config set agentAccess.network --bool true
  interpreter-app config set agentAccess.network --bool true --restart-runtime
  interpreter-app config set agentAccess.readScope anywhere --restart-runtime
  interpreter-app config set agentAccess.sandboxMode workspace-write --restart-runtime
  interpreter-app config set agentAccess.approvalPolicy on-request

Current Settings tabs:
  ${INTERPRETER_SETTINGS_TAB_LIST}

Common settings you can change:
${INTERPRETER_CONFIG_COMMON_SETTINGS_LIST}

Config aliases:
  ${INTERPRETER_CONFIG_ALIAS_LIST}

Behavior:
  Runtime permission changes like sandbox, read scope, and network access take effect after Interpreter restarts.
  Approval policy changes apply immediately.
  --restart-runtime asks whether to reset Interpreter's agent runtime now.
  config restart-runtime asks whether to reset Interpreter's agent runtime without changing another setting.
  Restarting stops running conversations for every agent.

Underlying tools:
  interpreter-app tools builtin-interpreter interpreter_settings_get --help
  interpreter-app tools builtin-interpreter interpreter_settings_set --help
EOF
}

usage_layout() {
  cat >&2 <<'EOF'
Usage:
  interpreter-app layout get [path]
  interpreter-app layout set <path> [<json-value> | --json <json> | --json-file <path> | --stdin-json]

Examples:
  interpreter-app layout get
  interpreter-app layout get tree.children[0].tabs
  interpreter-app layout set sidebars.left.is_open false
  interpreter-app layout set tree.children[0].tabs --json '[{"settings_section":"runtimePermissions","active":true}]'

Underlying tools:
  interpreter-app tools builtin-interpreter interpreter_get --help
  interpreter-app tools builtin-interpreter interpreter_set --help
EOF
}

print_help_hint() {
  help_command=$1
  if [ -n "$help_command" ]; then
    printf "Run '%s'.\n" "$help_command" >&2
  fi
}

fail_with_help() {
  message=$1
  help_command=$2
  printf '%s\n' "$message" >&2
  print_help_hint "$help_command"
  exit 1
}

suggest_top_level_command() {
  case "$1" in
    tool|tooling|tols|toosl|toolss)
      echo 'tools'
      ;;
    conf|cnfig|cofig|configs|cfg)
      echo 'config'
      ;;
    lay|layot|layou|layouts|layouts)
      echo 'layout'
      ;;
    *)
      echo ''
      ;;
  esac
}

suggest_get_set_subcommand() {
  case "$1" in
    g|ge|gett|gets|fetch)
      echo 'get'
      ;;
    s|se|sett|sets|update)
      echo 'set'
      ;;
    restart|restart-runtime|runtime-restart|refresh|refresh-runtime)
      echo 'restart-runtime'
      ;;
    *)
      echo ''
      ;;
  esac
}

suggest_tools_flag() {
  case "$1" in
    --j|--js|--jso|--jsonn)
      echo '--json'
      ;;
    --jsonf|--jsonfi|--jsonfile|--json-fil)
      echo '--json-file'
      ;;
    --stdin|--stdinj|--stdinjson)
      echo '--stdin-json'
      ;;
    --stdinarg|--stdin-args|--arg|--raw-stdin)
      echo '--stdin-arg'
      ;;
    --save|--save-to|--save-disk|--save-to-file)
      echo '--save-to-disk'
      ;;
    *)
      echo ''
      ;;
  esac
}

suggest_config_flag() {
  case "$1" in
    --j|--js|--jso|--jsonn)
      echo '--json'
      ;;
    --jsonf|--jsonfi|--jsonfile|--json-fil)
      echo '--json-file'
      ;;
    --stdin|--stdinj|--stdinjson)
      echo '--stdin-json'
      ;;
    --val|--valu|--string)
      echo '--value'
      ;;
    --boolean|--boo|--bol)
      echo '--bool'
      ;;
    --num|--nmbr|--numeric)
      echo '--number'
      ;;
    --nil)
      echo '--null'
      ;;
    --restart|--restart-now|--restart-runtime-now)
      echo '--restart-runtime'
      ;;
    *)
      echo ''
      ;;
  esac
}

suggest_layout_flag() {
  case "$1" in
    --j|--js|--jso|--jsonn)
      echo '--json'
      ;;
    --jsonf|--jsonfi|--jsonfile|--json-fil)
      echo '--json-file'
      ;;
    --stdin|--stdinj|--stdinjson)
      echo '--stdin-json'
      ;;
    *)
      echo ''
      ;;
  esac
}

SERVER_CONNECTION=\${INTERPRETER_CLI_SERVER_CONNECTION:-}
if [ -z "$SERVER_CONNECTION" ]; then
  echo "Missing ${INTERPRETER_CLI_SERVER_CONNECTION_ENV} in shell environment" >&2
  exit 1
fi

transport_mode=
transport_target=
case "$SERVER_CONNECTION" in
  file:*)
    transport_mode='file'
    transport_target=\${SERVER_CONNECTION#file:}
    ;;
  unix:*)
    transport_mode='unix'
    transport_target=\${SERVER_CONNECTION#unix:}
    ;;
  http:*)
    transport_mode='http'
    transport_target=\${SERVER_CONNECTION#http:}
    ;;
  *)
    echo "Unsupported interpreter CLI connection mode: $SERVER_CONNECTION" >&2
    exit 1
    ;;
esac

if [ -z "\${${INTERPRETER_CALLER_TOKEN_ENV}:-}" ]; then
  echo "Missing ${INTERPRETER_CALLER_TOKEN_ENV} in shell environment" >&2
  exit 1
fi

prepare_file_bridge_request() {
  bridge_dir=$1
  staging_root="$bridge_dir/request-staging"
  requests_root="$bridge_dir/requests"

  mkdir -p "$staging_root" "$requests_root"

  # Use mktemp so parallel CLI invocations never share a staging directory or
  # request id. The old timestamp/random shell expansion was collision-prone.
  bridge_staging_dir=$(mktemp -d "$staging_root/req-XXXXXX") || {
    echo "Failed to allocate interpreter CLI bridge staging directory." >&2
    exit 1
  }
  bridge_request_id=$(basename "$bridge_staging_dir")
  bridge_request_dir="$requests_root/$bridge_request_id"
}

${jsonQuoteFunction}

trim_outer_whitespace() {
  value=$1
  while :; do
    case "$value" in
      [[:space:]]*) value=\${value#?} ;;
      *[[:space:]]) value=\${value%?} ;;
      *) break ;;
    esac
  done
  printf '%s' "$value"
}

json_object_with_string_field() {
  # $1 JSON object text, $2 field key, $3 raw string value. Prints the object
  # with the field appended (last duplicate key wins server-side). Fails when
  # the base text is not a JSON object literal.
  base_json=$(trim_outer_whitespace "$1")
  pair="$(json_quote "$2"):$(json_quote "$3")"
  case "$base_json" in
    ''|'{}')
      printf '{%s}' "$pair"
      return 0
      ;;
    '{'*'}')
      inner=\${base_json#?}
      inner=\${inner%?}
      inner=$(trim_outer_whitespace "$inner")
      if [ -z "$inner" ]; then
        printf '{%s}' "$pair"
      else
        printf '{%s,%s}' "$inner" "$pair"
      fi
      return 0
      ;;
  esac
  return 1
}

file_bridge_request() {
  bridge_dir=$1
  request_id=$2

  request_dir="$bridge_dir/requests/$request_id"
  response_dir="$bridge_dir/responses/$request_id"
  response_status_path="$response_dir/status"
  response_body_path="$response_dir/body"
  response_progress_path="$response_dir/progress"
  progress_bytes=0

  mkdir -p "$response_dir"
  : > "$request_dir/.ready"

  flush_progress() {
    if [ ! -f "$response_progress_path" ]; then
      return
    fi

    total_bytes=$(wc -c < "$response_progress_path" | tr -d '[:space:]')
    if [ -z "$total_bytes" ]; then
      total_bytes=0
    fi

    if [ "$total_bytes" -le "$progress_bytes" ]; then
      return
    fi

    start_byte=$((progress_bytes + 1))
    tail -c +"$start_byte" "$response_progress_path" >&2 || true
    progress_bytes=$total_bytes
  }

  while [ ! -f "$response_status_path" ]; do
    if [ ! -d "$bridge_dir" ]; then
      echo "Interpreter CLI bridge disconnected while waiting for response." >&2
      rm -rf "$request_dir" "$response_dir"
      exit 1
    fi
    # Long-running tool calls can append CLI-visible progress here while the
    # final JSON response is still pending.
    flush_progress
    sleep 0.05
  done

  flush_progress

  response_status=$(cat "$response_status_path")
  if [ -f "$response_body_path" ]; then
    body=$(cat "$response_body_path")
  else
    body=''
  fi
  rm -rf "$request_dir" "$response_dir"

  if [ "$response_status" = "ok" ]; then
    printf '%s' "$body"
    if printf '%s' "$body" | grep -Eq '"isError"[[:space:]]*:[[:space:]]*true|"is_error"[[:space:]]*:[[:space:]]*true'; then
      return 1
    fi
    return 0
  fi

  if [ -n "$body" ]; then
    printf '%s\n' "$body" >&2
  fi
  return 1
}

stream_tool_call_request() {
  request_url=$1
  request_body=$2

  stream_dir=$(mktemp -d "\${TMPDIR:-/tmp}/interpreter-cli-stream.XXXXXX") || {
    echo "Failed to allocate interpreter CLI stream directory." >&2
    exit 1
  }
  stream_pipe="$stream_dir/events.pipe"
  stream_result_path="$stream_dir/result"
  stream_failed_path="$stream_dir/failed"

  mkfifo "$stream_pipe" || {
    rm -rf "$stream_dir"
    echo "Failed to create interpreter CLI stream pipe." >&2
    exit 1
  }

  if [ "$transport_mode" = "unix" ]; then
    curl -fsS -N \\
      --unix-socket "$transport_target" \\
      -X POST \\
      -H "Content-Type: application/json" \\
      -H "${INTERPRETER_CLI_CALLER_TOKEN_HEADER}: \${${INTERPRETER_CALLER_TOKEN_ENV}}" \\
      --data-binary "$request_body" \\
      "$request_url" > "$stream_pipe" &
  else
    curl -fsS -N \\
      -X POST \\
      -H "Content-Type: application/json" \\
      -H "${INTERPRETER_CLI_CALLER_TOKEN_HEADER}: \${${INTERPRETER_CALLER_TOKEN_ENV}}" \\
      --data-binary "$request_body" \\
      "$request_url" > "$stream_pipe" &
  fi
  curl_pid=$!

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      progress\\ *)
        printf '%s\n' "\${line#progress }" >&2 || true
        ;;
      result\\ *)
        printf '%s' "\${line#result }" > "$stream_result_path"
        ;;
      error\\ *)
        printf '%s\n' "\${line#error }" >&2 || true
        : > "$stream_failed_path"
        ;;
      *)
        if [ -n "$line" ]; then
          printf '%s\n' "$line" >&2 || true
        fi
        ;;
    esac
  done < "$stream_pipe"

  set +e
  wait "$curl_pid"
  curl_status=$?
  set -e
  rm -f "$stream_pipe"

  if [ "$curl_status" -ne 0 ]; then
    rm -rf "$stream_dir"
    return "$curl_status"
  fi

  if [ -f "$stream_failed_path" ]; then
    rm -rf "$stream_dir"
    return 1
  fi

  if [ -f "$stream_result_path" ]; then
    cat "$stream_result_path"
    if grep -Eq '"isError"[[:space:]]*:[[:space:]]*true|"is_error"[[:space:]]*:[[:space:]]*true' "$stream_result_path"; then
      rm -rf "$stream_dir"
      return 1
    fi
    rm -rf "$stream_dir"
    return 0
  fi

  rm -rf "$stream_dir"
  echo "Interpreter CLI stream ended without a result." >&2
  return 1
}

url_encode() {
  value=$1
  encoded=''
  old_lc_all=\${LC_ALL-}
  LC_ALL=C
  i=1
  while [ "$i" -le "\${#value}" ]; do
    char=$(printf '%s' "$value" | cut -c "$i")
    case "$char" in
      [a-zA-Z0-9.~_-])
        encoded="$encoded$char"
        ;;
      *)
        hex=$(printf '%s' "$char" | od -An -tx1 | tr -d ' \n')
        encoded="$encoded%$hex"
        ;;
    esac
    i=$((i + 1))
  done
  if [ -n "$old_lc_all" ]; then
    LC_ALL=$old_lc_all
  else
    unset LC_ALL
  fi
  printf '%s' "$encoded"
}

request_json() {
  request_url=$1
  request_method=$2
  request_body=$3

  response_dir=$(mktemp -d "\${TMPDIR:-/tmp}/interpreter-cli-http.XXXXXX") || {
    echo "Failed to allocate interpreter CLI response directory." >&2
    return 1
  }
  response_body_path="$response_dir/body"

  set +e
  if [ "$transport_mode" = "unix" ]; then
    if [ "$request_method" = 'GET' ]; then
      response_status=$(curl -sS \\
        --unix-socket "$transport_target" \\
        -H "${INTERPRETER_CLI_CALLER_TOKEN_HEADER}: \${${INTERPRETER_CALLER_TOKEN_ENV}}" \\
        -o "$response_body_path" \\
        -w '%{http_code}' \\
        "$request_url")
    else
      response_status=$(curl -sS \\
        --unix-socket "$transport_target" \\
        -X "$request_method" \\
        -H "Content-Type: application/json" \\
        -H "${INTERPRETER_CLI_CALLER_TOKEN_HEADER}: \${${INTERPRETER_CALLER_TOKEN_ENV}}" \\
        --data-binary "$request_body" \\
        -o "$response_body_path" \\
        -w '%{http_code}' \\
        "$request_url")
    fi
    curl_status=$?
  else
    if [ "$request_method" = 'GET' ]; then
      response_status=$(curl -sS \\
        -H "${INTERPRETER_CLI_CALLER_TOKEN_HEADER}: \${${INTERPRETER_CALLER_TOKEN_ENV}}" \\
        -o "$response_body_path" \\
        -w '%{http_code}' \\
        "$request_url")
    else
      response_status=$(curl -sS \\
        -X "$request_method" \\
        -H "Content-Type: application/json" \\
        -H "${INTERPRETER_CLI_CALLER_TOKEN_HEADER}: \${${INTERPRETER_CALLER_TOKEN_ENV}}" \\
        --data-binary "$request_body" \\
        -o "$response_body_path" \\
        -w '%{http_code}' \\
        "$request_url")
    fi
    curl_status=$?
  fi
  set -e

  if [ -f "$response_body_path" ]; then
    body=$(cat "$response_body_path")
  else
    body=''
  fi
  rm -rf "$response_dir"

  if [ "$curl_status" -ne 0 ]; then
    if [ -n "$body" ]; then
      printf '%s\n' "$body" >&2
    fi
    return "$curl_status"
  fi

  case "$response_status" in
    2??)
      printf '%s' "$body"
      return 0
      ;;
  esac

  if [ -n "$body" ]; then
    printf '%s\n' "$body" >&2
  else
    printf 'Interpreter CLI request failed with HTTP %s.\n' "$response_status" >&2
  fi
  return 1
}

bridge_write_common_fields() {
  staging_dir=$1
  kind=$2
  printf '%s' "$kind" > "$staging_dir/kind"
  printf '%s' "\${${INTERPRETER_CALLER_TOKEN_ENV}}" > "$staging_dir/caller-token"
}

cli_list_tools() {
  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'list'
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    request_json "http://localhost/api/interpreter-cli/tools" 'GET' ''
    return $?
  fi
  request_json "$transport_target/api/interpreter-cli/tools" 'GET' ''
}

cli_list_server_tools() {
  server_id=$1
  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'list-server-tools'
    printf '%s' "$server_id" > "$bridge_staging_dir/server-id"
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    request_json "http://localhost/api/interpreter-cli/tools/$server_id" 'GET' ''
    return $?
  fi
  request_json "$transport_target/api/interpreter-cli/tools/$server_id" 'GET' ''
}

cli_find_tools() {
  query=$1
  args_json="{\\"query\\":$(json_quote "$query")}"
  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'find-tools'
    printf '%s' "$query" > "$bridge_staging_dir/query"
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    request_json "http://localhost/api/interpreter-cli/tools/find" 'POST' "$args_json"
    return $?
  fi
  request_json "$transport_target/api/interpreter-cli/tools/find" 'POST' "$args_json"
}

cli_describe_tool() {
  server_id=$1
  tool_name=$2
  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'describe'
    printf '%s' "$server_id" > "$bridge_staging_dir/server-id"
    printf '%s' "$tool_name" > "$bridge_staging_dir/tool-name"
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    request_json "http://localhost/api/interpreter-cli/tools/$server_id/$tool_name" 'GET' ''
    return $?
  fi
  request_json "$transport_target/api/interpreter-cli/tools/$server_id/$tool_name" 'GET' ''
}

cli_call_tool() {
  server_id=$1
  tool_name=$2
  args_json=$3
  save_to_disk=$4
  save_to_disk_path=$5
  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'call'
    printf '%s' "$server_id" > "$bridge_staging_dir/server-id"
    printf '%s' "$tool_name" > "$bridge_staging_dir/tool-name"
    printf '%s' "$save_to_disk" > "$bridge_staging_dir/save-to-disk"
    if [ -n "$save_to_disk_path" ]; then
      printf '%s' "$save_to_disk_path" > "$bridge_staging_dir/save-to-disk-path"
    fi
    printf '%s' "$args_json" > "$bridge_staging_dir/args.json"
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  query="saveToDisk=$save_to_disk"
  if [ -n "$save_to_disk_path" ]; then
    query="$query&saveToDiskPath=$(url_encode "$save_to_disk_path")"
  fi
  if [ "$transport_mode" = "unix" ]; then
    stream_tool_call_request \\
      "http://localhost/api/interpreter-cli/tools/$server_id/$tool_name/stream?$query" \\
      "$args_json"
    return $?
  fi
  stream_tool_call_request \\
    "$transport_target/api/interpreter-cli/tools/$server_id/$tool_name/stream?$query" \\
    "$args_json"
}

cli_config_get() {
  args_json=$1
  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'config-get'
    printf '%s' "$args_json" | awk 'BEGIN { RS=""; ORS="" } { print }' > "$bridge_staging_dir/value.json"
    path_value=$(printf '%s' "$args_json" | sed -n 's/.*"path":"\\([^"]*\\)".*/\\1/p')
    printf '%s' "$path_value" > "$bridge_staging_dir/path"
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    request_json "http://localhost/api/interpreter-cli/config/get" 'POST' "$args_json"
    return $?
  fi
  request_json "$transport_target/api/interpreter-cli/config/get" 'POST' "$args_json"
}

cli_config_set() {
  config_path=$1
  value_json=$2
  restart_runtime=$3
  args_json="{\\"path\\":$(json_quote "$config_path"),\\"value\\":$value_json"
  if [ "$restart_runtime" = 'true' ]; then
    args_json="$args_json,\\"restart_runtime\\":true"
  fi
  args_json="$args_json}"

  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'config-set'
    printf '%s' "$config_path" > "$bridge_staging_dir/path"
    printf '%s' "$value_json" > "$bridge_staging_dir/value.json"
    printf '%s' "$restart_runtime" > "$bridge_staging_dir/restart-runtime"
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    request_json "http://localhost/api/interpreter-cli/config/set" 'POST' "$args_json"
    return $?
  fi
  request_json "$transport_target/api/interpreter-cli/config/set" 'POST' "$args_json"
}

cli_config_restart_runtime() {
  reason=$1
  args_json="{\\"reason\\":$(json_quote "$reason")}"

  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'config-restart-runtime'
    if [ -n "$reason" ]; then
      printf '%s' "$reason" > "$bridge_staging_dir/reason"
    fi
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    curl -fsS \\
      --unix-socket "$transport_target" \\
      -X POST \\
      -H "Content-Type: application/json" \\
      -H "${INTERPRETER_CLI_CALLER_TOKEN_HEADER}: \${${INTERPRETER_CALLER_TOKEN_ENV}}" \\
      --data-binary "$args_json" \\
      "http://localhost/api/interpreter-cli/config/restart-runtime"
    return $?
  fi
  curl -fsS \\
    -X POST \\
    -H "Content-Type: application/json" \\
    -H "${INTERPRETER_CLI_CALLER_TOKEN_HEADER}: \${${INTERPRETER_CALLER_TOKEN_ENV}}" \\
    --data-binary "$args_json" \\
    "$transport_target/api/interpreter-cli/config/restart-runtime"
}

cli_layout_get() {
  args_json=$1
  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'layout-get'
    path_value=$(printf '%s' "$args_json" | sed -n 's/.*"path":"\\([^"]*\\)".*/\\1/p')
    printf '%s' "$path_value" > "$bridge_staging_dir/path"
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    request_json "http://localhost/api/interpreter-cli/layout/get" 'POST' "$args_json"
    return $?
  fi
  request_json "$transport_target/api/interpreter-cli/layout/get" 'POST' "$args_json"
}

cli_layout_set() {
  layout_path=$1
  value_json=$2
  args_json="{\\"path\\":$(json_quote "$layout_path"),\\"value\\":$value_json}"

  if [ "$transport_mode" = "file" ]; then
    prepare_file_bridge_request "$transport_target"
    bridge_write_common_fields "$bridge_staging_dir" 'layout-set'
    printf '%s' "$layout_path" > "$bridge_staging_dir/path"
    printf '%s' "$value_json" > "$bridge_staging_dir/value.json"
    mv "$bridge_staging_dir" "$bridge_request_dir"
    file_bridge_request "$transport_target" "$bridge_request_id"
    return $?
  fi
  if [ "$transport_mode" = "unix" ]; then
    request_json "http://localhost/api/interpreter-cli/layout/set" 'POST' "$args_json"
    return $?
  fi
  request_json "$transport_target/api/interpreter-cli/layout/set" 'POST' "$args_json"
}

if [ "$#" -eq 0 ] || [ "$1" = '--help' ] || [ "$1" = '-h' ] || [ "$1" = 'help' ]; then
  usage
  exit 0
fi

command=$1
shift 1
help_command='interpreter-app tools --help'
if [ "$command" = 'mcp' ]; then
  if [ "$#" -eq 0 ] || [ "$1" = '--help' ] || [ "$1" = '-h' ]; then
    usage_mcp
    exit 0
  fi
  command='tools'
  help_command='interpreter-app mcp --help'
fi

case "$command" in
  tools)
    if [ "$#" -eq 0 ] || [ "$1" = '--help' ] || [ "$1" = '-h' ]; then
      usage_tools
      exit 0
    fi

    subcommand=$1

    case "$subcommand" in
      list)
        if [ "$#" -gt 2 ]; then
          fail_with_help "Expected 'interpreter-app tools list' or 'interpreter-app tools list <server-id>'." "$help_command"
        fi
        if [ "$#" -eq 2 ]; then
          cli_list_server_tools "$2"
          exit $?
        fi
        cli_list_tools
        exit $?
        ;;
      find|search)
        shift 1
        if [ "$#" -lt 1 ]; then
          fail_with_help "Expected 'interpreter-app tools find <query>'." "$help_command"
        fi
        query=$*
        cli_find_tools "$query"
        exit $?
        ;;
      help|describe)
        shift 1
        if [ "$#" -eq 1 ]; then
          case "$1" in
            *__*)
              server_id=$(printf '%s' "$1" | sed 's/__.*$//')
              tool_name=$(printf '%s' "$1" | sed 's/^.*__//')
              if [ -n "$server_id" ] && [ -n "$tool_name" ] && [ "$server_id" != "$1" ] && [ "$tool_name" != "$1" ]; then
                cli_describe_tool "$server_id" "$tool_name"
                exit $?
              fi
              ;;
          esac
        fi
        if [ "$#" -ne 2 ]; then
          fail_with_help "Expected 'interpreter-app tools <server-id> <tool-name> --help' or 'interpreter-app tools <server-id>__<tool-name> --help'." "$help_command"
        fi
        cli_describe_tool "$1" "$2"
        exit $?
        ;;
      *)
        if [ "$#" -lt 1 ]; then
          fail_with_help "Expected 'interpreter-app tools list', 'interpreter-app tools list <server-id>', 'interpreter-app tools find <query>', or 'interpreter-app tools <server-id> <tool-name>'." "$help_command"
        fi

        server_id=''
        tool_name=''
        second_arg=''
        if [ "$#" -ge 2 ]; then
          second_arg=$2
        fi

        case "$1" in
          *__*)
            case "$second_arg" in
              ''|--*|-h)
                server_id=$(printf '%s' "$1" | sed 's/__.*$//')
                tool_name=$(printf '%s' "$1" | sed 's/^.*__//')
                if [ -n "$server_id" ] && [ -n "$tool_name" ] && [ "$server_id" != "$1" ] && [ "$tool_name" != "$1" ]; then
                  shift 1
                else
                  server_id=''
                  tool_name=''
                fi
                ;;
            esac
            ;;
        esac

        if [ -z "$server_id" ] || [ -z "$tool_name" ]; then
          if [ "$#" -lt 2 ]; then
            fail_with_help "Expected 'interpreter-app tools <server-id> <tool-name>' or 'interpreter-app tools <server-id>__<tool-name>'." "$help_command"
          fi
          server_id=$1
          tool_name=$2
          shift 2
        fi

        if [ "$#" -eq 1 ] && { [ "$1" = '--help' ] || [ "$1" = '-h' ]; }; then
          cli_describe_tool "$server_id" "$tool_name"
          exit $?
        fi

        args_json='{}'
        save_to_disk='false'
        save_to_disk_path=''
        stdin_arg_key=''
        stdin_json_used='false'

        while [ "$#" -gt 0 ]; do
          case "$1" in
            --json)
              if [ "$#" -lt 2 ]; then
                fail_with_help "Missing value for --json." "interpreter-app tools $server_id $tool_name --help"
              fi
              args_json=$2
              shift 2
              ;;
            --json-file)
              if [ "$#" -lt 2 ]; then
                fail_with_help "Missing value for --json-file." "interpreter-app tools $server_id $tool_name --help"
              fi
              args_json=$(cat "$2")
              shift 2
              ;;
            --stdin-json)
              args_json=$(cat)
              stdin_json_used='true'
              shift 1
              ;;
            --stdin-arg)
              if [ "$#" -lt 2 ]; then
                fail_with_help "Missing key for --stdin-arg." "interpreter-app tools $server_id $tool_name --help"
              fi
              stdin_arg_key=$2
              shift 2
              ;;
            --save-to-disk)
              save_to_disk='true'
              if [ "$#" -ge 2 ]; then
                case "$2" in
                  --*)
                    shift 1
                    ;;
                  *)
                    save_to_disk_path=$2
                    shift 2
                    ;;
                esac
              else
                shift 1
              fi
              ;;
            *)
              suggested_flag=$(suggest_tools_flag "$1")
              if [ -n "$suggested_flag" ]; then
                fail_with_help "Unknown argument '$1'. Did you mean '$suggested_flag'?" "interpreter-app tools $server_id $tool_name --help"
              fi
              fail_with_help "Unknown argument '$1'. Supported flags: --json, --json-file, --stdin-json, --stdin-arg, --save-to-disk." "interpreter-app tools $server_id $tool_name --help"
              ;;
          esac
        done

        if [ -n "$stdin_arg_key" ]; then
          if [ "$stdin_json_used" = 'true' ]; then
            fail_with_help "--stdin-arg cannot be combined with --stdin-json." "interpreter-app tools $server_id $tool_name --help"
          fi
          stdin_arg_value=$(cat)
          if ! args_json=$(json_object_with_string_field "$args_json" "$stdin_arg_key" "$stdin_arg_value"); then
            fail_with_help "--stdin-arg requires the --json/--json-file value to be a JSON object." "interpreter-app tools $server_id $tool_name --help"
          fi
        fi

        cli_call_tool "$server_id" "$tool_name" "$args_json" "$save_to_disk" "$save_to_disk_path"
        exit $?
        ;;
    esac
    ;;
  config)
    if [ "$#" -eq 0 ] || [ "$1" = '--help' ] || [ "$1" = '-h' ] || [ "$1" = 'help' ]; then
      usage_config
      exit 0
    fi

    subcommand=$1
    shift 1

    case "$subcommand" in
      get)
        if [ "$#" -gt 1 ]; then
          fail_with_help "'interpreter-app config get' accepts at most one optional path." "interpreter-app config --help"
        fi
        config_path=''
        if [ "$#" -eq 1 ]; then
          config_path=$1
        fi
        args_json="{\\"path\\":$(json_quote "$config_path")}"
        cli_config_get "$args_json"
        exit $?
        ;;
      restart-runtime)
        reason='A fresh runtime snapshot is needed.'
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --reason)
              if [ "$#" -lt 2 ]; then
                fail_with_help "Missing value for --reason." "interpreter-app config --help"
              fi
              reason=$2
              shift 2
              ;;
            *)
              fail_with_help "Unknown argument '$1'. Expected --reason <text>." "interpreter-app config --help"
              ;;
          esac
        done
        cli_config_restart_runtime "$reason"
        exit $?
        ;;
      set)
        if [ "$#" -lt 2 ]; then
          fail_with_help "Expected 'interpreter-app config set <path> <value>'." "interpreter-app config --help"
        fi
        config_path=$1
        shift 1

        restart_runtime='false'
        case "$1" in
          --json)
            if [ "$#" -lt 2 ]; then
              fail_with_help "Missing value for --json." "interpreter-app config --help"
            fi
            value_json=$2
            shift 2
            ;;
          --json-file)
            if [ "$#" -lt 2 ]; then
              fail_with_help "Missing value for --json-file." "interpreter-app config --help"
            fi
            value_json=$(cat "$2")
            shift 2
            ;;
          --stdin-json)
            value_json=$(cat)
            shift 1
            ;;
          --value)
            if [ "$#" -lt 2 ]; then
              fail_with_help "Missing value for --value." "interpreter-app config --help"
            fi
            value_json=$(json_quote "$2")
            shift 2
            ;;
          --bool)
            if [ "$#" -lt 2 ]; then
              fail_with_help "Missing value for --bool." "interpreter-app config --help"
            fi
            if [ "$2" != 'true' ] && [ "$2" != 'false' ]; then
              fail_with_help "--bool expects 'true' or 'false'." "interpreter-app config --help"
            fi
            value_json=$2
            shift 2
            ;;
          --number)
            if [ "$#" -lt 2 ]; then
              fail_with_help "Missing value for --number." "interpreter-app config --help"
            fi
            value_json=$2
            shift 2
            ;;
          --null)
            value_json='null'
            shift 1
            ;;
          *)
            case "$1" in
              -*)
                suggested_flag=$(suggest_config_flag "$1")
                if [ -n "$suggested_flag" ]; then
                  fail_with_help "Unknown argument '$1'. Did you mean '$suggested_flag'?" "interpreter-app config --help"
                fi
                fail_with_help "Unknown argument '$1'. Supported value flags: --value, --bool, --number, --null, --json, --json-file, --stdin-json, --restart-runtime." "interpreter-app config --help"
                ;;
            esac
            string_value=''
            while [ "$#" -gt 0 ]; do
              if [ "$1" = '--restart-runtime' ]; then
                restart_runtime='true'
                shift 1
                continue
              fi
              if [ -n "$string_value" ]; then
                string_value="$string_value $1"
              else
                string_value=$1
              fi
              shift 1
            done
            value_json=$(json_quote "$string_value")
            ;;
        esac
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --restart-runtime)
              restart_runtime='true'
              shift 1
              ;;
            *)
              suggested_flag=$(suggest_config_flag "$1")
              if [ -n "$suggested_flag" ]; then
                fail_with_help "Unknown argument '$1'. Did you mean '$suggested_flag'?" "interpreter-app config --help"
              fi
              fail_with_help "Unknown argument '$1'. The only trailing flag allowed here is --restart-runtime." "interpreter-app config --help"
              ;;
          esac
        done
        cli_config_set "$config_path" "$value_json" "$restart_runtime"
        exit $?
        ;;
      *)
        suggested_subcommand=$(suggest_get_set_subcommand "$subcommand")
        if [ -n "$suggested_subcommand" ]; then
          fail_with_help "Unknown config command '$subcommand'. Did you mean '$suggested_subcommand'?" "interpreter-app config --help"
        fi
        fail_with_help "Unknown config command '$subcommand'. Expected one of: get, set, restart-runtime." "interpreter-app config --help"
        ;;
    esac
    ;;
  layout)
    if [ "$#" -eq 0 ] || [ "$1" = '--help' ] || [ "$1" = '-h' ] || [ "$1" = 'help' ]; then
      usage_layout
      exit 0
    fi

    subcommand=$1
    shift 1

    case "$subcommand" in
      get)
        if [ "$#" -gt 1 ]; then
          fail_with_help "'interpreter-app layout get' accepts at most one optional path." "interpreter-app layout --help"
        fi
        layout_path=''
        if [ "$#" -eq 1 ]; then
          layout_path=$1
        fi
        args_json="{\\"path\\":$(json_quote "$layout_path")}"
        cli_layout_get "$args_json"
        exit $?
        ;;
      set)
        if [ "$#" -lt 2 ]; then
          fail_with_help "Expected 'interpreter-app layout set <path> <json-value>'." "interpreter-app layout --help"
        fi
        layout_path=$1
        shift 1

        case "$1" in
          --json)
            if [ "$#" -lt 2 ]; then
              fail_with_help "Missing value for --json." "interpreter-app layout --help"
            fi
            value_json=$2
            ;;
          --json-file)
            if [ "$#" -lt 2 ]; then
              fail_with_help "Missing value for --json-file." "interpreter-app layout --help"
            fi
            value_json=$(cat "$2")
            ;;
          --stdin-json)
            value_json=$(cat)
            ;;
          *)
            case "$1" in
              -*)
                suggested_flag=$(suggest_layout_flag "$1")
                if [ -n "$suggested_flag" ]; then
                  fail_with_help "Unknown argument '$1'. Did you mean '$suggested_flag'?" "interpreter-app layout --help"
                fi
                fail_with_help "Unknown argument '$1'. Supported value flags: --json, --json-file, --stdin-json." "interpreter-app layout --help"
                ;;
            esac
            value_json=$*
            ;;
        esac

        cli_layout_set "$layout_path" "$value_json"
        exit $?
        ;;
      *)
        suggested_subcommand=$(suggest_get_set_subcommand "$subcommand")
        if [ -n "$suggested_subcommand" ]; then
          fail_with_help "Unknown layout command '$subcommand'. Did you mean '$suggested_subcommand'?" "interpreter-app layout --help"
        fi
        fail_with_help "Unknown layout command '$subcommand'. Expected 'get' or 'set'." "interpreter-app layout --help"
        ;;
    esac
    ;;
  *)
    suggested_command=$(suggest_top_level_command "$command")
    if [ -n "$suggested_command" ]; then
      fail_with_help "Unknown command '$command'. Did you mean '$suggested_command'?" "interpreter $suggested_command --help"
    fi
    fail_with_help "Unknown command '$command'. Expected one of: tools, config, layout." "interpreter-app --help"
    ;;
esac
`;
}

function buildWindowsInterpreterCliCmdScript(
  nodeScriptPath: string,
  powerShellPath: string,
): string {
  return `@echo off
setlocal
echo %${INTERPRETER_CLI_SERVER_CONNECTION_ENV}% | findstr /B /C:"file:" >nul
if %ERRORLEVEL% EQU 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File ${JSON.stringify(powerShellPath)} %*
  exit /b %ERRORLEVEL%
)
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node ${JSON.stringify(nodeScriptPath)} %*
  exit /b %ERRORLEVEL%
)
powershell -NoProfile -ExecutionPolicy Bypass -File ${JSON.stringify(powerShellPath)} %*
`;
}

function buildWindowsInterpreterCliNodeScript(): string {
  return `'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const callerTokenEnv = ${JSON.stringify(INTERPRETER_CALLER_TOKEN_ENV)};
const callerTokenHeader = ${JSON.stringify(INTERPRETER_CLI_CALLER_TOKEN_HEADER)};
const serverConnectionEnv = ${JSON.stringify(INTERPRETER_CLI_SERVER_CONNECTION_ENV)};

function fail(message) {
  process.stderr.write(String(message) + '\\n');
  process.exit(1);
}

function showUsage() {
  process.stderr.write('Usage:\\n');
  process.stderr.write('  interpreter-app tools list [server-id]\\n');
  process.stderr.write('  interpreter-app tools find <query>\\n');
  process.stderr.write('  interpreter-app tools <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]\\n');
  process.stderr.write('  interpreter-app mcp list [server-id]\\n');
  process.stderr.write('  interpreter-app mcp find <query>\\n');
  process.stderr.write('  interpreter-app mcp <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]\\n');
  process.stderr.write('  interpreter-app config get [path]\\n');
  process.stderr.write('  interpreter-app config set <path> [<string-value> | --value <string> | --bool <true|false> | --number <number> | --null | --json <json> | --json-file <path> | --stdin-json] [--restart-runtime]\\n');
  process.stderr.write('  interpreter-app config restart-runtime [--reason <text>]\\n');
  process.stderr.write('  interpreter-app layout get [path]\\n');
  process.stderr.write('  interpreter-app layout set <path> [<json-value> | --json <json> | --json-file <path> | --stdin-json]\\n');
}

function showToolsUsage() {
  process.stderr.write('Usage:\\n');
  process.stderr.write('  interpreter-app tools list [server-id]\\n');
  process.stderr.write('  interpreter-app tools find <query>\\n');
  process.stderr.write('  interpreter-app tools <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]\\n');
  process.stderr.write('Notes:\\n');
  process.stderr.write('  interpreter-app tools list lists visible servers only.\\n');
  process.stderr.write('  interpreter-app tools list <server-id> lists tools on that server.\\n');
  process.stderr.write('  Top-level tools list does not list individual tools.\\n');
  process.stderr.write('  Many built-in tools live on shared servers such as builtin-interpreter.\\n');
  process.stderr.write('Tips:\\n');
  process.stderr.write('  interpreter-app tools list builtin-interpreter\\n');
  process.stderr.write('  interpreter-app tools find interpreter_vault\\n');
  process.stderr.write('  interpreter-app tools find \"read word docx\"\\n');
  process.stderr.write('  interpreter-app tools find \"convert docx to pdf\"\\n');
  process.stderr.write('  interpreter-app tools <server-id> <tool-name> --help\\n');
  process.stderr.write('  interpreter-app tools <server-id>__<tool-name> --help\\n');
  process.stderr.write('  --stdin-arg <key> reads raw stdin as that string argument, no JSON escaping; combine with --json for other fields.\\n');
  process.stderr.write('Examples:\\n');
  process.stderr.write('  interpreter-app tools builtin-docx read_word --json \\'{\"path\":\"Notes.docx\"}\\'\\n');
  process.stderr.write('  interpreter-app tools builtin-pdf read_pdf --json \\'{\"path\":\"packet.pdf\"}\\'\\n');
  process.stderr.write('  interpreter-app tools builtin-converter convert_file --json \\'{\"path\":\"Notes.docx\",\"format\":\"pdf\"}\\'\\n');
  process.stderr.write('  interpreter-app tools builtin-interpreter interpreter_refresh_file --json \\'{\"path\":\"report.xlsx\"}\\'\\n');
}

function showMcpUsage() {
  process.stderr.write('Usage:\\n');
  process.stderr.write('  interpreter-app mcp list [server-id]\\n');
  process.stderr.write('  interpreter-app mcp find <query>\\n');
  process.stderr.write('  interpreter-app mcp <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]\\n');
  process.stderr.write('\\n');
  process.stderr.write('Examples:\\n');
  process.stderr.write('  interpreter-app mcp filesystem read_file --json \\'{\"path\":\"README.md\"}\\'\\n');
  process.stderr.write('  interpreter-app mcp docs search --json \\'{\"query\":\"release notes\"}\\'\\n');
}

function parseQualifiedToolTarget(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const delimiterIndex = value.indexOf('__');
  if (delimiterIndex <= 0 || delimiterIndex >= value.length - 2) {
    return null;
  }
  return {
    serverId: value.slice(0, delimiterIndex),
    toolName: value.slice(delimiterIndex + 2),
  };
}

function isToolFlag(value) {
  return value === '--help' || value === '-h' || value.startsWith('--');
}

function showConfigUsage() {
  process.stderr.write('Usage:\\n');
  process.stderr.write('  interpreter-app config get [path]\\n');
  process.stderr.write('  interpreter-app config set <path> [<string-value> | --value <string> | --bool <true|false> | --number <number> | --null | --json <json> | --json-file <path> | --stdin-json] [--restart-runtime]\\n');
  process.stderr.write('  interpreter-app config restart-runtime [--reason <text>]\\n');
  process.stderr.write('Examples:\\n');
  process.stderr.write('  interpreter-app config get\\n');
  process.stderr.write('  interpreter-app config get theme\\n');
  process.stderr.write('  interpreter-app config get agentAccess\\n');
  process.stderr.write('  interpreter-app config set agentAccess.network --bool true\\n');
  process.stderr.write('  interpreter-app config set agentAccess.network --bool true --restart-runtime\\n');
  process.stderr.write('Current Settings tabs: ${INTERPRETER_SETTINGS_TAB_LIST}\\n');
  process.stderr.write(${JSON.stringify(INTERPRETER_CONFIG_COMMON_SETTINGS_HELP)});
  process.stderr.write('Config aliases: ${INTERPRETER_CONFIG_ALIAS_LIST}\\n');
  process.stderr.write('Behavior: Runtime permission changes like sandbox, read scope, and network access take effect after Interpreter restarts. Approval policy changes apply immediately. --restart-runtime asks whether to reset Interpreter\\'s agent runtime now. config restart-runtime asks without changing another setting. Restarting stops running conversations for every agent.\\n');
  process.stderr.write('Underlying tools:\\n');
  process.stderr.write('  interpreter-app tools builtin-interpreter interpreter_settings_get --help\\n');
  process.stderr.write('  interpreter-app tools builtin-interpreter interpreter_settings_set --help\\n');
}

function showLayoutUsage() {
  process.stderr.write('Usage:\\n');
  process.stderr.write('  interpreter-app layout get [path]\\n');
  process.stderr.write('  interpreter-app layout set <path> [<json-value> | --json <json> | --json-file <path> | --stdin-json]\\n');
  process.stderr.write('Underlying tools:\\n');
  process.stderr.write('  interpreter-app tools builtin-interpreter interpreter_get --help\\n');
  process.stderr.write('  interpreter-app tools builtin-interpreter interpreter_set --help\\n');
}

function quote(value) {
  return \`'\${value}'\`;
}

function failWithHelp(message, helpCommand) {
  process.stderr.write(String(message) + '\\n');
  if (helpCommand) {
    process.stderr.write(\`Run \${quote(helpCommand)}.\\n\`);
  }
  process.exit(1);
}

function levenshtein(a, b) {
  const left = String(a).toLowerCase();
  const right = String(b).toLowerCase();
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    let previous = rows[0];
    rows[0] = rightIndex;
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = rows[leftIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      rows[leftIndex] = Math.min(
        rows[leftIndex] + 1,
        rows[leftIndex - 1] + 1,
        previous + cost,
      );
      previous = current;
    }
  }
  return rows[left.length];
}

function findClosestChoice(input, choices) {
  const normalizedInput = String(input).toLowerCase();
  let bestChoice = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const choice of choices) {
    const distance = levenshtein(normalizedInput, String(choice).toLowerCase());
    if (distance < bestDistance) {
      bestChoice = choice;
      bestDistance = distance;
    }
  }
  if (bestChoice === null) {
    return null;
  }
  const threshold = Math.max(2, Math.floor(String(bestChoice).length / 3));
  return bestDistance <= threshold ? bestChoice : null;
}

function failUnknownChoice(kind, value, choices, helpCommand) {
  const suggestion = findClosestChoice(value, choices);
  if (suggestion) {
    failWithHelp(\`Unknown \${kind} \${quote(value)}. Did you mean \${quote(suggestion)}?\`, helpCommand);
  }
  failWithHelp(\`Unknown \${kind} \${quote(value)}. Expected one of: \${choices.join(', ')}.\`, helpCommand);
}

function failUnknownFlag(flag, supportedFlags, helpCommand) {
  const suggestion = findClosestChoice(flag, supportedFlags);
  if (suggestion) {
    failWithHelp(\`Unknown argument \${quote(flag)}. Did you mean \${quote(suggestion)}?\`, helpCommand);
  }
  failWithHelp(\`Unknown argument \${quote(flag)}. Supported flags: \${supportedFlags.join(', ')}.\`, helpCommand);
}

function isToolErrorResult(rawResult) {
  try {
    const parsed = JSON.parse(rawResult);
    return parsed && typeof parsed === 'object' && (parsed.isError === true || parsed.is_error === true);
  } catch {
    return false;
  }
}

function parseJsonWithHelp(rawValue, label, helpCommand) {
  try {
    return JSON.parse(rawValue);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failWithHelp(\`\${label} must be valid JSON. \${detail}\`, helpCommand);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function request(url, options) {
  const targetUrl = new URL(url);
  const requestBody = options && Object.prototype.hasOwnProperty.call(options, 'body')
    ? String(options.body ?? '')
    : undefined;
  const headers = {
    ...(options?.headers ?? {}),
    Connection: 'close',
  };
  if (requestBody !== undefined) {
    headers['Content-Length'] = Buffer.byteLength(requestBody).toString();
  }
  const requestModule = targetUrl.protocol === 'https:' ? https : http;
  return await new Promise((_, reject) => {
    const req = requestModule.request(
      targetUrl,
      {
        method: options?.method ?? 'GET',
        headers,
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          void (async () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
              if (body) {
                fs.writeSync(2, body + (body.endsWith('\\n') ? '' : '\\n'));
              }
              process.exit(1);
              return;
            }
            if (body) {
              fs.writeSync(1, body);
            }
            process.exit(0);
          })().catch(reject);
        });
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    if (requestBody !== undefined) {
      req.end(requestBody);
      return;
    }
    req.end();
  });
}

async function streamToolRequest(url, options) {
  const targetUrl = new URL(url);
  const requestBody = options && Object.prototype.hasOwnProperty.call(options, 'body')
    ? String(options.body ?? '')
    : '';
  const headers = {
    ...(options?.headers ?? {}),
    Connection: 'close',
    'Content-Length': Buffer.byteLength(requestBody).toString(),
  };
  const requestModule = targetUrl.protocol === 'https:' ? https : http;
  return await new Promise((_, reject) => {
    const req = requestModule.request(
      targetUrl,
      {
        method: options?.method ?? 'POST',
        headers,
        agent: false,
      },
      (response) => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (body) {
              fs.writeSync(2, body + (body.endsWith('\\n') ? '' : '\\n'));
            }
            process.exit(1);
          });
          response.on('error', reject);
          return;
        }

        let buffered = '';
        let finalResult = null;
        let sawError = false;

        const flushLine = (rawLine) => {
          const line = rawLine.replace(/\\r$/, '');
          if (!line) {
            return;
          }
          if (line.startsWith('progress ')) {
            fs.writeSync(2, line.slice('progress '.length) + '\\n');
            return;
          }
          if (line.startsWith('result ')) {
            finalResult = line.slice('result '.length);
            return;
          }
          if (line.startsWith('error ')) {
            sawError = true;
            fs.writeSync(2, line.slice('error '.length) + '\\n');
            return;
          }
          fs.writeSync(2, line + '\\n');
        };

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffered += chunk;
          let newlineIndex = buffered.indexOf('\\n');
          while (newlineIndex !== -1) {
            const line = buffered.slice(0, newlineIndex);
            buffered = buffered.slice(newlineIndex + 1);
            flushLine(line);
            newlineIndex = buffered.indexOf('\\n');
          }
        });
        response.on('end', () => {
          if (buffered) {
            flushLine(buffered);
          }
          if (sawError) {
            process.exit(1);
            return;
          }
          if (finalResult === null) {
            fail('Interpreter CLI stream ended without a result.');
            return;
          }
          fs.writeSync(1, finalResult);
          process.exit(isToolErrorResult(finalResult) ? 1 : 0);
        });
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(requestBody);
  });
}

function stringifyJson(value) {
  return JSON.stringify(value);
}

async function main() {
  const serverConnection = process.env[serverConnectionEnv]?.trim() ?? '';
  if (!serverConnection) {
    fail(\`Missing \${serverConnectionEnv} in shell environment\`);
  }
  if (!serverConnection.startsWith('http:')) {
    fail(\`Unsupported interpreter CLI connection mode on Windows: \${serverConnection}\`);
  }

  const callerToken = process.env[callerTokenEnv];
  if (!callerToken || !callerToken.trim()) {
    fail(\`Missing \${callerTokenEnv} in shell environment\`);
  }

  const argvList = process.argv.slice(2);
  if (argvList.length === 0 || argvList[0] === '--help' || argvList[0] === '-h' || argvList[0] === 'help') {
    showUsage();
    return;
  }

  const baseUrl = serverConnection.slice(5);
  const headers = { [callerTokenHeader]: callerToken };
  let command = argvList[0];
  if (command === 'mcp') {
    if (argvList.length === 1 || argvList[1] === '--help' || argvList[1] === '-h') {
      showMcpUsage();
      return;
    }
    command = 'tools';
  }
  const topLevelCommands = ['tools', 'mcp', 'config', 'layout'];
  const getSetCommands = ['get', 'set'];
  const configCommands = ['get', 'set', 'restart-runtime'];

  if (command === 'tools') {
    if (argvList.length === 1 || argvList[1] === '--help' || argvList[1] === '-h') {
      showToolsUsage();
      return;
    }

    const subcommand = argvList[1];

    if (subcommand === 'list') {
      if (argvList.length > 3) {
        failWithHelp("Expected 'interpreter-app tools list' or 'interpreter-app tools list <server-id>'.", 'interpreter-app tools --help');
      }
      if (argvList.length === 3) {
        await request(
          \`\${baseUrl}/api/interpreter-cli/tools/\${encodeURIComponent(argvList[2])}\`,
          { method: 'GET', headers },
        );
        return;
      }
      await request(\`\${baseUrl}/api/interpreter-cli/tools\`, { method: 'GET', headers });
      return;
    }

    if (subcommand === 'find' || subcommand === 'search') {
      if (argvList.length < 3) {
        failWithHelp("Expected 'interpreter-app tools find <query>'.", 'interpreter-app tools --help');
      }
      await request(
        \`\${baseUrl}/api/interpreter-cli/tools/find\`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: argvList.slice(2).join(' ') }),
        },
      );
      return;
    }

    if (subcommand === 'help' || subcommand === 'describe') {
      if (argvList.length === 3) {
        const qualifiedTarget = parseQualifiedToolTarget(argvList[2]);
        if (qualifiedTarget) {
          await request(
            \`\${baseUrl}/api/interpreter-cli/tools/\${encodeURIComponent(qualifiedTarget.serverId)}/\${encodeURIComponent(qualifiedTarget.toolName)}\`,
            { method: 'GET', headers },
          );
          return;
        }
      }
      if (argvList.length !== 4) {
        failWithHelp("Expected 'interpreter-app tools <server-id> <tool-name> --help' or 'interpreter-app tools <server-id>__<tool-name> --help'.", 'interpreter-app tools --help');
      }
      await request(
        \`\${baseUrl}/api/interpreter-cli/tools/\${encodeURIComponent(argvList[2])}/\${encodeURIComponent(argvList[3])}\`,
        { method: 'GET', headers },
      );
      return;
    }

    if (argvList.length < 2) {
      failWithHelp("Expected 'interpreter-app tools list', 'interpreter-app tools list <server-id>', 'interpreter-app tools find <query>', or 'interpreter-app tools <server-id> <tool-name>'.", 'interpreter-app tools --help');
    }

    const qualifiedTarget = parseQualifiedToolTarget(argvList[1]);
    const useQualifiedTarget = Boolean(
      qualifiedTarget
      && (argvList.length === 2 || isToolFlag(argvList[2])),
    );
    if (!useQualifiedTarget && argvList.length < 3) {
      failWithHelp("Expected 'interpreter-app tools <server-id> <tool-name>' or 'interpreter-app tools <server-id>__<tool-name>'.", 'interpreter-app tools --help');
    }

    const serverId = useQualifiedTarget ? qualifiedTarget.serverId : argvList[1];
    const toolName = useQualifiedTarget ? qualifiedTarget.toolName : argvList[2];
    const toolHelpCommand = \`interpreter-app tools \${serverId} \${toolName} --help\`;
    const flagStartIndex = useQualifiedTarget ? 2 : 3;
    if (
      argvList.length === flagStartIndex + 1
      && (argvList[flagStartIndex] === '--help' || argvList[flagStartIndex] === '-h')
    ) {
      await request(
        \`\${baseUrl}/api/interpreter-cli/tools/\${encodeURIComponent(serverId)}/\${encodeURIComponent(toolName)}\`,
        { method: 'GET', headers },
      );
      return;
    }

    let argsJson = '{}';
    let saveToDisk = 'false';
    let saveToDiskPath = '';
    let stdinArgKey = null;
    let stdinJsonUsed = false;
    let index = flagStartIndex;
    const supportedToolFlags = ['--json', '--json-file', '--stdin-json', '--stdin-arg', '--save-to-disk'];

    while (index < argvList.length) {
      const current = argvList[index];
      if (current === '--json') {
        if (index + 1 >= argvList.length) {
          failWithHelp('Missing value for --json.', toolHelpCommand);
        }
        argsJson = argvList[index + 1];
        index += 2;
        continue;
      }
      if (current === '--json-file') {
        if (index + 1 >= argvList.length) {
          failWithHelp('Missing value for --json-file.', toolHelpCommand);
        }
        argsJson = fs.readFileSync(argvList[index + 1], 'utf8');
        index += 2;
        continue;
      }
      if (current === '--stdin-json') {
        argsJson = await readStdin();
        stdinJsonUsed = true;
        index += 1;
        continue;
      }
      if (current === '--stdin-arg') {
        if (index + 1 >= argvList.length) {
          failWithHelp('Missing key for --stdin-arg.', toolHelpCommand);
        }
        stdinArgKey = argvList[index + 1];
        index += 2;
        continue;
      }
      if (current === '--save-to-disk') {
        saveToDisk = 'true';
        if (index + 1 < argvList.length && !argvList[index + 1].startsWith('--')) {
          saveToDiskPath = argvList[index + 1];
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }
      failUnknownFlag(current, supportedToolFlags, toolHelpCommand);
    }

    if (stdinArgKey !== null) {
      if (stdinJsonUsed) {
        failWithHelp('--stdin-arg cannot be combined with --stdin-json.', toolHelpCommand);
      }
      let parsedArgs;
      try {
        parsedArgs = argsJson.trim() === '' ? {} : JSON.parse(argsJson);
      } catch {
        parsedArgs = null;
      }
      if (parsedArgs === null || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
        failWithHelp('--stdin-arg requires the --json/--json-file value to be a JSON object.', toolHelpCommand);
      }
      parsedArgs[stdinArgKey] = await readStdin();
      argsJson = JSON.stringify(parsedArgs);
    }

    const query = new URLSearchParams({ saveToDisk });
    if (saveToDiskPath) {
      query.set('saveToDiskPath', saveToDiskPath);
    }
    await streamToolRequest(
      \`\${baseUrl}/api/interpreter-cli/tools/\${encodeURIComponent(serverId)}/\${encodeURIComponent(toolName)}/stream?\${query.toString()}\`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: argsJson,
      },
    );
    return;
  }

  if (command === 'config') {
    if (argvList.length === 1 || argvList[1] === '--help' || argvList[1] === '-h' || argvList[1] === 'help') {
      showConfigUsage();
      return;
    }

    const subcommand = argvList[1];
    if (subcommand === 'get') {
      if (argvList.length > 3) {
        failWithHelp("'interpreter-app config get' accepts at most one optional path.", 'interpreter-app config --help');
      }
      const configPath = argvList[2] ?? '';
      await request(\`\${baseUrl}/api/interpreter-cli/config/get\`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: stringifyJson({ path: configPath }),
      });
      return;
    }

    if (subcommand === 'restart-runtime') {
      let reason = 'A fresh runtime snapshot is needed.';
      const remaining = argvList.slice(2);
      for (let index = 0; index < remaining.length; index += 1) {
        const item = remaining[index];
        if (item === '--reason') {
          const value = remaining[index + 1];
          if (!value) failWithHelp('Missing value for --reason.', 'interpreter-app config --help');
          reason = value;
          index += 1;
          continue;
        }
        failWithHelp(\`Unknown argument \${quote(item)}. Expected --reason <text>.\`, 'interpreter-app config --help');
      }
      await request(\`\${baseUrl}/api/interpreter-cli/config/restart-runtime\`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: stringifyJson({ reason }),
      });
      return;
    }

    if (subcommand !== 'set') {
      failUnknownChoice('config command', subcommand, configCommands, 'interpreter-app config --help');
    }

    if (argvList.length < 4) {
      failWithHelp("Expected 'interpreter-app config set <path> <value>'.", 'interpreter-app config --help');
    }

    const configPath = argvList[2];
    const remaining = argvList.slice(3);
    let value;
    const restartRuntime = remaining.includes('--restart-runtime');
    const valueArgs = remaining.filter((item) => item !== '--restart-runtime');
    const configValueFlags = ['--json', '--json-file', '--stdin-json', '--value', '--bool', '--number', '--null', '--restart-runtime'];

    if (valueArgs.length === 0) {
      failWithHelp("Expected 'interpreter-app config set <path> <value>'.", 'interpreter-app config --help');
    }

    if (valueArgs[0] === '--json') {
      if (valueArgs.length !== 2) failWithHelp('--json expects exactly one JSON value.', 'interpreter-app config --help');
      value = parseJsonWithHelp(valueArgs[1], \`Config value for \${quote(configPath)}\`, 'interpreter-app config --help');
    } else if (valueArgs[0] === '--json-file') {
      if (valueArgs.length !== 2) failWithHelp('--json-file expects exactly one path.', 'interpreter-app config --help');
      value = parseJsonWithHelp(fs.readFileSync(valueArgs[1], 'utf8'), \`Config value from \${quote(valueArgs[1])}\`, 'interpreter-app config --help');
    } else if (valueArgs[0] === '--stdin-json') {
      if (valueArgs.length !== 1) failWithHelp('--stdin-json does not take extra arguments.', 'interpreter-app config --help');
      value = parseJsonWithHelp(await readStdin(), \`Config value for \${quote(configPath)}\`, 'interpreter-app config --help');
    } else if (valueArgs[0] === '--value') {
      if (valueArgs.length !== 2) failWithHelp('--value expects exactly one string value.', 'interpreter-app config --help');
      value = valueArgs[1];
    } else if (valueArgs[0] === '--bool') {
      if (valueArgs.length !== 2) failWithHelp('--bool expects exactly one value: true or false.', 'interpreter-app config --help');
      if (valueArgs[1] !== 'true' && valueArgs[1] !== 'false') failWithHelp("--bool expects 'true' or 'false'.", 'interpreter-app config --help');
      value = valueArgs[1] === 'true';
    } else if (valueArgs[0] === '--number') {
      if (valueArgs.length !== 2) failWithHelp('--number expects exactly one numeric value.', 'interpreter-app config --help');
      value = Number(valueArgs[1]);
      if (Number.isNaN(value)) failWithHelp('--number expects a valid number.', 'interpreter-app config --help');
    } else if (valueArgs[0] === '--null') {
      if (valueArgs.length !== 1) failWithHelp('--null does not take any extra arguments.', 'interpreter-app config --help');
      value = null;
    } else {
      if (valueArgs[0].startsWith('-')) {
        failUnknownFlag(valueArgs[0], configValueFlags, 'interpreter-app config --help');
      }
      value = valueArgs.join(' ');
    }

    await request(\`\${baseUrl}/api/interpreter-cli/config/set\`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: stringifyJson({
        path: configPath,
        value,
        ...(restartRuntime ? { restart_runtime: true } : {}),
      }),
    });
    return;
  }

  if (command === 'layout') {
    if (argvList.length === 1 || argvList[1] === '--help' || argvList[1] === '-h' || argvList[1] === 'help') {
      showLayoutUsage();
      return;
    }

    const subcommand = argvList[1];
    if (subcommand === 'get') {
      if (argvList.length > 3) {
        failWithHelp("'interpreter-app layout get' accepts at most one optional path.", 'interpreter-app layout --help');
      }
      const layoutPath = argvList[2] ?? '';
      await request(\`\${baseUrl}/api/interpreter-cli/layout/get\`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: stringifyJson({ path: layoutPath }),
      });
      return;
    }

    if (subcommand !== 'set') {
      failUnknownChoice('layout command', subcommand, getSetCommands, 'interpreter-app layout --help');
    }

    if (argvList.length < 4) {
      failWithHelp("Expected 'interpreter-app layout set <path> <json-value>'.", 'interpreter-app layout --help');
    }

    const layoutPath = argvList[2];
    const remaining = argvList.slice(3);
    let value;
    const layoutValueFlags = ['--json', '--json-file', '--stdin-json'];

    if (remaining[0] === '--json') {
      if (remaining.length !== 2) failWithHelp('--json expects exactly one JSON value.', 'interpreter-app layout --help');
      value = parseJsonWithHelp(remaining[1], \`Layout value for \${quote(layoutPath)}\`, 'interpreter-app layout --help');
    } else if (remaining[0] === '--json-file') {
      if (remaining.length !== 2) failWithHelp('--json-file expects exactly one path.', 'interpreter-app layout --help');
      value = parseJsonWithHelp(fs.readFileSync(remaining[1], 'utf8'), \`Layout value from \${quote(remaining[1])}\`, 'interpreter-app layout --help');
    } else if (remaining[0] === '--stdin-json') {
      if (remaining.length !== 1) failWithHelp('--stdin-json does not take extra arguments.', 'interpreter-app layout --help');
      value = parseJsonWithHelp(await readStdin(), \`Layout value for \${quote(layoutPath)}\`, 'interpreter-app layout --help');
    } else {
      if (remaining[0].startsWith('-')) {
        failUnknownFlag(remaining[0], layoutValueFlags, 'interpreter-app layout --help');
      }
      value = parseJsonWithHelp(remaining.join(' '), \`Layout value for \${quote(layoutPath)}\`, 'interpreter-app layout --help');
    }

    await request(\`\${baseUrl}/api/interpreter-cli/layout/set\`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: stringifyJson({ path: layoutPath, value }),
    });
    return;
  }

  failUnknownChoice('command', command, topLevelCommands, 'interpreter-app --help');
}

main().catch((error) => {
    if (error instanceof Error) {
      fail(error.stack || error.message);
    }
    fail(String(error));
  });
`;
}

function buildWindowsInterpreterCliPowerShellScript(): string {
  return `$ErrorActionPreference = 'Stop'

$callerToken = $env:${INTERPRETER_CALLER_TOKEN_ENV}
$serverConnectionEnv = $env:${INTERPRETER_CLI_SERVER_CONNECTION_ENV}
function Show-Usage {
  [Console]::Error.WriteLine('Usage:')
  [Console]::Error.WriteLine('  interpreter-app tools list [server-id]')
  [Console]::Error.WriteLine('  interpreter-app tools find <query>')
  [Console]::Error.WriteLine('  interpreter-app tools <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]')
  [Console]::Error.WriteLine('  interpreter-app mcp list [server-id]')
  [Console]::Error.WriteLine('  interpreter-app mcp find <query>')
  [Console]::Error.WriteLine('  interpreter-app mcp <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]')
  [Console]::Error.WriteLine('  interpreter-app config get [path]')
  [Console]::Error.WriteLine('  interpreter-app config set <path> [<string-value> | --value <string> | --bool <true|false> | --number <number> | --null | --json <json> | --json-file <path> | --stdin-json] [--restart-runtime]')
  [Console]::Error.WriteLine('  interpreter-app config restart-runtime [--reason <text>]')
  [Console]::Error.WriteLine('  interpreter-app layout get [path]')
  [Console]::Error.WriteLine('  interpreter-app layout set <path> [<json-value> | --json <json> | --json-file <path> | --stdin-json]')
}

function Show-ToolsUsage {
  [Console]::Error.WriteLine('Usage:')
  [Console]::Error.WriteLine('  interpreter-app tools list [server-id]')
  [Console]::Error.WriteLine('  interpreter-app tools find <query>')
  [Console]::Error.WriteLine('  interpreter-app tools <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]')
  [Console]::Error.WriteLine('Notes:')
  [Console]::Error.WriteLine('  interpreter-app tools list lists visible servers only.')
  [Console]::Error.WriteLine('  interpreter-app tools list <server-id> lists tools on that server.')
  [Console]::Error.WriteLine('  Top-level tools list does not list individual tools.')
  [Console]::Error.WriteLine('  Many built-in tools live on shared servers such as builtin-interpreter.')
  [Console]::Error.WriteLine('Tips:')
  [Console]::Error.WriteLine('  interpreter-app tools list builtin-interpreter')
  [Console]::Error.WriteLine('  interpreter-app tools find interpreter_vault')
  [Console]::Error.WriteLine('  interpreter-app tools find \"read word docx\"')
  [Console]::Error.WriteLine('  interpreter-app tools <server-id> <tool-name> --help')
  [Console]::Error.WriteLine('  interpreter-app tools <server-id>__<tool-name> --help')
  [Console]::Error.WriteLine('Examples:')
  [Console]::Error.WriteLine('  interpreter-app tools builtin-docx read_word --json ''{\"path\":\"Notes.docx\"}''')
  [Console]::Error.WriteLine('  interpreter-app tools builtin-pdf read_pdf --json ''{\"path\":\"packet.pdf\"}''')
  [Console]::Error.WriteLine('  interpreter-app tools builtin-interpreter interpreter_refresh_file --json ''{\"path\":\"report.xlsx\"}''')
}

function Show-McpUsage {
  [Console]::Error.WriteLine('Usage:')
  [Console]::Error.WriteLine('  interpreter-app mcp list [server-id]')
  [Console]::Error.WriteLine('  interpreter-app mcp find <query>')
  [Console]::Error.WriteLine('  interpreter-app mcp <server-id> <tool-name> [--json <json> | --json-file <path> | --stdin-json] [--stdin-arg <key>] [--save-to-disk [path]]')
  [Console]::Error.WriteLine('Examples:')
  [Console]::Error.WriteLine('  interpreter-app mcp filesystem read_file --json ''{\"path\":\"README.md\"}''')
  [Console]::Error.WriteLine('  interpreter-app mcp docs search --json ''{\"query\":\"release notes\"}''')
}

function Parse-QualifiedToolTarget {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $delimiterIndex = $Value.IndexOf('__')
  if ($delimiterIndex -le 0 -or $delimiterIndex -ge ($Value.Length - 2)) {
    return $null
  }

  return @{
    serverId = $Value.Substring(0, $delimiterIndex)
    toolName = $Value.Substring($delimiterIndex + 2)
  }
}

function Test-ToolFlag {
  param([string]$Value)
  return $Value -eq '--help' -or $Value -eq '-h' -or $Value.StartsWith('--')
}

function Show-ConfigUsage {
  [Console]::Error.WriteLine('Usage:')
  [Console]::Error.WriteLine('  interpreter-app config get [path]')
  [Console]::Error.WriteLine('  interpreter-app config set <path> [<string-value> | --value <string> | --bool <true|false> | --number <number> | --null | --json <json> | --json-file <path> | --stdin-json] [--restart-runtime]')
  [Console]::Error.WriteLine('  interpreter-app config restart-runtime [--reason <text>]')
  [Console]::Error.WriteLine('Examples:')
  [Console]::Error.WriteLine('  interpreter-app config get')
  [Console]::Error.WriteLine('  interpreter-app config get theme')
  [Console]::Error.WriteLine('  interpreter-app config get agentAccess')
  [Console]::Error.WriteLine('  interpreter-app config set agentAccess.network --bool true')
  [Console]::Error.WriteLine('  interpreter-app config set agentAccess.network --bool true --restart-runtime')
  [Console]::Error.WriteLine('Current Settings tabs: ${INTERPRETER_SETTINGS_TAB_LIST}')
  [Console]::Error.WriteLine('Common settings you can change:')
  [Console]::Error.WriteLine('${INTERPRETER_CONFIG_COMMON_SETTINGS_LIST}')
  [Console]::Error.WriteLine('Config aliases: ${INTERPRETER_CONFIG_ALIAS_LIST}')
  [Console]::Error.WriteLine('Behavior: Runtime permission changes like sandbox, read scope, and network access take effect after Interpreter restarts. Approval policy changes apply immediately. --restart-runtime asks whether to reset Interpreter''s agent runtime now. config restart-runtime asks without changing another setting. Restarting stops running conversations for every agent.')
}

function Show-LayoutUsage {
  [Console]::Error.WriteLine('Usage:')
  [Console]::Error.WriteLine('  interpreter-app layout get [path]')
  [Console]::Error.WriteLine('  interpreter-app layout set <path> [<json-value> | --json <json> | --json-file <path> | --stdin-json]')
}

function Write-HelpHint([string]$helpCommand) {
  if (-not [string]::IsNullOrWhiteSpace($helpCommand)) {
    [Console]::Error.WriteLine("Run '$helpCommand'.")
  }
}

function Fail-WithHelp([string]$message, [string]$helpCommand) {
  [Console]::Error.WriteLine($message)
  Write-HelpHint $helpCommand
  exit 1
}

function Test-InterpreterCliToolErrorResult([string]$rawResult) {
  try {
    $parsed = $rawResult | ConvertFrom-Json
    return ($parsed.isError -eq $true) -or ($parsed.is_error -eq $true)
  } catch {
    return $false
  }
}

function New-InterpreterCliFileBridgeRequest([string]$bridgeDir) {
  $stagingRoot = Join-Path $bridgeDir 'request-staging'
  $requestsRoot = Join-Path $bridgeDir 'requests'
  New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $requestsRoot | Out-Null

  $requestId = "req-$([guid]::NewGuid().ToString('N'))"
  $stagingDir = Join-Path $stagingRoot $requestId
  $requestDir = Join-Path $requestsRoot $requestId
  New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

  return @{
    requestId = $requestId
    stagingDir = $stagingDir
    requestDir = $requestDir
  }
}

function Write-InterpreterCliFileBridgeField([string]$dir, [string]$name, [string]$value) {
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText((Join-Path $dir $name), $value, $utf8NoBom)
}

function Invoke-InterpreterCliFileBridgeFields([string]$bridgeDir, [hashtable]$fields) {
  $request = New-InterpreterCliFileBridgeRequest $bridgeDir
  foreach ($entry in $fields.GetEnumerator()) {
    if ($null -ne $entry.Value) {
      Write-InterpreterCliFileBridgeField $request.stagingDir $entry.Key ([string]$entry.Value)
    }
  }
  Publish-InterpreterCliFileBridgeRequest $request
  Invoke-InterpreterCliFileBridgeRequest $bridgeDir $request.requestId
}

function Publish-InterpreterCliFileBridgeRequest([hashtable]$request) {
  Move-Item -LiteralPath $request.stagingDir -Destination $request.requestDir
  New-Item -ItemType File -Force -Path (Join-Path $request.requestDir '.ready') | Out-Null
}

function Invoke-InterpreterCliFileBridgeRequest([string]$bridgeDir, [string]$requestId) {
  $requestDir = Join-Path (Join-Path $bridgeDir 'requests') $requestId
  $responseDir = Join-Path (Join-Path $bridgeDir 'responses') $requestId
  $responseStatusPath = Join-Path $responseDir 'status'
  $responseBodyPath = Join-Path $responseDir 'body'
  $responseProgressPath = Join-Path $responseDir 'progress'
  $progressChars = 0

  New-Item -ItemType Directory -Force -Path $responseDir | Out-Null

  function Flush-InterpreterCliFileBridgeProgress {
    if (-not (Test-Path -LiteralPath $responseProgressPath)) {
      return
    }

    $progress = Get-Content -LiteralPath $responseProgressPath -Raw
    if ($null -eq $progress -or $progress.Length -le $progressChars) {
      return
    }

    [Console]::Error.Write($progress.Substring($progressChars))
    Set-Variable -Name progressChars -Scope 1 -Value $progress.Length
  }

  while (-not (Test-Path -LiteralPath $responseStatusPath)) {
    if (-not (Test-Path -LiteralPath $bridgeDir)) {
      Remove-Item -LiteralPath $requestDir -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $responseDir -Recurse -Force -ErrorAction SilentlyContinue
      throw 'Interpreter CLI bridge disconnected while waiting for response.'
    }

    Flush-InterpreterCliFileBridgeProgress
    Start-Sleep -Milliseconds 50
  }

  Flush-InterpreterCliFileBridgeProgress

  $responseStatus = (Get-Content -LiteralPath $responseStatusPath -Raw).Trim()
  $body = ''
  if (Test-Path -LiteralPath $responseBodyPath) {
    $body = Get-Content -LiteralPath $responseBodyPath -Raw
  }

  Remove-Item -LiteralPath $requestDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $responseDir -Recurse -Force -ErrorAction SilentlyContinue

  if ($responseStatus -eq 'ok') {
    [Console]::Out.Write($body)
    if (Test-InterpreterCliToolErrorResult $body) {
      exit 1
    }
    return
  }

  if (-not [string]::IsNullOrWhiteSpace($body)) {
    [Console]::Error.WriteLine($body)
  }
  exit 1
}

function Get-GetSetSuggestion([string]$value) {
  switch -Regex ($value) {
    '^(g|ge|gett|gets|fetch)$' { return 'get' }
    '^(s|se|sett|sets|update)$' { return 'set' }
    '^(restart|restart-runtime|runtime-restart|refresh|refresh-runtime)$' { return 'restart-runtime' }
    default { return $null }
  }
}

$serverConnection = $serverConnectionEnv.Trim()

if ([string]::IsNullOrWhiteSpace($serverConnection)) {
  [Console]::Error.WriteLine('Missing ${INTERPRETER_CLI_SERVER_CONNECTION_ENV} in shell environment')
  exit 1
}

$transportMode = ''
$transportTarget = ''
if ($serverConnection.StartsWith('http:')) {
  $transportMode = 'http'
  $transportTarget = $serverConnection.Substring(5)
} elseif ($serverConnection.StartsWith('file:')) {
  $transportMode = 'file'
  $transportTarget = $serverConnection.Substring(5)
} elseif ($serverConnection.StartsWith('unix:')) {
  $transportMode = 'unix'
  $transportTarget = $serverConnection.Substring(5)
} else {
  [Console]::Error.WriteLine("Unsupported interpreter CLI connection mode: $serverConnection")
  exit 1
}

if ([string]::IsNullOrWhiteSpace($callerToken)) {
  [Console]::Error.WriteLine('Missing ${INTERPRETER_CALLER_TOKEN_ENV} in shell environment')
  exit 1
}

$argvList = @($args)
$headers = @{ '${INTERPRETER_CLI_CALLER_TOKEN_HEADER}' = $callerToken }

function Invoke-InterpreterCliToolStream([string]$uri, [string]$body) {
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $client = [System.Net.Http.HttpClient]::new($handler)
  $request = $null
  $response = $null

  try {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $uri)
    $request.Headers.Add('${INTERPRETER_CLI_CALLER_TOKEN_HEADER}', $callerToken)
    $request.Headers.ConnectionClose = $true
    $request.Content = [System.Net.Http.StringContent]::new($body, [System.Text.Encoding]::UTF8, 'application/json')

    $response = $client.SendAsync(
      $request,
      [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
    ).GetAwaiter().GetResult()

    if (-not $response.IsSuccessStatusCode) {
      $errorBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if (-not [string]::IsNullOrWhiteSpace($errorBody)) {
        [Console]::Error.WriteLine($errorBody)
      }
      exit 1
    }

    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $reader = [System.IO.StreamReader]::new($stream)
    $finalResult = $null
    $sawError = $false

    while (-not $reader.EndOfStream) {
      $line = $reader.ReadLine()
      if ([string]::IsNullOrEmpty($line)) {
        continue
      }
      if ($line.StartsWith('progress ')) {
        [Console]::Error.WriteLine($line.Substring(9))
        continue
      }
      if ($line.StartsWith('result ')) {
        $finalResult = $line.Substring(7)
        continue
      }
      if ($line.StartsWith('error ')) {
        $sawError = $true
        [Console]::Error.WriteLine($line.Substring(6))
        continue
      }
      [Console]::Error.WriteLine($line)
    }

    if ($sawError) {
      exit 1
    }

    if ($null -eq $finalResult) {
      throw 'Interpreter CLI stream ended without a result.'
    }

    [Console]::Out.Write($finalResult)
    if (Test-InterpreterCliToolErrorResult $finalResult) {
      exit 1
    }
    exit 0
  } finally {
    if ($null -ne $response) {
      $response.Dispose()
    }
    if ($null -ne $request) {
      $request.Dispose()
    }
    $client.Dispose()
    $handler.Dispose()
  }
}

if ($argvList.Count -eq 0 -or $argvList[0] -eq '--help' -or $argvList[0] -eq '-h' -or $argvList[0] -eq 'help') {
  Show-Usage
  exit 0
}

$command = $argvList[0]
if ($command -eq 'mcp') {
  if ($argvList.Count -eq 1 -or $argvList[1] -eq '--help' -or $argvList[1] -eq '-h') {
    Show-McpUsage
    exit 0
  }
  $command = 'tools'
}

switch ($command) {
  'tools' {
    if ($argvList.Count -eq 1 -or $argvList[1] -eq '--help' -or $argvList[1] -eq '-h') {
      Show-ToolsUsage
      exit 0
    }

    $subcommand = $argvList[1]
    $remaining = @()
    if ($argvList.Count -gt 2) {
      $remaining = $argvList[2..($argvList.Count - 1)]
    }

    switch ($subcommand) {
      'list' {
        if ($remaining.Count -gt 1) {
          Fail-WithHelp "Expected 'interpreter-app tools list' or 'interpreter-app tools list <server-id>'." 'interpreter-app tools --help'
        }
        if ($transportMode -eq 'file') {
          if ($remaining.Count -eq 1) {
            Invoke-InterpreterCliFileBridgeFields $transportTarget @{
              kind = 'list-server-tools'
              'caller-token' = $callerToken
              'server-id' = $remaining[0]
            }
          } else {
            Invoke-InterpreterCliFileBridgeFields $transportTarget @{
              kind = 'list'
              'caller-token' = $callerToken
            }
          }
          return
        }

        if ($transportMode -ne 'http') {
          throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
        }
        if ($remaining.Count -eq 1) {
          $result = Invoke-RestMethod -Method Get -Uri "$transportTarget/api/interpreter-cli/tools/$($remaining[0])" -Headers $headers
        } else {
          $result = Invoke-RestMethod -Method Get -Uri "$transportTarget/api/interpreter-cli/tools" -Headers $headers
        }
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      'find' {
        if ($remaining.Count -lt 1) {
          Fail-WithHelp "Expected 'interpreter-app tools find <query>'." 'interpreter-app tools --help'
        }
        if ($transportMode -eq 'file') {
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'find-tools'
            'caller-token' = $callerToken
            query = ($remaining -join ' ')
          }
          return
        }
        if ($transportMode -ne 'http') {
          throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
        }
        $result = Invoke-RestMethod -Method Post -Uri "$transportTarget/api/interpreter-cli/tools/find" -Headers $headers -ContentType 'application/json' -Body (@{ query = ($remaining -join ' ') } | ConvertTo-Json -Compress)
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      'search' {
        if ($remaining.Count -lt 1) {
          Fail-WithHelp "Expected 'interpreter-app tools find <query>'." 'interpreter-app tools --help'
        }
        if ($transportMode -eq 'file') {
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'find-tools'
            'caller-token' = $callerToken
            query = ($remaining -join ' ')
          }
          return
        }
        if ($transportMode -ne 'http') {
          throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
        }
        $result = Invoke-RestMethod -Method Post -Uri "$transportTarget/api/interpreter-cli/tools/find" -Headers $headers -ContentType 'application/json' -Body (@{ query = ($remaining -join ' ') } | ConvertTo-Json -Compress)
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      'help' {
        if ($remaining.Count -eq 1) {
          $qualifiedTarget = Parse-QualifiedToolTarget $remaining[0]
          if ($null -ne $qualifiedTarget) {
            if ($transportMode -eq 'file') {
              Invoke-InterpreterCliFileBridgeFields $transportTarget @{
                kind = 'describe'
                'caller-token' = $callerToken
                'server-id' = $qualifiedTarget.serverId
                'tool-name' = $qualifiedTarget.toolName
              }
              return
            }
            if ($transportMode -ne 'http') {
              throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
            }
            $result = Invoke-RestMethod -Method Get -Uri "$transportTarget/api/interpreter-cli/tools/$($qualifiedTarget.serverId)/$($qualifiedTarget.toolName)" -Headers $headers
            $result | ConvertTo-Json -Depth 100
            exit 0
          }
        }
        if ($remaining.Count -ne 2) {
          Fail-WithHelp "Expected 'interpreter-app tools <server-id> <tool-name> --help' or 'interpreter-app tools <server-id>__<tool-name> --help'." 'interpreter-app tools --help'
        }
        if ($transportMode -eq 'file') {
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'describe'
            'caller-token' = $callerToken
            'server-id' = $remaining[0]
            'tool-name' = $remaining[1]
          }
          return
        }
        if ($transportMode -ne 'http') {
          throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
        }
        $result = Invoke-RestMethod -Method Get -Uri "$transportTarget/api/interpreter-cli/tools/$($remaining[0])/$($remaining[1])" -Headers $headers
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      'describe' {
        if ($remaining.Count -eq 1) {
          $qualifiedTarget = Parse-QualifiedToolTarget $remaining[0]
          if ($null -ne $qualifiedTarget) {
            if ($transportMode -eq 'file') {
              Invoke-InterpreterCliFileBridgeFields $transportTarget @{
                kind = 'describe'
                'caller-token' = $callerToken
                'server-id' = $qualifiedTarget.serverId
                'tool-name' = $qualifiedTarget.toolName
              }
              return
            }
            if ($transportMode -ne 'http') {
              throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
            }
            $result = Invoke-RestMethod -Method Get -Uri "$transportTarget/api/interpreter-cli/tools/$($qualifiedTarget.serverId)/$($qualifiedTarget.toolName)" -Headers $headers
            $result | ConvertTo-Json -Depth 100
            exit 0
          }
        }
        if ($remaining.Count -ne 2) {
          Fail-WithHelp "Expected 'interpreter-app tools <server-id> <tool-name> --help' or 'interpreter-app tools <server-id>__<tool-name> --help'." 'interpreter-app tools --help'
        }
        if ($transportMode -eq 'file') {
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'describe'
            'caller-token' = $callerToken
            'server-id' = $remaining[0]
            'tool-name' = $remaining[1]
          }
          return
        }
        if ($transportMode -ne 'http') {
          throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
        }
        $result = Invoke-RestMethod -Method Get -Uri "$transportTarget/api/interpreter-cli/tools/$($remaining[0])/$($remaining[1])" -Headers $headers
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      default {
        $qualifiedTarget = Parse-QualifiedToolTarget $subcommand
        $useQualifiedTarget = $null -ne $qualifiedTarget -and ($remaining.Count -eq 0 -or (Test-ToolFlag $remaining[0]))
        if ($useQualifiedTarget) {
          $serverId = $qualifiedTarget.serverId
          $toolName = $qualifiedTarget.toolName
          $flagIndex = 0
        } else {
          if ($remaining.Count -lt 1) {
            Fail-WithHelp "Expected 'interpreter-app tools <server-id> <tool-name>' or 'interpreter-app tools <server-id>__<tool-name>'." 'interpreter-app tools --help'
          }
          $serverId = $subcommand
          $toolName = $remaining[0]
          $flagIndex = 1
        }
        if ($remaining.Count -eq ($flagIndex + 1) -and ($remaining[$flagIndex] -eq '--help' -or $remaining[$flagIndex] -eq '-h')) {
          if ($transportMode -eq 'file') {
            Invoke-InterpreterCliFileBridgeFields $transportTarget @{
              kind = 'describe'
              'caller-token' = $callerToken
              'server-id' = $serverId
              'tool-name' = $toolName
            }
            return
          }
          if ($transportMode -ne 'http') {
            throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
          }
          $result = Invoke-RestMethod -Method Get -Uri "$transportTarget/api/interpreter-cli/tools/$serverId/$($toolName)" -Headers $headers
          $result | ConvertTo-Json -Depth 100
          exit 0
        }

        $argsJson = '{}'
        $saveToDisk = 'false'
        $saveToDiskPath = ''
        $stdinArgKey = $null
        $stdinJsonUsed = $false
        $index = $flagIndex

        while ($index -lt $remaining.Count) {
          switch ($remaining[$index]) {
            '--json' {
              if ($index + 1 -ge $remaining.Count) {
                throw 'Missing value for --json'
              }
              $argsJson = $remaining[$index + 1]
              $index += 2
              continue
            }
            '--json-file' {
              if ($index + 1 -ge $remaining.Count) {
                throw 'Missing value for --json-file'
              }
              $argsJson = Get-Content -LiteralPath $remaining[$index + 1] -Raw
              $index += 2
              continue
            }
            '--stdin-json' {
              $argsJson = [Console]::In.ReadToEnd()
              $stdinJsonUsed = $true
              $index += 1
              continue
            }
            '--stdin-arg' {
              if ($index + 1 -ge $remaining.Count) {
                throw 'Missing key for --stdin-arg'
              }
              $stdinArgKey = $remaining[$index + 1]
              $index += 2
              continue
            }
            '--save-to-disk' {
              $saveToDisk = 'true'
              if ($index + 1 -lt $remaining.Count -and -not $remaining[$index + 1].StartsWith('--')) {
                $saveToDiskPath = $remaining[$index + 1]
                $index += 2
              } else {
                $index += 1
              }
              continue
            }
            default {
              Fail-WithHelp "Unknown argument '$($remaining[$index])'. Supported flags: --json, --json-file, --stdin-json, --stdin-arg, --save-to-disk." "interpreter-app tools $serverId $toolName --help"
            }
          }
        }

        if ($null -ne $stdinArgKey) {
          if ($stdinJsonUsed) {
            Fail-WithHelp '--stdin-arg cannot be combined with --stdin-json.' "interpreter-app tools $serverId $toolName --help"
          }
          $parsedArgs = $null
          if ([string]::IsNullOrWhiteSpace($argsJson)) {
            $parsedArgs = [pscustomobject]@{}
          } else {
            try {
              $parsedArgs = $argsJson | ConvertFrom-Json
            } catch {
              $parsedArgs = $null
            }
          }
          if ($null -eq $parsedArgs -or -not ($parsedArgs -is [System.Management.Automation.PSCustomObject])) {
            Fail-WithHelp '--stdin-arg requires the --json/--json-file value to be a JSON object.' "interpreter-app tools $serverId $toolName --help"
          }
          $stdinArgValue = [Console]::In.ReadToEnd()
          $parsedArgs | Add-Member -MemberType NoteProperty -Name $stdinArgKey -Value $stdinArgValue -Force
          $argsJson = $parsedArgs | ConvertTo-Json -Depth 100 -Compress
        }

        if ($transportMode -eq 'file') {
          $saveToDiskPathField = $null
          if (-not [string]::IsNullOrWhiteSpace($saveToDiskPath)) {
            $saveToDiskPathField = $saveToDiskPath
          }
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'call'
            'caller-token' = $callerToken
            'server-id' = $serverId
            'tool-name' = $toolName
            'args.json' = $argsJson
            'save-to-disk' = $saveToDisk
            'save-to-disk-path' = $saveToDiskPathField
          }
          return
        }

        if ($transportMode -ne 'http') {
          throw "Unsupported interpreter CLI connection mode on Windows: $transportMode"
        }
        $query = "saveToDisk=$saveToDisk"
        if (-not [string]::IsNullOrWhiteSpace($saveToDiskPath)) {
          $query = "$query&saveToDiskPath=$([uri]::EscapeDataString($saveToDiskPath))"
        }
        Invoke-InterpreterCliToolStream "$transportTarget/api/interpreter-cli/tools/$serverId/$($toolName)/stream?$query" $argsJson
      }
    }
  }
  'config' {
    if ($argvList.Count -eq 1 -or $argvList[1] -eq '--help' -or $argvList[1] -eq '-h' -or $argvList[1] -eq 'help') {
      Show-ConfigUsage
      exit 0
    }

    $subcommand = $argvList[1]
    switch ($subcommand) {
      'get' {
        if ($argvList.Count -gt 3) {
          Fail-WithHelp "'interpreter-app config get' accepts at most one optional path." 'interpreter-app config --help'
        }
        $configPath = ''
        if ($argvList.Count -eq 3) {
          $configPath = $argvList[2]
        }
        if ($transportMode -eq 'file') {
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'config-get'
            'caller-token' = $callerToken
            path = $configPath
          }
          return
        }
        $body = @{ path = $configPath } | ConvertTo-Json -Depth 100 -Compress
        $result = Invoke-RestMethod -Method Post -Uri "$transportTarget/api/interpreter-cli/config/get" -Headers $headers -ContentType 'application/json' -Body $body
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      'restart-runtime' {
        $reason = 'A fresh runtime snapshot is needed.'
        $remaining = @()
        if ($argvList.Count -gt 2) {
          $remaining = $argvList[2..($argvList.Count - 1)]
        }
        $index = 0
        while ($index -lt $remaining.Count) {
          if ($remaining[$index] -eq '--reason') {
            if (($index + 1) -ge $remaining.Count) {
              Fail-WithHelp 'Missing value for --reason.' 'interpreter-app config --help'
            }
            $reason = $remaining[$index + 1]
            $index += 2
            continue
          }
          Fail-WithHelp "Unknown argument '$($remaining[$index])'. Expected --reason <text>." 'interpreter-app config --help'
        }
        if ($transportMode -eq 'file') {
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'config-restart-runtime'
            'caller-token' = $callerToken
            reason = $reason
          }
          return
        }
        $body = @{ reason = $reason } | ConvertTo-Json -Depth 100 -Compress
        $result = Invoke-RestMethod -Method Post -Uri "$transportTarget/api/interpreter-cli/config/restart-runtime" -Headers $headers -ContentType 'application/json' -Body $body
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      'set' {
        if ($argvList.Count -lt 4) {
          Fail-WithHelp "Expected 'interpreter-app config set <path> <value>'." 'interpreter-app config --help'
        }

        $configPath = $argvList[2]
        $remaining = @()
        if ($argvList.Count -gt 3) {
          $remaining = $argvList[3..($argvList.Count - 1)]
        }
        $restartRuntime = $remaining -contains '--restart-runtime'
        $valueArgs = @($remaining | Where-Object { $_ -ne '--restart-runtime' })

        if ($valueArgs[0] -eq '--json') {
          if ($valueArgs.Count -lt 2) { throw 'Missing value for --json' }
          $value = $valueArgs[1] | ConvertFrom-Json
        } elseif ($valueArgs[0] -eq '--json-file') {
          if ($valueArgs.Count -lt 2) { throw 'Missing value for --json-file' }
          $value = (Get-Content -LiteralPath $valueArgs[1] -Raw) | ConvertFrom-Json
        } elseif ($valueArgs[0] -eq '--stdin-json') {
          $value = ([Console]::In.ReadToEnd()) | ConvertFrom-Json
        } elseif ($valueArgs[0] -eq '--value') {
          if ($valueArgs.Count -lt 2) { throw 'Missing value for --value' }
          $value = $valueArgs[1]
        } elseif ($valueArgs[0] -eq '--bool') {
          if ($valueArgs.Count -lt 2) { throw 'Missing value for --bool' }
          if ($valueArgs[1] -ne 'true' -and $valueArgs[1] -ne 'false') { throw '--bool expects true or false' }
          $value = ($valueArgs[1] -eq 'true')
        } elseif ($valueArgs[0] -eq '--number') {
          if ($valueArgs.Count -lt 2) { throw 'Missing value for --number' }
          $value = [double]$valueArgs[1]
        } elseif ($valueArgs[0] -eq '--null') {
          $value = $null
        } else {
          $value = [string]::Join(' ', $valueArgs)
        }

        $payload = @{ path = $configPath; value = $value }
        if ($restartRuntime) {
          $payload.restart_runtime = $true
        }
        if ($transportMode -eq 'file') {
          $restartRuntimeField = 'false'
          if ($restartRuntime) {
            $restartRuntimeField = 'true'
          }
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'config-set'
            'caller-token' = $callerToken
            path = $configPath
            'value.json' = ($value | ConvertTo-Json -Depth 100 -Compress)
            'restart-runtime' = $restartRuntimeField
          }
          return
        }
        $body = $payload | ConvertTo-Json -Depth 100 -Compress
        $result = Invoke-RestMethod -Method Post -Uri "$transportTarget/api/interpreter-cli/config/set" -Headers $headers -ContentType 'application/json' -Body $body
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      default {
        $suggestion = Get-GetSetSuggestion $subcommand
        if ($suggestion) {
          Fail-WithHelp "Unknown config command '$subcommand'. Did you mean '$suggestion'?" 'interpreter-app config --help'
        }
        Fail-WithHelp "Unknown config command '$subcommand'. Expected one of: get, set, restart-runtime." 'interpreter-app config --help'
      }
    }
  }
  'layout' {
    if ($argvList.Count -eq 1 -or $argvList[1] -eq '--help' -or $argvList[1] -eq '-h' -or $argvList[1] -eq 'help') {
      Show-LayoutUsage
      exit 0
    }

    $subcommand = $argvList[1]
    switch ($subcommand) {
      'get' {
        if ($argvList.Count -gt 3) {
          Fail-WithHelp "'interpreter-app layout get' accepts at most one optional path." 'interpreter-app layout --help'
        }
        $layoutPath = ''
        if ($argvList.Count -eq 3) {
          $layoutPath = $argvList[2]
        }
        if ($transportMode -eq 'file') {
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'layout-get'
            'caller-token' = $callerToken
            path = $layoutPath
          }
          return
        }
        $body = @{ path = $layoutPath } | ConvertTo-Json -Depth 100 -Compress
        $result = Invoke-RestMethod -Method Post -Uri "$transportTarget/api/interpreter-cli/layout/get" -Headers $headers -ContentType 'application/json' -Body $body
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      'set' {
        if ($argvList.Count -lt 4) {
          Fail-WithHelp "Expected 'interpreter-app layout set <path> <json-value>'." 'interpreter-app layout --help'
        }

        $layoutPath = $argvList[2]
        $remaining = @()
        if ($argvList.Count -gt 3) {
          $remaining = $argvList[3..($argvList.Count - 1)]
        }

        if ($remaining[0] -eq '--json') {
          if ($remaining.Count -lt 2) { throw 'Missing value for --json' }
          $value = $remaining[1] | ConvertFrom-Json
        } elseif ($remaining[0] -eq '--json-file') {
          if ($remaining.Count -lt 2) { throw 'Missing value for --json-file' }
          $value = (Get-Content -LiteralPath $remaining[1] -Raw) | ConvertFrom-Json
        } elseif ($remaining[0] -eq '--stdin-json') {
          $value = ([Console]::In.ReadToEnd()) | ConvertFrom-Json
        } else {
          $value = ([string]::Join(' ', $remaining)) | ConvertFrom-Json
        }

        if ($transportMode -eq 'file') {
          Invoke-InterpreterCliFileBridgeFields $transportTarget @{
            kind = 'layout-set'
            'caller-token' = $callerToken
            path = $layoutPath
            'value.json' = ($value | ConvertTo-Json -Depth 100 -Compress)
          }
          return
        }

        $body = @{ path = $layoutPath; value = $value } | ConvertTo-Json -Depth 100 -Compress
        $result = Invoke-RestMethod -Method Post -Uri "$transportTarget/api/interpreter-cli/layout/set" -Headers $headers -ContentType 'application/json' -Body $body
        $result | ConvertTo-Json -Depth 100
        exit 0
      }
      default {
        $suggestion = Get-GetSetSuggestion $subcommand
        if ($suggestion) {
          Fail-WithHelp "Unknown layout command '$subcommand'. Did you mean '$suggestion'?" 'interpreter-app layout --help'
        }
        Fail-WithHelp "Unknown layout command '$subcommand'. Expected 'get' or 'set'." 'interpreter-app layout --help'
      }
    }
  }
  default {
    Fail-WithHelp "Unknown command '$command'. Expected one of: tools, config, layout." 'interpreter-app --help'
  }
}
`;
}

export function ensureInterpreterCliLauncher(
  platform: NodeJS.Platform = process.platform,
): string {
  const runtimeDir = getInterpreterCliRuntimeDir();
  const launcherDir = getInterpreterCliLauncherDir();
  const launcherPath = getInterpreterCliExecutablePath(platform);

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(launcherDir, { recursive: true });
  removeLegacyInterpreterLaunchers(launcherDir);

  if (platform === 'win32') {
    const powerShellPath = getWindowsInterpreterCliPowerShellPath();
    const nodeScriptPath = getWindowsInterpreterCliNodeScriptPath();
    writeFileSync(nodeScriptPath, buildWindowsInterpreterCliNodeScript(), 'utf8');
    writeFileSync(powerShellPath, buildWindowsInterpreterCliPowerShellScript(), 'utf8');
    writeFileSync(launcherPath, buildWindowsInterpreterCliCmdScript(nodeScriptPath, powerShellPath), 'utf8');
    return launcherPath;
  }

  const script = buildUnixInterpreterCliScript();
  writeFileSync(launcherPath, script, 'utf8');
  chmodSync(launcherPath, 0o755);
  return launcherPath;
}

function ensureInterpreterCliShellSafeLauncher(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    return ensureInterpreterCliLauncher(platform);
  }

  const shellSafeDir = getInterpreterCliShellSafeLauncherDir(platform, homeDir);
  const shellSafePath = getInterpreterCliShellSafeExecutablePath(platform, homeDir);
  mkdirSync(shellSafeDir, { recursive: true });
  writeFileSync(shellSafePath, buildUnixInterpreterCliShellSafeScript(), 'utf8');
  chmodSync(shellSafePath, 0o755);
  return shellSafePath;
}

function ensureInterpreterCliShellInit(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): void {
  if (platform === 'win32') {
    return;
  }

  const shellInitDir = getInterpreterCliShellInitDir(platform, homeDir);
  const initScript = buildUnixInterpreterCliShellInitScript();
  mkdirSync(shellInitDir, { recursive: true });
  writeFileSync(getInterpreterCliZshInitPath(platform, homeDir), initScript, 'utf8');
  writeFileSync(getInterpreterCliPosixShellInitPath(platform, homeDir), initScript, 'utf8');
}

export function buildInterpreterCliShellEnvironmentPolicy(
  callerToken: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  _workspacePath?: string,
  serverConnection?: string,
  bundledPdfcpuDir: string | null = resolveBundledPdfcpuDir(platform),
): InterpreterCliShellEnvironmentPolicy {
  const envServerConnection = env[INTERPRETER_CLI_SERVER_CONNECTION_ENV]?.trim();
  const resolvedServerConnection = serverConnection?.trim()
    ? serverConnection.trim()
    : envServerConnection
      ? envServerConnection
      : null;
  const shellSafeHomeDir = getInterpreterCliShellHomeDir(platform, env);
  const launcherPath = ensureInterpreterCliShellSafeLauncher(platform, shellSafeHomeDir);
  const launcherDir = getInterpreterCliShellSafeLauncherDir(platform, shellSafeHomeDir);
  const pathKey = resolvePathEnvKey(env);
  // NOTE(victor): Runtime shell commands do not inherit the app-server process
  // PATH directly. The Rust runtime calls env_clear() for shell tool processes
  // and rebuilds the environment from shell_environment_policy. That means
  // adding bundled CLIs only to the app-server spawn env in app-server-client.ts
  // is not enough: /bin/zsh -lc 'pdfcpu help' will still say command not found
  // if this policy-level PATH does not include the bundled pdfcpu directory.
  // Keep bundled CLI PATH entries here, next to the Interpreter CLI launcher
  // path, because this is the environment shell tool executions actually see.
  // This does not let js_repl directly spawn binaries; js_repl still blocks
  // node:child_process by design.
  const pathWithBundledCli = bundledPdfcpuDir
    ? prependPathEntry(env[pathKey], bundledPdfcpuDir, platform)
    : env[pathKey];
  const nextPath = prependPathEntry(pathWithBundledCli, launcherDir, platform);

  const set: Record<string, string> = {
    [INTERPRETER_CALLER_TOKEN_ENV]: callerToken,
    [INTERPRETER_CLI_PATH_ENV]: launcherPath,
    [pathKey]: nextPath,
  };
  if (resolvedServerConnection) {
    set[INTERPRETER_CLI_SERVER_CONNECTION_ENV] = resolvedServerConnection;
  }

  if (platform !== 'win32') {
    ensureInterpreterCliShellInit(platform, shellSafeHomeDir);
    set.ZDOTDIR = getInterpreterCliShellInitDir(platform, shellSafeHomeDir);
    set.BASH_ENV = getInterpreterCliPosixShellInitPath(platform, shellSafeHomeDir);
    set.ENV = getInterpreterCliPosixShellInitPath(platform, shellSafeHomeDir);
  }

  if (platform === 'win32') {
    for (const key of [
      'SYSTEMROOT',
      'WINDIR',
      'COMSPEC',
      'PATHEXT',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
      'PROGRAMDATA',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'CommonProgramFiles',
      'CommonProgramFiles(x86)',
      'TEMP',
      'TMP',
    ]) {
      const actualKey = resolveEnvKeyCaseInsensitive(env, key);
      const value = actualKey ? env[actualKey] : undefined;
      if (actualKey && value) {
        set[actualKey] = value;
      }
    }
  }

  const inherit = FULL_ENV_MACHINE_MARKERS.some((key) => {
    const actualKey = resolveEnvKeyCaseInsensitive(env, key);
    const value = actualKey ? env[actualKey] : undefined;
    return Boolean(value && value.trim());
  }) ? 'all' : 'core';

  return {
    inherit,
    set,
  };
}

export function materializeInterpreterCliLauncher(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const shellSafeHomeDir = getInterpreterCliShellHomeDir(platform, env);
  const launcherPath = ensureInterpreterCliShellSafeLauncher(platform, shellSafeHomeDir);
  if (platform !== 'win32') {
    ensureInterpreterCliShellInit(platform, shellSafeHomeDir);
  }
  return launcherPath;
}

export function interpreterCliLauncherExists(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return existsSync(getInterpreterCliExecutablePath(platform));
}
