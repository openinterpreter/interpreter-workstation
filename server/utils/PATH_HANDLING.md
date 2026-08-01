# Path Handling Documentation

## Overview

This document describes the comprehensive path normalization and handling implemented in `permissions.ts`, based on the Model Context Protocol (MCP) filesystem server implementation.

## Key Features

### 1. WSL Path Preservation

**Critical**: WSL paths (`/mnt/c/`, `/mnt/d/`, etc.) are **NEVER** converted to Windows format.

```typescript
// ✓ Correct - WSL paths are preserved
normalizePath('/mnt/c/Users/test/file.txt')
// → '/mnt/c/Users/test/file.txt'

// ✗ Wrong - Don't convert WSL paths
// '/mnt/c/Users/test/file.txt' → 'C:\Users\test\file.txt' ❌
```

**Why?** When running Node.js inside WSL (e.g., `wsl npx ...`), the process runs on Linux (`process.platform === 'linux'`) and `/mnt/c/` paths work correctly with Node.js `fs` operations. Converting them to Windows format (`C:\`) breaks file operations because Windows paths don't work inside WSL.

### 2. UNC Path Support

Proper handling of Windows network paths:

```typescript
// UNC paths preserve leading double backslash
normalizePath('\\\\server\\share\\folder')
// → '\\\\server\\share\\folder'

// Normalizes excessive backslashes
normalizePath('\\\\\\\\server\\\\share\\\\folder')
// → '\\\\server\\share\\folder'
```

### 3. Unix-Style Windows Paths

Converts `/c/Users` to `C:\Users` only when running on Windows:

```typescript
// On Windows (process.platform === 'win32')
normalizePath('/c/Users/test/file.txt')
// → 'C:\Users\test\file.txt'

// On Linux/Mac (not Windows)
normalizePath('/c/Users/test/file.txt')
// → '/c/Users/test/file.txt' (treated as regular Unix path)
```

### 4. Drive Letter Capitalization

All Windows drive letters are capitalized:

```typescript
normalizePath('c:\\windows\\system32')
// → 'C:\windows\system32'

normalizePath('d:/documents/file.txt')
// → 'D:\documents\file.txt'
```

### 5. Quote and Whitespace Handling

Removes surrounding quotes and trims whitespace:

```typescript
normalizePath('"C:\\Program Files\\App"')
// → 'C:\Program Files\App'

normalizePath('  /home/user/file.txt  ')
// → '/home/user/file.txt'
```

### 6. Multiple Separator Normalization

Collapses multiple consecutive slashes:

```typescript
normalizePath('/usr//local///bin')
// → '/usr/local/bin'

normalizePath('C:\\\\Users\\\\test\\\\file.txt')
// → 'C:\Users\test\file.txt'
```

### 7. Trailing Slash Removal

Removes trailing slashes (except for root):

```typescript
normalizePath('/usr/local/bin/')
// → '/usr/local/bin'

normalizePath('/')
// → '/' (root preserved)
```

### 8. Home Directory Expansion

Expands `~` to the user's home directory:

```typescript
normalizePath('~/Documents/file.txt')
// → '/Users/username/Documents/file.txt' (or equivalent on Windows)

normalizePath('~')
// → '/Users/username'
```

### 9. Platform-Specific Separator Handling

- **Windows**: Converts forward slashes to backslashes
- **Unix/Linux/Mac**: Preserves forward slashes

```typescript
// On Windows
normalizePath('C:/Users/test/file.txt')
// → 'C:\Users\test\file.txt'

// On Unix
normalizePath('/home/user/documents')
// → '/home/user/documents'
```

### 10. Security Features

Rejects paths with null bytes:

```typescript
normalizePath('/path/with\x00null')
// → throws Error('Path contains null byte')
```

## Functions

### `normalizePath(inputPath: string): string`

Main path normalization function that handles all the above features.

**Parameters:**
- `inputPath`: The path to normalize

**Returns:**
- Normalized path string

**Example:**
```typescript
import { normalizePath } from './permissions';

const path1 = normalizePath('"/mnt/c/Program Files/App"');
// → '/mnt/c/Program Files/App'

const path2 = normalizePath('c:/users/test/../admin/file.txt');
// → 'C:\users\admin\file.txt'
```

### `resolvePathWithWorkspace(inputPath: string, workspacePath: string | null): string`

Resolves a path that may be workspace-relative or absolute.

**Parameters:**
- `inputPath`: The path to resolve (can be absolute or relative)
- `workspacePath`: The workspace directory (nullable)

**Returns:**
- Fully resolved and normalized path

**Throws:**
- Error if path is relative but no workspace is provided

**Example:**
```typescript
import { resolvePathWithWorkspace } from './permissions';

// Absolute paths are just normalized
const abs = resolvePathWithWorkspace('/mnt/c/Users/test', '/workspace');
// → '/mnt/c/Users/test'

// Relative paths are joined with workspace
const rel = resolvePathWithWorkspace('src/index.ts', '/workspace');
// → '/workspace/src/index.ts'

// Throws error if workspace is null
resolvePathWithWorkspace('src/index.ts', null);
// → throws Error('Cannot resolve relative path...')
```

### Helper Functions

#### `convertToWindowsPath(p: string): string` (internal)

Converts Unix-style Windows paths to proper Windows format, while preserving WSL paths.

#### `expandHome(filepath: string): string` (internal)

Expands home directory tildes (`~`) in paths.

## Path Type Detection

The implementation correctly identifies and handles:

1. **WSL paths**: `/mnt/[a-z]/...`
2. **UNC paths**: `\\server\share`
3. **Windows drive paths**: `C:\...` or `C:/...`
4. **Unix-style Windows paths**: `/c/...` (only on Windows)
5. **Home directory paths**: `~` or `~/...`
6. **Regular Unix paths**: `/usr/...`, `/home/...`, etc.

## Platform Behavior

### On Windows (`process.platform === 'win32'`)

- Converts `/c/` → `C:\`
- Preserves `/mnt/c/` (WSL)
- Preserves `\\server\share` (UNC)
- Uses backslashes (`\`) as separators
- Capitalizes drive letters

### On Linux/Mac

- Preserves all Unix paths including `/c/`
- Preserves `/mnt/c/` (WSL)
- Uses forward slashes (`/`) as separators

## Integration with Permission System

The normalized paths are used throughout the permission system to ensure consistent path comparisons:

```typescript
function canAccessSync(
  normalizedPath: string,
  mode: 'read' | 'write',
  permissions: FileAccessPolicy,
  workspacePath: string | null
): boolean {
  // All paths are normalized before comparison
  const sandboxDir = normalizePath(getSandboxDir());

  // Secure path comparison with separator check
  if (normalizedPath === sandboxDir ||
      normalizedPath.startsWith(sandboxDir + path.sep)) {
    return mode === 'read';
  }

  // ... rest of permission checks
}
```

## Security Considerations

1. **Null byte rejection**: Prevents path injection attacks
2. **Symlink resolution**: Use `canAccessAsync()` for symlink-aware permission checks
3. **Path separator checks**: Prevents `/allowed/dir` matching `/allowed/dir-evil`
4. **Quote stripping**: Prevents bypassing checks with quoted paths

## Testing

Comprehensive tests are provided in:
- `permissions.test.ts`: Jest/Vitest unit tests
- `test-path-normalization.ts`: Manual test script

Run manual tests:
```bash
npx tsx server/utils/test-path-normalization.ts
```

## References

This implementation is based on the Model Context Protocol (MCP) filesystem server:
- Source: [modelcontextprotocol/servers filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- Issue: MCP #2795 (WSL path handling)

## Migration Notes

If you were previously using `path.resolve()` directly:

```typescript
// ❌ Old (may break WSL paths)
const oldPath = path.resolve(inputPath);

// ✅ New (handles all edge cases)
const newPath = normalizePath(inputPath);
```

If you need workspace-relative resolution:

```typescript
// ❌ Old (manual handling)
const isAbsolute = inputPath.startsWith('/');
const resolved = isAbsolute
  ? path.resolve(inputPath)
  : path.join(workspace, inputPath);

// ✅ New (automatic detection)
const resolved = resolvePathWithWorkspace(inputPath, workspace);
```
