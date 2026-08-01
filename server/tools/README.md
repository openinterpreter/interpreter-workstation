# Tools Module

The Tools Module manages tool servers and executes tools. It bridges external MCP servers and built-in tools through a unified interface.

---

## Core Concepts

### Tool Servers
Tool servers are collections of related tools. Each server has:
- A unique identifier
- A set of available tools
- Connection state (connected/disconnected)
- Optional configuration for external processes

### Tools
Tools are individual functions that can be executed. Each tool defines:
- What it does (description)
- What parameters it accepts (input schema)
- What it returns (structured response)

### Built-in vs External

**Built-in Tools** run directly within the application:
- No external process required
- Lower latency
- Platform-specific capabilities (macOS Mail, system time)
- Useful for core functionality

**External Servers** run as separate processes:
- Communicate via stdio, HTTP, or WebSocket
- Maintain their own lifecycle
- Can be third-party MCP servers
- Useful for specialized integrations

---

## How It Works

### Server Lifecycle

1. **Discovery**: Available servers are loaded from configuration
2. **Connection**: External servers are spawned or connected to
3. **Capability Exchange**: Servers advertise their available tools
4. **Ready State**: Tools become available for execution
5. **Disconnection**: Servers can be stopped or fail

### Tool Execution

1. **Request**: A tool call is received with parameters
2. **Validation**: Parameters are validated against the tool's schema
3. **Routing**: Request is routed to the appropriate server (built-in or external)
4. **Approval** (optional): If tool requires approval, execution pauses until user approves/denies
5. **Execution**: Tool runs and produces a result
6. **Response**: Structured result or error is returned

### Approval Workflow

Some tools require explicit user approval before execution:
- Execution pauses and request enters approval queue
- User sees pending request in Approvals tab
- User approves or denies
- Tool continues with approval status
- Requests timeout after 30 seconds if not handled

### Transport Mechanisms

**stdio** - Commands communicate via standard input/output streams:
- Spawns a process with command and arguments
- JSON messages exchanged over stdin/stdout
- Process lifecycle managed by the application

**HTTP** - Servers accessible via HTTP endpoints:
- Connects to existing HTTP server
- REST API for tool discovery and execution
- Stateless request/response model

**WebSocket** - Real-time bidirectional communication:
- Persistent connection to WebSocket server
- Event-driven tool execution
- Lower latency for frequent operations

### Configuration

Server configurations persist between sessions in the application config file. Configuration includes:
- Server metadata (name, description)
- Transport details (type, connection info)
- Enabled/disabled state
- Creation timestamp

Built-in tool servers have simpler configuration (just enabled/disabled flags).

---

## HTTP API

The Tools Module exposes HTTP endpoints for tool management and execution.

### Hierarchy

```
Tool Servers
  └─ Tools
```

- **Tool Server**: A collection of related tools
- **Tool**: An individual function you can call

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/servers` | GET | List all tool servers |
| `/api/servers` | POST | Add new tool server |
| `/api/servers/:serverId` | GET | Get specific tool server |
| `/api/servers/:serverId` | PATCH | Update tool server |
| `/api/servers/:serverId` | DELETE | Remove tool server |
| `/api/servers/:serverId/toggle` | POST | Enable/disable tool server |
| `/api/servers/:serverId/tools/:toolName` | POST | Call a tool |

### List All Tool Servers

Get all available tool servers.

**Request:**
```bash
curl http://localhost:5177/api/servers
```

**Response:**
```json
{
  "servers": [
    {
      "id": "server-id",
      "name": "Server Name",
      "description": "What this server provides",
      "state": {
        "status": "connected",
        "tools": [
          {
            "name": "tool_name",
            "description": "What this tool does",
            "inputSchema": {
              "type": "object",
              "properties": {
                "param1": {
                  "type": "string",
                  "description": "Parameter description"
                }
              },
              "required": ["param1"]
            }
          }
        ]
      }
    }
  ]
}
```

**Fields:**
- `id` - Unique server identifier
- `name` - Human-readable name
- `description` - What the server provides
- `state.status` - `"connected"` or `"disconnected"`
- `state.tools[]` - Available tools with their schemas
- `config` - Configuration (only present for external servers)

**Tip:** Pretty print with jq:
```bash
curl -s http://localhost:5177/api/servers | jq '.servers[] | {id, name, tools: [.state.tools[].name]}'
```

### Call a Tool

Execute a tool from any server.

**Endpoint:**
```
POST /api/servers/{serverId}/tools/{toolName}
```

**Request:**
```bash
curl -X POST http://localhost:5177/api/servers/{serverId}/tools/{toolName} \
  -H "Content-Type: application/json" \
  -d '{
    "param1": "value1",
    "param2": "value2"
  }'
