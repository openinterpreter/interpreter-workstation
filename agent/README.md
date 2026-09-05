# Agent

A multi-agent chat interface where multiple AI assistants can run simultaneously in independent tabs, each maintaining their own conversation thread and streaming state.

## Overview

The Agent module provides a sidebar with a tabbed interface for interacting with multiple AI agents concurrently. Each tab binds to an OIX thread, allowing simultaneous work, preserved scroll positions, resumable history, and isolated conversation state.

## Architecture

Each agent tab has an independent renderer state backed by a durable OIX thread. All agent components remain mounted when merely hidden, and closing or reloading a renderer does not cancel work already owned by OIX. Reopening a tab loads the newest history page first, then catches up while the thread continues.

The component hierarchy consists of a main sidebar container that manages agent state, a vertical tab bar showing abbreviated conversation previews, and individual thread containers that wrap vanilla assistant-ui components. Each thread gets its own runtime provider and maintains complete independence from other agents.

Tab labels automatically update to show the first user message from each conversation, truncated to 30 characters. The active tab is visually highlighted, and a streaming indicator appears when an agent is generating a response.

## Key Features

**Independent Runtimes**: Each agent has its own runtime instance, conversation state, and streaming pipeline. Agents can stream responses simultaneously without interference.

**Background and detached work**: Switching tabs doesn't interrupt streaming. A renderer disconnect also leaves the OIX turn running; explicit Stop remains the only UI action that interrupts it.

**Resumable history**: Existing threads open at the newest activity. Older turns load in pages as the user scrolls upward, with scroll anchoring so content does not jump. A lightweight catch-up poll reconciles completed and in-progress history after reconnect.

**Thread Goals**: Workstation reads and edits native OIX Goals. After OIX creates a thread, the Goal row above its transcript provides create, pause, resume, edit, and clear actions. OIX owns persistence and continuation semantics; see [Goals](../docs/goals.md).

**Browser and read-only operation**: the normal `AgentThread` runs through the shared Workstation bridge in both Electron and authenticated browser hosts. `readOnly` removes composer, Stop, steering, approvals, retries, and Goal mutations when the host access setting requires it. `RemoteThreadViewer` is the smaller allowlisted conversation surface used only for an anonymous public publication. See [Workstation hosts, browser access, and read-only mode](../docs/remote-workstation.md).

## Backend

The API implementation lives in `/server/routes/`. `/api/agent/chat/stream` starts or resumes OIX turns, `/api/agent/threads/:threadId` reads reverse-paginated history, and `/api/agent/threads/:threadId/goal` exposes native Goal state.

The server uses Server-Sent Events for live turn presentation. The Electron app provides the dynamic server port to the frontend, while browser surfaces use the same HTTP abstraction. SSE disconnection is presentation loss, not an instruction to stop the OIX turn.

## Components

The sidebar contains a tabs component that renders individual tab buttons for each agent, plus a "New Agent" button. Each tab displays a truncated label and optional streaming indicator.

Thread components wrap the assistant-ui Thread primitive with a runtime provider. They subscribe to message updates and sync the first user message to the parent for tab label updates.

The assistant-ui subfolder contains customized primitives for rendering messages (Thread), tool execution UI (ToolFallback), and text content (MarkdownText). These use CSS variables for theming.

## Design Philosophy

This module maintains a vanilla assistant-ui implementation to keep the codebase simple and maintainable. No custom streaming logic, thread management, or state synchronization is implemented - assistant-ui handles all of that internally.

The only customization is the tabbed interface for managing multiple agents. This architectural decision makes the code easy to understand, debug, and upgrade as assistant-ui evolves.
