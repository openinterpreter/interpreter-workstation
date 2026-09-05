# Frontend Development

## Host and access model

The Electron app, authenticated browser app, and read-only browser app share
the same renderer and layout components. Renderer code should call `@/ipc`
instead of choosing Electron, localhost, or a remote origin itself.

- Use `isWorkstationReadOnly()` to remove mutation controls. The server must
  independently reject the mutation.
- Use `isRemoteWorkstationHost()` only for location-specific behavior. Remote
  does not mean read-only.
- `isPublicWorkstationPublication()` is an internal compatibility name for an
  anonymous, restricted read-only backend. It must not produce a second shell.
- Browser tabs and layout are browser-local state. Connected thread, Goal,
  workspace, and file content are host state.

See [Workstation hosts, browser access, and read-only mode](remote-workstation.md)
and [IPC](agent-ipc.md).

## Layout State Architecture

The file viewer (Explorer) and right side panel (AgentSidebar) share file metadata and selection state through `LayoutContext` - a React Context defined in `src/contexts/LayoutContext.tsx` that manages the entire editor layout including open tabs, columns, and active file tracking. When a user clicks a file in the Explorer, it calls `layout.openFile(path)` which updates `state.editorLayout.columns[].tabs[]` and sets the `activeTabId`; components access the current selection via the `useActiveFilePath()` hook that derives the active file path from this layout state. File metadata (path, label, thumbnail, mtime) is stored in `EditorTab` objects within the layout state, and additionally the Explorer populates a global `fileStore` cache (`src/stores/fileStore.ts`) with `FileEntry` objects that the right panel's @ mention system (`agent/components/assistant-ui/mention/fileMentionSuggestion.ts`) consumes via `getFileCache()`. The LayoutContext also syncs all open tabs to the backend via `POST /api/agent/context/tabs` whenever the editor columns change, making the tab/file state available to the agent system.

| File | Purpose |
|------|---------|
| `src/contexts/LayoutContext.tsx` | Central state management, tab/file tracking, backend sync |
| `src/hooks/useLayout.ts` | Hook to access LayoutContext |
| `src/stores/fileStore.ts` | Global file cache for @ mentions |
| `src/components/Explorer.tsx` | File tree UI, populates fileStore |
| `agent/components/AgentSidebar.tsx` | Right sidebar (Chat, Approvals, Settings) |

---

## Context Menus - Unified Pattern

**Components define WHAT items to show. The system handles HOW to render.**

```typescript
import { showContextMenu, files, type ContextMenuItem } from '@/ipc';

const handleContextMenu = async (e: React.MouseEvent) => {
  e.preventDefault();

  const items: ContextMenuItem[] = [
    { label: 'Copy Path', action: 'copy-path' },
    { label: 'Reveal in Finder', action: 'reveal' },
    { label: '', action: '', separator: true },
    { label: 'Delete', action: 'delete' },
  ];

  const action = await showContextMenu(items);

  if (action === 'copy-path') {
    await navigator.clipboard.writeText(path);
  } else if (action === 'reveal') {
    await shell.revealInFinder(path);
  } else if (action === 'delete') {
    await files.delete(path);
  }
};
```

**Rules:**
- **NEVER** define menu items in Electron handlers
- **NEVER** create special-case context menu functions
- **ALWAYS** define items in the component that needs them
- **ALWAYS** use `showContextMenu(items)` - ONE unified API

---

## Keyboard Shortcuts (Global Menu Shortcuts)

**NEVER add `window.addEventListener('keydown')` in components.** Use the menu shortcut pattern:

### Adding a New Shortcut

1. Add channel in `electron/ipc/registry.ts`
2. Add event emitter in `electron/ipc/events.ts`
3. Import + add menu item in `electron/menu.ts`
4. Add preload listener in `electron/preload.ts`
5. Listen in component via `useEffect`

### Full Example

