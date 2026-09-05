# IPC (Frontend/Backend Communication)

**Workstation has one renderer for desktop and browser hosts. Frontend features call `@/ipc`; the bridge chooses Electron IPC or authenticated HTTP/SSE.**

```
┌─────────────┐
│  Frontend   │  ──→  calls `files.delete(path)` or `showContextMenu(items)`
└─────────────┘
       │
       ▼
┌─────────────────────────────┐
│   src/ipc.ts (client)       │  ──→  Picks transport and host
└─────────────────────────────┘
       │
       ├── Electron preload API → IPC → electron/ipc/handlers.ts
       │                                  │
       │                                  ├── Native Electron API (when better)
       │                                  └── OR calls server/handlers/*
       │
       └── Browser HTTP → server/routes/* → server/handlers/*
                    SSE ← /api/events ← broadcastEvent()
```

## Current Rule

- **One component API** - renderer code calls `@/ipc`, `getApiUrl()`, or
  `apiRequest()` instead of selecting a transport itself.
- **One business implementation** - shared logic stays in `server/handlers`.
- **Explicit access** - host policy decides read-write vs read-only; components
  reflect that policy with `isWorkstationReadOnly()`.
- **Location is not permission** - remote does not imply read-only, and local
  does not define which controls a configured distribution must expose.
- **Native affordances stay native** - operating-system dialogs and local
  window management need Electron implementations or a deliberate browser UX.
- **HTTP is an authenticated product transport** - do not widen it accidentally
  or rely on hidden UI as the authorization boundary.

## Key Principle: NO DUPLICATE BUSINESS LOGIC

- **Business logic** lives in `server/handlers/*.ts` - ONE implementation
- **Routers are thin** - just routing, no business logic
- **Native Electron APIs** are used when better (e.g., `shell.showItemInFolder` is faster than `exec`)
- **Frontend calls `@/ipc`** instead of reaching into `window.electron` directly

## Shared vs Desktop-Only

There are two categories of frontend operations:

- **Connected-computer operations** use the bridge and can have both IPC and
  HTTP transports. In browser mode they affect the selected remote host, not
  the device displaying the webpage.
- **Display-device-native operations** are meaningful only in Electron or need
  a separate browser interaction.

Examples of **display-device-native operations**:

- choosing a folder with the local operating-system picker;
- revealing a file in the local Finder or Explorer;
- Electron window management and native menus;
- resolving a browser `File` object to a local absolute path.

For these operations, add an Electron implementation and either omit the
control in a browser or design a browser-safe equivalent. Do not call a remote
machine's Finder merely because the method exists in an HTTP namespace.

## Architecture

| File | Purpose |
|------|---------|
| `server/handlers/*.ts` | Shared business logic when a capability is safe to share |
| `server/handlers/broadcast.ts` | `broadcastEvent()` - unified event broadcasting |
| `server/routes/ipc.ts` | Thin HTTP router for HTTP-safe/shared capabilities only |
| `electron/ipc/handlers.ts` | Thin IPC router for desktop UI capabilities, including privileged ones |
| `src/ipc.ts` | Frontend client and only entry point for renderer-side calls |

## Example: Adding New Functionality (Method Calls Only)

```typescript
// 1. server/handlers/myFeature.ts - THE implementation
export async function doThing(arg: string) {
  // Business logic HERE
}

// 2. server/routes/ipc.ts - thin router (NO logic)
myFeature: {
  doThing: async ([arg]) => {
    const { doThing } = await import('../handlers/myFeature');
    return doThing(arg);
  }
}

// 3. Frontend - call the abstraction, not window.electron directly
import { myFeature } from '@/ipc';
await myFeature.doThing('hello');
```

## Adding Event Subscriptions

Event subscriptions need both transports: explicit preload bindings in
Electron and a named SSE event in browser mode. If a namespace is not in the
preload, the Electron renderer does not receive that event. If the handler does
not call `broadcastEvent()`, browser clients do not receive it through
`/api/events`.

