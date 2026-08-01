# Backend Tools & Permissions

## File Access Policy

Builtin tools must respect the global file-access policy. All tools that access files MUST enforce it.

### Permission Levels

| Level | Description |
|-------|-------------|
| `none` | No access (can blacklist specific paths) |
| `read` | Can read files |
| `write` | Can read AND write files |

### Permission Scopes (Precedence Order)

1. **Sandbox** (highest) - `~/.interpreter/sandbox/` - Always read-only
2. **Custom Paths** - Specific file/directory rules (can blacklist!)
3. **Workspace** - Access within current workspace directory
4. **System** (lowest) - Fallback for paths outside workspace

Custom paths can override lower scopes. Example: workspace has `write`, but a custom path can blacklist a subfolder with `none`.

### Data Flow

```
Global file permissions (config)
  └─ globalToFileAccessPolicy()
       └─ GlobalFileAccessResolver
            └─ interpreter-app CLI / toolManager.callTool()
                 └─ filesystemBoundary checks before executing
                      └─ canAccess() resolves access
```

### Declaring File Access in Tools

For simple path arguments, declare `fileAccess` in the tool definition. Permission checks happen automatically in `toolManager.callTool()` via `filesystemBoundary.ts`:

```typescript
export const readFileTool: BuiltinToolDefinition = {
  name: 'read_file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' }
    },
    required: ['path']
  },
  fileAccess: {
    mode: 'read',           // or 'write'
    pathArg: 'path'         // or ['path1', 'path2'] for multiple
  },
  handler: async (args) => {
    const workspace = getCurrentWorkspace();
    const filePath = resolvePathWithWorkspace(args.path, workspace);
    // ...
  }
};
```

### Manual Permission Checks

For complex cases (e.g., array of file paths), check permissions manually in the handler:

```typescript
handler: async (args, context) => {
  const workspace = getCurrentWorkspace();

  if (!workspace) {
    return {
      content: [{ type: 'text', text: 'Error: No workspace set' }],
      isError: true
    };
  }

  const { checkFileAccessPermission } = await import('../../../utils/permissions');

  for (const filePath of args.files) {
    const resolvedPath = resolvePathWithWorkspace(filePath, workspace);

    if (context?.agentId && !checkFileAccessPermission(context.agentId, resolvedPath, 'read', workspace)) {
      return {
        content: [{ type: 'text', text: `Permission denied: ${filePath}` }],
        isError: true
      };
    }
  }
}
```

**Quick check helper:**

```typescript
import { checkFileAccessPermission } from '../../../utils/permissions';

if (!checkFileAccessPermission(context.agentId, filePath, 'read')) {
  return { content: [{ type: 'text', text: 'Permission denied' }], isError: true };
}
```

### Key Files

| File | Purpose |
|------|---------|
| `shared/types/permissions.ts` | `FileAccessPolicy` types, `toRuntimeFileAccessPolicy()` |
| `server/utils/permissions.ts` | `canAccess()`, `checkFileAccessPermission()`, `resolvePathWithWorkspace()` |
| `server/tools/toolManager.ts` | Unified builtin/MCP dispatch for CLI, IPC, and other callers |
| `server/tools/filesystemBoundary.ts` | Auto-checks `fileAccess` before calling builtin handlers |
| `server/globalFileAccessResolver.ts` | Resolves the effective global file-access policy |

### Rules

