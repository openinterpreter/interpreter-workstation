# IPC (Frontend/Backend Communication)

**Current product scope: the desktop Electron app. Prefer IPC. Do not design new UI features around browser-mode parity.**

**The frontend should call `@/ipc`, but not every capability is transport-agnostic. Shared app features can abstract over IPC vs HTTP. Privileged desktop capabilities stay Electron-only.**

```
┌─────────────┐
│  Frontend   │  ──→  calls `files.delete(path)` or `showContextMenu(items)`
└─────────────┘
       │
       ▼
┌─────────────────────────────┐
│   src/ipc.ts (client)       │  ──→  Picks the correct desktop transport
└─────────────────────────────┘
       │
       ├── Electron preload API → IPC → electron/ipc/handlers.ts
       │                                  │
       │                                  ├── Native Electron API (when better)
       │                                  └── OR calls server/handlers/*
       │
       └── Loopback HTTP only for explicit exceptions
```

## Current Rule

- **Electron app first** - optimize for the packaged/desktop runtime
- **Prefer IPC for app UI features** - especially file access and native capabilities
- **Do not add HTTP mirrors just for symmetry** - if a capability is desktop-only, keep it desktop-only
- **If we ever ship a web app** - design a separate web-safe API then; do not pre-emptively weaken the desktop boundary now

## Key Principle: NO DUPLICATE BUSINESS LOGIC

- **Business logic** lives in `server/handlers/*.ts` - ONE implementation
- **Routers are thin** - just routing, no business logic
- **Native Electron APIs** are used when better (e.g., `shell.showItemInFolder` is faster than `exec`)
- **Frontend calls `@/ipc`** instead of reaching into `window.electron` directly

## Shared vs Desktop-Only

There are two categories of frontend capabilities:

- **Shared capabilities** can have both IPC and HTTP transports behind `@/ipc`
- **Privileged desktop capabilities** are exposed only to the trusted Electron renderer and must not be mirrored onto HTTP

Examples of **privileged desktop capabilities**:

- user-opened local file reads/writes for editor tabs
- explicit thumbnail generation for arbitrary local file paths
- native shell integration, dialogs, drag-and-drop file handles

For these APIs:

- add them to `electron/preload.ts` and `electron/ipc/handlers.ts`
- call shared server handlers only if that does not widen the trust boundary
- **do not** add them to `server/routes/ipc.ts`
- **do not** route them through generic `/api/ipc/*`

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

## Adding Event Subscriptions (CRITICAL - Requires preload.ts)

**Event subscriptions (`namespace.onXxx()`) REQUIRE explicit preload.ts bindings in Electron mode.**

The fallback proxy only supports method calls, NOT event subscriptions. If you try to subscribe to an event on a namespace that isn't in preload.ts, **it will throw an error**.

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

**Why is preload.ts required?**
- event subscriptions are an explicit Electron capability boundary
- the fallback proxy only supports method calls, not event channels
- if a namespace is not in preload, the renderer does not get that capability

## When to Use Native Electron APIs vs Shared Handlers

| Use Native Electron API | Use Shared Handler |
|------------------------|-------------------|
| `shell.showItemInFolder` (faster) | Complex business logic |
| `dialog.showOpenDialog` (native UI) | Database operations |
| `clipboard.writeText` (native) | File transformations |
| `Menu.popup` (native context menus) | API calls |

The rule: **If Electron has a native API that's better, use it. Otherwise, call the shared handler.**

## Privileged File Access

User-opened desktop files are a special case.

- In Electron, opened file tabs read and write through renderer-only IPC
- Those reads/writes are **not** part of the workspace-scoped HTTP file API
- `files.read`, `files.write`, and explicit thumbnail reads for arbitrary local paths must stay off `server/routes/ipc.ts`
- `getFileUrl(filePath)` should return `file://` in Electron so viewers do not depend on `/api/files` for absolute local files

This boundary exists to keep untrusted HTML/email/browser content from gaining local file access just because the app also runs a loopback server.

**Trust model:**

- privileged Electron APIs are for the trusted app renderer only
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