```typescript
// 1. server/handlers/myFeature.ts - emit event after action
import { broadcastEvent } from './broadcast';

export async function doThing(arg: string) {
  // Business logic
  broadcastEvent('myFeature:thingDone', { arg });
  return { success: true };
}

// 2. server/routes/ipc.ts - thin router
myFeature: {
  doThing: async ([arg]) => {
    const { doThing } = await import('../handlers/myFeature');
    return doThing(arg);
  }
}

// 3. electron/ipc/registry.ts - define channel constant and types
export const IPC_CHANNELS = {
  // ...
  MY_FEATURE_THING_DONE: 'myFeature:thingDone',
};

export interface MyFeatureThingDoneEvent {
  arg: string;
}

// 4. electron/ipc/handlers.ts - register handler
ipcMain.handle(
  IPC_CHANNELS.MY_FEATURE_DO_THING,
  async (_event, arg: string) => {
    return await myFeatureHandlers.doThing(arg);
  }
);

// 5. electron/preload.ts - REQUIRED for event subscriptions in Electron mode
myFeature: {
  doThing: (arg: string) => ipcRenderer.invoke(IPC_CHANNELS.MY_FEATURE_DO_THING, arg),
  onThingDone: (callback: (event: MyFeatureThingDoneEvent) => void) => {
    const listener = (_: any, event: MyFeatureThingDoneEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.MY_FEATURE_THING_DONE, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MY_FEATURE_THING_DONE, listener);
  },
},

// 6. Frontend - subscribe to events
import { myFeature } from '@/ipc';
useEffect(() => {
  const unsubscribe = myFeature.onThingDone((event) => {
    console.log('Thing done:', event.arg);
  });
  return unsubscribe;
}, []);
```

The renderer-facing bridge owns both subscriptions. A component should not
create a second `EventSource` or subscribe to `ipcRenderer` directly.

## When to Use Native Electron APIs vs Shared Handlers

| Use Native Electron API | Use Shared Handler |
|------------------------|-------------------|
| `shell.showItemInFolder` (faster) | Complex business logic |
| `dialog.showOpenDialog` (native UI) | Database operations |
| `clipboard.writeText` (native) | File transformations |
| `Menu.popup` (native context menus) | API calls |

The rule: **If Electron has a native API that's better, use it. Otherwise, call the shared handler.**

## Workspace File Access

File tabs refer to files on the connected computer. Electron may return a
`file://` URL for a trusted local file. Browser hosts use the authenticated
workspace-scoped `/api/files` route. A browser request must not turn an
arbitrary absolute path into filesystem access: the server resolves it and
proves that it remains inside the configured workspace.

Anonymous publication does not use this route. It uses
`/api/public-workspace/file` with its own publication-root and MIME allowlist.

**Trust model:**

- native Electron APIs are for the trusted app renderer only
- private browser file APIs require an authenticated Workstation session
- read-only host policy rejects file writes before the route runs
- workspace and symlink containment are enforced on the server
- trust checks must parse URLs and validate exact protocol/host/port rules
- **never** trust a renderer with string-prefix origin checks like `startsWith('http://localhost:5173')`

## URL Abstraction

Use `getApiUrl()` and `getFileUrl()` from `@/ipc` to construct URLs:

```typescript
import { getApiUrl, getFileUrl } from '@/ipc';

const url = await getFileUrl(filePath);     // file:// in Electron, HTTP only when explicitly needed
const url = await getApiUrl('/api/whatever'); // Any API path
```

**Never construct URLs manually with `isBrowserDevMode()` checks.**

## Exceptions (Must Stay HTTP)

- `/api/agent/chat` - AI SDK streaming
- `/api/files/*?raw=true` - Binary for explicit HTTP media delivery paths only, not privileged desktop file access
- `/api/auth/transfer-session` - Called from external browser (OAuth)
- Auth flows that need redirects

## Event Broadcasting - Unified Pattern

```typescript
// In server/handlers/*.ts
import { broadcastEvent } from './broadcast';

export async function setTheme(theme: 'light' | 'dark' | 'system') {
  await configStore.setTheme(theme);
  broadcastEvent('theme:changed', { theme });  // Works in both Electron and browser
  return { success: true };
}
```

**Rules:**
- Handlers call `broadcastEvent()` - they don't care about IPC vs SSE
- `broadcastEvent()` sends to BOTH channels (no-op if no listeners)
- Channel names use kebab-case: `theme:changed`, `primary-color:changed`
- Frontend subscribes via `namespace.onChanged(callback)` from `src/ipc.ts`

## File Refresh Contract

Agent-driven file edits use exactly one refresh event:

```typescript
import { IPC_CHANNELS } from '../../electron/ipc/registry';
import { emitEvent } from '../utils/ipcBridge';

emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath });
```

Rules:
- Emit `FILE_REFRESHED` exactly once after the on-disk file is final.
- Do not emit viewer-specific refresh events.
- Do not emit `workspace:files-changed` directly from tools for agent edits.
- The IPC bridge is responsible for fanning `FILE_REFRESHED` out to:
  - `files:refreshed` for open viewers/tabs
  - `workspace:files-changed` for the Explorer tree
- External OS/file-watcher changes still come from `workspace.onFilesChanged`; that is a separate source of truth from agent edits.