- **ALWAYS** check permissions before reading/writing files
- Use `fileAccess` declaration when possible (automatic checks)
- Use manual checks for arrays of paths or complex access patterns
- `write` permission includes `read` (don't double-check)
- Tools without file access (email, browser, etc.) don't need permission checks

## Model-Facing Tool Transport

Interpreter workstation tools are model-facing through the `interpreter-app` CLI only.

- Builtins and configured MCP servers are discovered and called through the CLI.
- Do not add a second direct model-facing tool surface for workstation tools.
- Codex-native capabilities such as shell execution and patching remain native runtime features. `js_repl` is a builtin workstation tool (`builtin-js-repl`) backed by a persistent Node kernel in the Express backend (`server/tools/builtin-tools/js-repl/`).

---

## Built-in Tools

Tools are self-contained. They handle their own setup/config internally and return helpful errors if not configured.

**Don't pollute shared interfaces with tool-specific fields.** Tools check their own state.

**UI:** Create `src/components/tool-uis/YourToolUI.tsx`, import in `McpServerCard.tsx`.

---

## MCP Endpoints (CRITICAL DISTINCTION)

There are two route shapes for the terminal MCP server. Using the wrong one will cause bugs:

| Endpoint | Purpose | Behavior |
|----------|---------|----------|
| `/mcp/:profileId/:tabId` | Terminal MCP | Executes tools **immediately** and returns results. Used by terminal tabs running CLI agents directly. `tabId` identifies which tab the agent lives in. |
| `/mcp` | Terminal MCP (anonymous) | Same as above but without profile filtering or tab identity. |

**NO `/mcp/:profileId` ROUTE.** Both `profileId` and `tabId` are always required together. `getMcpArgs(port, profileId, tabId)` builds the URL — if either is missing it falls back to `/mcp`. The `tabId` is passed as `callerTabId` through `BuiltinToolContext` so tools can identify the caller.

**When to use which:**
- **Terminal profiles** (`/mcp/:profileId/:tabId`): Direct tool execution for CLI agents running in terminal tabs with real-time interaction.
- **Anonymous route** (`/mcp`): Same server without profile filtering or tab identity.

**Common mistake:** Assuming `/mcp/:profileId` exists. It does not. Profile-aware MCP always requires both `profileId` and `tabId`.

---

## Agent Errors

Use `useAgentError().showError('message')` from `agent/contexts/AgentErrorContext.tsx` for agent errors.

---

## Debugging Agent Runtime with curl

When the app is running (`pnpm dev`), you can debug the Codex agent runtime directly over HTTP.

### Why this helps

- The agent runtime uses the Responses API via the Codex app-server bridge.
- UI issues can be isolated by verifying raw SSE output from backend routes.

### Stream endpoint (SSE)

Use `--max-time` so curl does not block forever while waiting for the stream:

```bash
curl -N --max-time 15 -X POST "http://localhost:5177/api/agent/chat/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "name?",
    "profileId": "interpreter",
    "model": "interpreter-smart"
  }'
```

Expected: SSE frames like `event: thread`, `event: delta`, `event: final`, `event: completed`, `event: error`.

### Check headers quickly

```bash
curl -i --max-time 6 -X POST "http://localhost:5177/api/agent/chat/stream" \
  -H "Content-Type: application/json" \
  -d '{"message":"ping","profileId":"interpreter","model":"interpreter-smart"}'
```

Expected headers include:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `Transfer-Encoding: chunked`

### Stop endpoint

```bash
curl -s -X POST "http://localhost:5177/api/agent/chat/stop" \
  -H "Content-Type: application/json" \
  -d '{"threadId":"<thread-id>","turnId":"<optional-turn-id>"}'
```

### Fast diagnosis pattern

1. Stream returns events and logs show codex deltas, but UI stays blank -> frontend event parsing/rendering bug.
2. Stream headers are OK but no events -> backend stream lifecycle/flush/close bug.
3. Stream emits `event: error` with auth/provider details -> profile/provider configuration bug.

---

## Key Constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `OUTPUT_SIZE_THRESHOLD` | 20,000 chars | `server/utils/largeOutputHandler.ts` | Tool output size before writing to sandbox file |

---

## Native Modules & ASAR Unpacking (CRITICAL)

**electron-builder v26+ has issues detecting platform-specific optional dependencies.** Native modules that use separate packages for each platform may not be included in the final build, causing runtime errors like `Cannot find module '@package/name-win32-x64-msvc'`.

### How to Identify Affected Packages

1. **Check the lockfile for platform-specific patterns:**
   ```bash
   grep -E "@.*-(win32|darwin|linux)" pnpm-lock.yaml | grep -E "^  '@" | sort -u
   ```

2. **Look for packages with platform suffixes** like:
   - `@package/name-win32-x64-msvc`
   - `@package/name-darwin-arm64`
   - `@package/name-linux-x64-gnu`

3. **Check `build-electron.mjs` externals** - packages listed there need runtime access and may have native binaries

### Adding Native Modules to asarUnpack

When adding a new native module dependency:

1. Run the grep command above to check if it has platform-specific binaries
2. If yes, add `"node_modules/@package/**"` to `asarUnpack` in `electron-builder.yml`
3. Also add to `external` array in `build-electron.mjs` so esbuild doesn't bundle it

### Why This Happens

electron-builder v26 introduced a new `node-module-collector` that fails to detect optional dependencies. Even when building natively on Windows, the Windows binaries may not be included in the final package. See:
- [electron-builder #8842](https://github.com/electron-userland/electron-builder/issues/8842) - builds broken since v26.0.4
- [electron-builder #9298](https://github.com/electron-userland/electron-builder/issues/9298) - incorrectly seeking wrong platform binaries