```typescript
// 1. electron/ipc/registry.ts
OPEN_SETTINGS: 'open-settings',

// 2. electron/ipc/events.ts
export function emitOpenSettings(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.OPEN_SETTINGS);
}

// 3. electron/menu.ts
{
  label: 'Settings',
  accelerator: 'CmdOrCtrl+,',
  click: () => emitOpenSettings(BrowserWindow.getFocusedWindow()),
},

// 4. electron/preload.ts
quickActions: {
  onOpenSettings: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.OPEN_SETTINGS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.OPEN_SETTINGS, handler);
  },
},

// 5. Component
useEffect(() => {
  if (!window.electron?.quickActions?.onOpenSettings) return;
  const unsubscribe = window.electron.quickActions.onOpenSettings(() => {
    openSettings();
  });
  return unsubscribe;
}, [openSettings]);
```

### Existing Shortcuts

| Shortcut | Action | Channel |
|----------|--------|---------|
| Cmd+N | New Window | menu handler |
| Cmd+T | New Agent | TAB_NEW |
| Cmd+Shift+L | New Sidebar Agent | NEW_SIDEBAR_AGENT |
| Cmd+W | Close Tab | TAB_CLOSE |
| Cmd+K | Quick Open | QUICK_OPEN |
| Cmd+E | Toggle Explorer | TOGGLE_EXPLORER |
| Cmd+O | Open Folder | (dialog) |
| Cmd+L | Toggle Agent Sidebar | FOCUS_AGENT |
| Cmd+1-9 | Go to Tab | TAB_GO_TO |
| Cmd+Shift+] | Next Tab | TAB_NEXT |
| Cmd+Shift+[ | Previous Tab | TAB_PREVIOUS |

Tab shortcuts target the active tab region. If a pinned sidebar agent is active, `Cmd+W` closes that sidebar tab. Global tab numbering and `Cmd+Shift+[ / ]` navigation treat pinned sidebar tabs as an extension of the main tab order.

Avoid system shortcuts like Cmd+H (macOS Hide App).

---

## Styling System

### Colors

Uses **shadcn variables** (OKLCH format) plus custom app variables. Defined in `src/index.css`.

**Core shadcn variables:**
| Variable | Purpose |
|----------|---------|
| `--background` | Main background (white/dark) |
| `--foreground` | Main text color |
| `--muted` | Muted backgrounds |
| `--muted-foreground` | Secondary text |
| `--border` | Border color |
| `--primary` | Primary accent color |

**Custom app variables:**
| Variable | Purpose |
|----------|---------|
| `--inactive-bg` | Tab bars, inactive regions (light gray) |
| `--hover-bg` | Hover states (derived from inactive-bg + 10% foreground) |
| `--shadow-color` | Elevated surface shadows |

**Tailwind classes:** `bg-background`, `text-foreground`, `bg-muted`, `text-muted-foreground`, `border-border`, `bg-inactive`, `bg-hover`

### Borders

**ALWAYS use `var(--border-width)` for border widths.** The app uses `--border-width: 0.5px` globally. Tailwind's `border` class defaults to 1px which is WRONG.

```tsx
// CORRECT
<div style={{ border: 'var(--border-width) solid var(--border)' }}>
<div style={{ borderBottom: 'var(--border-width) solid var(--border)' }}>

// WRONG - Tailwind's border is 1px, not 0.5px
<div className="border border-border">

// WRONG - hardcoded 1px
<div style={{ border: '1px solid var(--border)' }}>
```

**Exception:** Existing components with border styling via CSS classes (like `.content-area-container`) don't need inline styles.

### Text Sizes (UI only - 3 sizes)

| Class | Size | Use |
|-------|------|-----|
| `text-ui-xs` | 11px | Meta: badges, versions, tiny labels |
| `text-ui-sm` | 12px | Default: body, inputs, labels, buttons |
| `text-ui-base` | 14px | Emphasis: section headings, card titles |

For document headings (markdown/prose), use Tailwind: `text-lg`, `text-xl`, `text-2xl`, etc.

### Cursor

**Desktop app = default cursor everywhere.** Never use `cursor-pointer`. Only exceptions: text inputs, resize handles, external links.
