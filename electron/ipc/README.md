# IPC Architecture

This directory contains the centralized IPC (Inter-Process Communication) system for the Electron application.

## Overview

The IPC system provides type-safe, event-driven communication between:
- **Main Process** (Electron/Node.js)
- **Renderer Process** (React/Browser)
- **Server Process** (Express backend)

## Architecture Principles

### 1. Centralization
All IPC channels and types are defined in ONE place (`registry.ts`), ensuring:
- No duplicate channel names
- Single source of truth for types
- Easy discovery of all IPC capabilities

### 2. Type Safety
Every IPC channel has TypeScript interfaces for:
- Request parameters
- Response data
- Event payloads

This prevents runtime errors and provides IDE autocomplete.

### 3. Event-Driven (NO Polling)
The system uses events for real-time updates:
- ✅ Components listen to events
- ✅ Managers emit events when state changes
- ❌ NO `setInterval` polling
- ❌ NO periodic HTTP requests

### 4. Clean Separation
- **registry.ts**: Channel names and types
- **handlers.ts**: Main process IPC handlers
- **events.ts**: Event emission helpers
- **preload.ts**: Renderer API (contextBridge)
- **ipcBridge.ts** (server): Server-side event helpers

## Files

### `registry.ts`
The single source of truth for all IPC communication.

**Contains:**
- `IPC_CHANNELS`: Channel name constants
- Type interfaces for all requests/responses
- Type interfaces for all event payloads
- Type guards for runtime validation

**Example:**
```typescript
export const IPC_CHANNELS = {
  APPROVAL_GET: 'approval:get',
  APPROVAL_LIST_CHANGED: 'approval:list-changed',
  // ... more channels
};

export interface ApprovalGetRequest {
  toolCallId?: string;
}

export interface ApprovalListChangedEvent {
  count: number;
  approvals: ApprovalData[];
}
```

### `handlers.ts`
Centralized IPC handler registration for the main process.

**Contains:**
- `setupIpcHandlers()` function
- All `ipcMain.handle()` registrations
- All `ipcMain.on()` registrations

**Usage in main.ts:**
```typescript
import { setupIpcHandlers } from './ipc/handlers.js';

app.whenReady().then(() => {
  setupIpcHandlers({
    serverPort,
    approvalManager,
    agentTabManager,
    globalFileAccessResolver,
    cleanup,
  });
});
```

### `events.ts`
Helper functions for emitting events from main process to renderer.

**Contains:**
- Event emission helpers
- Window null-safety checks
- Logging for debugging

**Example:**
```typescript
import { emitApprovalListChanged } from './ipc/events.js';

// In approvalManager:
emitApprovalListChanged(this.mainWindow, this.getApprovals());
```

### `../preload.ts`
Exposes the IPC API to the renderer process via `contextBridge`.

**Contains:**
- `ElectronAPI` interface
- `window.electron` implementation
- Type-safe wrappers around `ipcRenderer`

**Usage in React:**
```typescript
// Listen for events
useEffect(() => {
  const unsubscribe = window.electron.approvals.onListChanged((event) => {
    setApprovalCount(event.count);
  });
  return unsubscribe;
}, []);

// Invoke handlers
await window.electron.approvals.approve({ id: approvalId });
```

### `../../server/utils/ipcBridge.ts`
Server-side helper for emitting IPC events.

**Usage:**
```typescript
import { emitSetupCompleted } from './utils/ipcBridge.js';

// When OAuth completes:
emitSetupCompleted({
  serverId: 'nylas',
  configured: true,
  email: 'user@example.com'
});
```

## Event Flow Examples

### Approval Flow (Fully Event-Driven)

```
User Action (React) → IPC Request → Main Process → Approval Manager
                                                          ↓
                                                    State Change
                                                          ↓
                                            Emit: approval:list-changed
                                                          ↓
                                                   All Listeners
                                                          ↓
                                              React Components Update
```

**Code:**
```typescript
// Component
async function handleApprove(id: string) {
  // 1. Send request
  await window.electron.approvals.approve({ id });
  // 2. NO need to reload - event listener will update
}

// Event listener (in same component)
useEffect(() => {
  const unsubscribe = window.electron.approvals.onListChanged((event) => {
    setApprovals(event.approvals); // Automatic update!
  });
  return unsubscribe;
}, []);

// Approval Manager
approve(id: string): void {
  this.approvals.delete(id);

  // Emit events
  emitApprovalResolved(this.mainWindow, id, true);
  emitApprovalListChanged(this.mainWindow, this.getApprovals());
}
```

## Adding a New IPC Channel

Follow these steps to add a new IPC channel:

### 1. Define in Registry

Add to `electron/ipc/registry.ts`:

```typescript
// Add channel name
export const IPC_CHANNELS = {
  // ... existing channels
  MY_NEW_CHANNEL: 'my:new-channel',
  MY_NEW_EVENT: 'my:new-event',
};

// Add request/response types
export interface MyNewChannelRequest {
  param1: string;
  param2?: number;
}

export interface MyNewChannelResponse {
  success: boolean;
  data?: any;
}

export interface MyNewEvent {
  message: string;
  timestamp: number;
}
```

### 2. Add Handler

Add to `electron/ipc/handlers.ts`:

```typescript
ipcMain.handle(
  IPC_CHANNELS.MY_NEW_CHANNEL,
  async (_event, request: MyNewChannelRequest): Promise<MyNewChannelResponse> => {
    try {
      // Handle the request
      return { success: true, data: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
);
```

