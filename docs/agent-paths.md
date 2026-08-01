# Path Handling

## Path Resolution (Canonical Method)

**One pattern for ALL tools:**

```typescript
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

handler: async (args) => {
  const workspace = getCurrentWorkspace();
  const filePath = resolvePathWithWorkspace(args.path, workspace);
  // ... use filePath
}
```

**Functions:**
- `getCurrentWorkspace()` - Returns the current workspace path (server-side singleton)
- `resolvePathWithWorkspace(inputPath, workspace)` - Pure function. Resolves relative paths against workspace, passes absolute paths through

**Rules:**
- NEVER use `normalizePath()` for user-provided paths (it resolves to `process.cwd()`, not workspace)
- `resolvePathWithWorkspace` is a pure function - it takes workspace as a parameter, doesn't call `getCurrentWorkspace()` internally
- Filesystem boundary checks in `server/tools/filesystemBoundary.ts` also use this pattern

---

## Cross-Platform Path Handling (CRITICAL - Production Bug Source)

**This has caused production bugs on Windows.** Mixed path separators break `shell.trashItem()`, file operations, and other Electron APIs.

- **Windows** uses backslashes (`\`): `C:\Users\foo\file.txt`
- **Unix/Mac** uses forward slashes (`/`): `/Users/foo/file.txt`

### Path Utilities in `src/ipc.ts`

| Function | Purpose |
|----------|---------|
| `pathJoin(...segments)` | Join path segments with platform-native separator |
| `pathBasename(path)` | Get filename from path |
| `pathDirname(path)` | Get directory from path |

### MANDATORY Rules

1. **NEVER concatenate paths with template literals:**
   ```typescript
   // WRONG - creates mixed separators on Windows (e.g., C:\Users\foo/file.txt)
   const fullPath = `${workspacePath}/${relativePath}`;

   // CORRECT - uses platform-native separator
   import { pathJoin } from '@/ipc';
   const fullPath = pathJoin(workspacePath, relativePath);
   ```

2. **NEVER use `.split('/')` directly on paths** - it breaks on Windows

3. **NEVER hardcode `/` as path separator** in path construction logic

4. **Always import from `@/ipc`** for frontend path operations - these use Node's `path` module via Electron preload with browser fallbacks
