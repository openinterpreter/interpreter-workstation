# Agent Components

React components for the multi-agent tabbed interface.

## Overview

These components implement the tabbed UI for managing multiple agent conversations. All use vanilla assistant-ui primitives with minimal customization - the only custom logic is for tab management and label synchronization.

## Component Structure

**AgentSidebar** - Main container that manages the agent list, active agent state, and tab label states. Creates new agents on request and coordinates between the tabs display and thread rendering.

**AgentTab** - Individual tab button component that displays a truncated agent label and optional streaming indicator. Shows active/inactive visual state and handles click events for tab switching. Labels are truncated to 30 characters with ellipsis.

**AgentThread** - Wrapper around assistant-ui's Thread component that creates an independent runtime for each agent. Retrieves the dynamic server port from Electron, initializes the AI SDK transport, and wraps everything in an AssistantRuntimeProvider.

The thread component subscribes to message and streaming state changes using assistant-ui hooks. When messages update, it extracts the first user message, truncates it to 30 characters, and calls the parent's label update callback to sync the tab display.

## State Management

Agent state (id, creation time) is maintained in the sidebar component using React useState. Tab label states are stored in a Map that gets updated whenever a thread's messages change. The active agent ID determines which thread is visible.

Each agent thread maintains its own independent assistant-ui runtime state internally. No manual synchronization is needed - assistant-ui handles message history, streaming state, and UI updates automatically through its Zustand store.

The label sync mechanism is the only custom state bridge: threads watch for message changes and notify the parent component to update tab labels. This keeps the tab bar in sync with conversation state without tightly coupling the components.

## Visibility Pattern

All agent thread components remain mounted at all times, even when not visible. The sidebar renders all threads simultaneously but toggles their display CSS property. This enables background streaming and instant tab switching without re-mounting components or losing state.

## Styling

Components use inline styles and basic CSS classes. The design is intentionally minimal to avoid over-customization of assistant-ui's built-in styling. Tab highlighting and layout are handled with simple flexbox and background colors.

## Integration with Electron

The thread component requires the server port at runtime, which it gets by calling window.electron.getServerPort() on mount. This IPC bridge provides the dynamic port assigned by the Express server. No hardcoded URLs or ports are used anywhere.

## Vanilla Philosophy

These components use assistant-ui as intended - wrapping the primitives with minimal logic and letting the library handle all the complexity of streaming, message rendering, and tool execution. The only custom code is for managing multiple tabs, which is orthogonal to assistant-ui's concerns.