```

**How to find serverId and toolName:**
1. List all servers: `curl http://localhost:5177/api/servers`
2. Find the server you want (look at `id` field)
3. Look in `state.tools[]` for available tools
4. Check `inputSchema` to see what parameters to send

**Response (Success):**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Tool response (often JSON-formatted)"
    }
  ],
  "isError": false
}
```

**Response (Error):**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Error message"
    }
  ],
  "isError": true
}
```

### Add Tool Server

Add a new external tool server.

**Request:**
```bash
curl -X POST http://localhost:5177/api/servers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Tool Server",
    "description": "Description of what it does",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "your-package-name"],
    "enabled": true
  }'
```

**Transport Types:**

**stdio** (most common):
```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "package-name"],
  "env": {"KEY": "value"}
}
```

**http**:
```json
{
  "transport": "http",
  "url": "http://localhost:3000/tools"
}
```

**websocket**:
```json
{
  "transport": "websocket",
  "url": "ws://localhost:3000/ws"
}
```

**Response:**
```json
{
  "serverId": "abc123def456"
}
```

### Toggle Tool Server

Enable or disable a tool server.

**Request:**
```bash
curl -X POST http://localhost:5177/api/servers/{serverId}/toggle \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

**Response:**
```json
{
  "success": true
}
```

### Remove Tool Server

Delete a tool server.

**Request:**
```bash
curl -X DELETE http://localhost:5177/api/servers/{serverId}
```

**Response:**
```json
{
  "success": true
}
```

### Discovery Workflow

**Step 1: List All Servers**
```bash
curl http://localhost:5177/api/servers
```

**Step 2: Find What You Need**
```bash
# Show server names and tool counts
curl -s http://localhost:5177/api/servers | jq '.servers[] | {
  id: .id,
  name: .name,
  toolCount: (.state.tools | length)
}'
```

**Step 3: Check Tool Schema**
```bash
# See what parameters a tool needs
curl -s http://localhost:5177/api/servers | jq '.servers[] |
  select(.id == "your-server-id") |
  .state.tools[] |
  select(.name == "your_tool_name") |
  .inputSchema'
```

**Step 4: Call the Tool**
```bash
curl -X POST http://localhost:5177/api/servers/{serverId}/tools/{toolName} \
  -H "Content-Type: application/json" \
  -d '{"param1": "value1"}'