### 3. Add Event Emitter (if applicable)

Add to `electron/ipc/events.ts`:

```typescript
export function emitMyNewEvent(
  window: BrowserWindow | null,
  data: MyNewEvent
): void {
  emitToRenderer(window, IPC_CHANNELS.MY_NEW_EVENT, data);
}
```

### 4. Add Preload API

Add to `electron/preload.ts`:

```typescript
// Add to ElectronAPI interface
export interface ElectronAPI {
  // ... existing methods
  myFeature: {
    doSomething: (request: MyNewChannelRequest) => Promise<MyNewChannelResponse>;
    onNewEvent: (callback: (event: MyNewEvent) => void) => () => void;
  };
}

// Add to contextBridge.exposeInMainWorld
contextBridge.exposeInMainWorld('electron', {
  // ... existing
  myFeature: {
    doSomething: (request: MyNewChannelRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.MY_NEW_CHANNEL, request),
    onNewEvent: (callback: (event: MyNewEvent) => void) => {
      const listener = (_: any, event: MyNewEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.MY_NEW_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MY_NEW_EVENT, listener);
    },
  },
});
```

### 5. Use in React

```typescript
function MyComponent() {
  const [data, setData] = useState<any>(null);

  // Listen for events
  useEffect(() => {
    const unsubscribe = window.electron.myFeature.onNewEvent((event) => {
      console.log('Received event:', event.message);
    });
    return unsubscribe;
  }, []);

  // Call handler
  async function handleAction() {
    const result = await window.electron.myFeature.doSomething({
      param1: 'value',
      param2: 42,
    });
    if (result.success) {
      setData(result.data);
    }
  }

  return <button onClick={handleAction}>Do Something</button>;
}
```

## Migration Guide

### From Polling to Events

**Before (Polling):**
```typescript
useEffect(() => {
  loadApprovals();
  const interval = setInterval(loadApprovals, 1000); // ❌ Polling
  return () => clearInterval(interval);
}, []);

async function loadApprovals() {
  const { approvals } = await getApprovals();
  setApprovals(approvals);
}
```

**After (Events):**
```typescript
useEffect(() => {
  const unsubscribe = window.electron.approvals.onListChanged((event) => {
    setApprovals(event.approvals); // ✅ Event-driven
  });
  return unsubscribe;
}, []);
```

### From Direct IPC to Centralized

**Before:**
```typescript
// main.ts
ipcMain.handle('get-something', async () => {
  return { data: 'value' };
});

// preload.ts
getSomething: () => ipcRenderer.invoke('get-something'),

// component
const result = await window.electron.getSomething();
```

**After:**
```typescript
// registry.ts
export const IPC_CHANNELS = {
  GET_SOMETHING: 'get-something',
};

// handlers.ts
ipcMain.handle(IPC_CHANNELS.GET_SOMETHING, async (): Promise<GetSomethingResponse> => {
  return { data: 'value' };
});

// preload.ts
getSomething: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SOMETHING),

// component (same)
const result = await window.electron.getSomething();
```

## Testing

When testing IPC:

1. **Mock window.electron** in React component tests
2. **Test handlers independently** in handlers.test.ts
3. **Use integration tests** for end-to-end IPC flows

Example mock:
```typescript
const mockElectron = {
  approvals: {
    onListChanged: jest.fn(() => jest.fn()),
    approve: jest.fn(),
    deny: jest.fn(),
  },
};

global.window = { electron: mockElectron } as any;
```

## Best Practices

1. **Always use registry constants** - Never hardcode channel strings
2. **Type everything** - Define interfaces for all requests/responses/events
3. **Emit on state changes** - Not just on user actions
4. **Clean up listeners** - Return unsubscribe functions from useEffect
5. **Handle errors** - IPC calls can fail, handle gracefully
6. **Log events** - Event emitters log for debugging
7. **Document** - Add JSDoc comments to new channels

## Common Patterns

### Request-Response Pattern
```typescript
const result = await window.electron.someFeature.doSomething(params);
```

### Event Listener Pattern
```typescript
useEffect(() => {
  const unsubscribe = window.electron.someFeature.onEvent((event) => {
    // Handle event
  });
  return unsubscribe;
}, []);
```

### State Change Emission Pattern
```typescript
approve(id: string): void {
  this.items.delete(id);

  // Emit specific event
  emitItemResolved(this.mainWindow, id);

  // Emit list changed
  emitItemListChanged(this.mainWindow, this.getItems());
}
```

## Troubleshooting

### Event not received
- Check that manager has mainWindow reference set
- Check that event is being emitted
- Check that listener is registered before event is emitted
- Check console for event logs

### Type errors
- Make sure registry types are imported
- Check that preload.ts ElectronAPI matches registry types
- Rebuild after type changes

### Handler not working
- Check that setupIpcHandlers() is called in main.ts
- Check that handler is registered with correct channel name
- Check error logs in main process

## Summary

This centralized IPC architecture provides:
- ✅ **Type safety** across process boundaries
- ✅ **Event-driven updates** (no polling)
- ✅ **Single source of truth** for all channels
- ✅ **Clean separation** of concerns
- ✅ **Easy discoverability** of IPC capabilities
- ✅ **Maintainability** through centralization
- ✅ **Debugging** through comprehensive logging
