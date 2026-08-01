# Agent

A multi-agent chat interface where multiple AI assistants can run simultaneously in independent tabs, each maintaining their own conversation thread and streaming state.

## Overview

The Agent module provides a sidebar with a tabbed interface for interacting with multiple AI agents concurrently. Each agent operates independently with its own assistant-ui runtime, allowing simultaneous streaming, preserved scroll positions, and isolated conversation states.

## Architecture

The system uses multiple independent assistant-ui runtime instances - one per agent tab. All agent components remain mounted when not visible, which enables background streaming and instant tab switching without interrupting ongoing responses.

The component hierarchy consists of a main sidebar container that manages agent state, a vertical tab bar showing abbreviated conversation previews, and individual thread containers that wrap vanilla assistant-ui components. Each thread gets its own runtime provider and maintains complete independence from other agents.

Tab labels automatically update to show the first user message from each conversation, truncated to 30 characters. The active tab is visually highlighted, and a streaming indicator appears when an agent is generating a response.

## Key Features

**Independent Runtimes**: Each agent has its own runtime instance, conversation state, and streaming pipeline. Agents can stream responses simultaneously without interference.

**Background Streaming**: Switching tabs doesn't interrupt streaming. All agents remain active when hidden, allowing you to check on multiple conversations while others continue generating responses.

**Preserved State**: Scroll position, message history, and UI state persist per agent. Switching between tabs feels instant because everything is already rendered.

**Simple Integration**: The module uses vanilla assistant-ui with minimal customization. The only custom logic is the tab management - everything else (streaming, message rendering, tool execution) is standard assistant-ui.

## Backend

The API implementation lives in `/server/routes/` and provides streaming chat completions using the AI SDK with OpenAI. The main endpoint is `/api/agent/chat` which handles message streaming and tool execution.

The server uses Server-Sent Events (SSE) for streaming, which assistant-ui consumes automatically. The Electron app provides the dynamic server port to the frontend, so no hardcoded URLs are needed.

## Components

The sidebar contains a tabs component that renders individual tab buttons for each agent, plus a "New Agent" button. Each tab displays a truncated label and optional streaming indicator.

Thread components wrap the assistant-ui Thread primitive with a runtime provider. They subscribe to message updates and sync the first user message to the parent for tab label updates.

The assistant-ui subfolder contains customized primitives for rendering messages (Thread), tool execution UI (ToolFallback), and text content (MarkdownText). These use CSS variables for theming.

## Design Philosophy

This module maintains a vanilla assistant-ui implementation to keep the codebase simple and maintainable. No custom streaming logic, thread management, or state synchronization is implemented - assistant-ui handles all of that internally.

The only customization is the tabbed interface for managing multiple agents. This architectural decision makes the code easy to understand, debug, and upgrade as assistant-ui evolves.