```

### Error Handling

**400 Bad Request:**
```json
{
  "error": "enabled field required (boolean)"
}
```

**404 Not Found:**
```json
{
  "error": "Tool server not found"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Failed to connect to tool server"
}
```

**Tool Execution Error:**
```json
{
  "content": [{"type": "text", "text": "Error message"}],
  "isError": true
}
```

---

## Built-in Tools Development Guide

Built-in tools are server-side functions that run directly as native code without external processes.

### Quick Start

Define your tool following this pattern, add to the built-in servers registry, and restart - done!

### Tool Structure

Each tool needs:
- **name**: Snake_case identifier (e.g., `get_current_time`)
- **description**: What the tool does (shown in UI)
- **inputSchema**: JSON Schema for parameters
- **handler**: Async function that does the work

Example:
```typescript
const myTool: BuiltinToolDefinition = {
  name: 'my_tool_name',
  description: 'Brief description of what this tool does',
  inputSchema: {
    type: 'object',
    properties: {
      param1: {
        type: 'string',
        description: 'Description of parameter 1',
      },
      param2: {
        type: 'number',
        description: 'Description of parameter 2',
        default: 42
      }
    },
    required: ['param1']
  },
  handler: async (args: Record<string, any>) => {
    try {
      // Your logic here
      const result = doSomething(args.param1, args.param2);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
```

### Server Definition

Group related tools into a "server":

```typescript
const myServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-myserver',              // Must start with 'builtin-'
  name: 'My Server',                    // Display name in UI
  description: 'Short server description',
  isBuiltin: true,                      // Always true
  tools: [myTool, anotherTool],        // Array of tools
  resources: [],                        // Leave empty for now
  prompts: []                           // Leave empty for now
};
```

### Input Schema Reference

The `inputSchema` follows JSON Schema specification. Common patterns:

**String Parameter:**
```typescript
param_name: {
  type: 'string',
  description: 'What this parameter is for',
  default: 'optional default value'
}
```

**Enum (Multiple Choice):**
```typescript
format: {
  type: 'string',
  enum: ['option1', 'option2', 'option3'],
  description: 'Choose one of these options',
  default: 'option1'
}
```

**Number Parameter:**
```typescript
count: {
  type: 'number',
  description: 'A numeric value',
  minimum: 0,
  maximum: 100,
  default: 10
}
```

**Boolean Parameter:**
```typescript
enabled: {
  type: 'boolean',
  description: 'Enable or disable something',
  default: true
}
```

**Array Parameter:**
```typescript
items: {
  type: 'array',
  items: { type: 'string' },
  description: 'List of items',
  default: []
}
```

**Object Parameter:**
```typescript
config: {
  type: 'object',
  properties: {
    key1: { type: 'string' },
    key2: { type: 'number' }
  },
  required: ['key1']
}
```

### Response Format

Always return structured response:

```typescript
return {
  content: [
    {
      type: 'text',
      text: 'Your response text here'
    }
  ],
  isError: false  // or true if something went wrong
};
```

**Multiple Content Items:**
```typescript
return {
  content: [
    { type: 'text', text: 'First part' },
    { type: 'text', text: 'Second part' }
  ],
  isError: false
};
```

**Image Response:**
```typescript
return {
  content: [
    {
      type: 'image',
      image: {
        data: 'base64-encoded-image-data',
        mimeType: 'image/png'
      }
    }
  ],
  isError: false
};
```

### Best Practices

**1. Error Handling** - Always wrap logic in try/catch:

```typescript
handler: async (args) => {
  try {
    // Your logic
    return { content: [{ type: 'text', text: result }], isError: false };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
}
```

**2. Parameter Validation** - Validate parameters before using them:

```typescript
handler: async (args) => {
  if (!args.required_param) {
    return {
      content: [{ type: 'text', text: 'Error: required_param is missing' }],
      isError: true
    };
  }
  // Continue with logic...
}
```

**3. Descriptive Messages** - Make descriptions clear and helpful:

```typescript
// Good
description: 'Send an email draft to the specified recipient with subject and body'

// Bad
description: 'Sends email'
```

**4. Use JSON for Complex Output** - For structured data, use JSON.stringify:

```typescript
const result = { status: 'success', data: { ... } };
return {
  content: [{
    type: 'text',
    text: JSON.stringify(result, null, 2)
  }],
  isError: false
};
```

**5. Platform-Specific Code** - Check platform before running platform-specific code:

```typescript
handler: async (args) => {
  if (process.platform !== 'darwin') {
    return {
      content: [{
        type: 'text',
        text: 'This tool is only available on macOS'
      }],
      isError: true
    };
  }
  // macOS-specific logic...
}
```

### Testing Your Tool

**Via API:**
```bash
# List all tools
curl http://localhost:5177/api/servers

# Call your tool
curl -X POST http://localhost:5177/api/servers/builtin-myserver/tools/my_tool_name \
  -H "Content-Type: application/json" \
  -d '{"param1": "value1", "param2": 123}'
```

**Via UI:**
1. Start the application
2. Go to Settings > Tools
3. Find your built-in tool
4. Click "Details" to see available tools

### Common Patterns

**File System Operations:**
```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';

handler: async (args) => {
  const filePath = path.join(WORKSPACE_PATH, args.filename);
  const content = await fs.readFile(filePath, 'utf-8');
  return { content: [{ type: 'text', text: content }], isError: false };
}
```

**HTTP Requests:**
```typescript
handler: async (args) => {
  const response = await fetch(args.url);
  const data = await response.json();
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError: false
  };
}
```

**Running Shell Commands:**
```typescript
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

handler: async (args) => {
  const { stdout, stderr } = await execAsync(args.command);
  return {
    content: [{ type: 'text', text: stdout || stderr }],
    isError: !!stderr
  };
}
```

### Troubleshooting

**Tool Not Appearing:**
- Check that server ID starts with `builtin-`
- Verify it's added to the built-in servers registry
- Restart the server

**Tool Returns Error:**
- Check console logs for error messages
- Verify input parameters match schema
- Test handler function logic separately

**Type Errors:**
- Make sure to import required types from `builtinTools.ts`
- Ensure all required fields are present in tool definition

---

## Advanced: Creating Subagent Tools

Some builtin tools (like `read_file` and `edit_file`) use **subagents** - they spawn internal AI agents with custom tools to accomplish their tasks.

### AI SDK v5 Tool Schema Requirement

**CRITICAL: When creating tools using AI SDK's `tool()` function for subagents, you MUST use `inputSchema`, NOT `parameters`.**

AI SDK v5 changed the property name from `parameters` (v4) to `inputSchema` (v5+). Using the wrong property name will cause runtime errors from OpenAI's API.

### The Problem

If you use the old `parameters` property:
```typescript
import { tool } from 'ai';
import { z } from 'zod';

const customTool = tool({
  description: 'Read file content',
  parameters: z.object({        // ❌ WRONG - deprecated v4 syntax
    confirm: z.literal('read')
  }),
  execute: async ({ confirm }) => {
    return fileContent;
  }
});
```

You'll get this error:
```
APICallError: Invalid schema for function 'tool_name':
schema must be a JSON Schema of 'type: "object"', got 'type: "None"'.
```

### The Solution

Use `inputSchema` instead:
```typescript
import { tool } from 'ai';
import { z } from 'zod';

const customTool = tool({
  description: 'Read file content',
  inputSchema: z.object({       // ✅ CORRECT - v5+ syntax
    confirm: z.literal('read')
  }),
  execute: async ({ confirm }) => {
    return fileContent;
  }
});
```

### Why This Happens

1. The `tool()` function in AI SDK v5 looks for `inputSchema` property
2. If you use `parameters` (old v4 name), it silently sets `inputSchema: undefined`
3. When the tool is passed to `streamText()`, it tries to generate a JSON Schema from `undefined`
4. This results in an invalid schema like `{ type: "None" }`
5. OpenAI's API rejects the invalid schema

### Using Custom Tools with Subagents

When creating a subagent with custom tools:

```typescript
import { runCodexSubagent } from '../agents/codexSubagentRunnerBridge';
import { tool } from 'ai';
import { z } from 'zod';

// 1. Create your custom tool with inputSchema (not parameters!)
const myCustomTool = tool({
  description: 'Does something specific',
  inputSchema: z.object({
    param: z.string()
  }),
  execute: async ({ param }) => {
    return `Result for ${param}`;
  }
});

// 2. Pass it to runAgent with customToolsOnly flag
const result = await runAgent({
  message: 'User query here',
  system: 'You are a helpful assistant...',
  customTools: {
    my_custom_tool: myCustomTool  // Tool name → tool object
  },
  customToolsOnly: true,  // Only use custom tools, not builtin tools
  timeout: 60000
});

// 3. Check the result
if (result.completed) {
  const assistantMessage = result.messages.find(m => m.role === 'assistant');
  console.log(assistantMessage?.text);
} else {
  console.error('Agent failed:', result.error);
}
```

### Examples in Codebase

See these files for working examples:
- `server/mcp/builtin-tools/filesystem/readFileTool.ts` - Creates `Read` tool
- `server/mcp/builtin-tools/filesystem/editFileTool.ts` - Creates `write_file` tool

### Key Points

- **Always use `inputSchema`** when creating tools with AI SDK's `tool()` function
- **Never use `parameters`** - that's deprecated v4 syntax
- **Test your tools** before committing - runtime errors are harder to debug than compile errors
- **Check the examples** in the codebase if you're unsure
