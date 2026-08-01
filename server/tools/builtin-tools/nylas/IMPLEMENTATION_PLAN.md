# Nylas Email Integration - Implementation Plan

## Overview

This document outlines the architecture for adding Nylas email integration as a builtin tool with OAuth setup capability. The implementation adds the first tool that requires user setup via OAuth, establishing a pattern for future tools that need authentication.

**Scope**: Initially implementing only `list_messages` tool to validate the core OAuth and settings UI infrastructure.

---

## Architecture

### High-Level Flow

```
User clicks "Setup" in Settings
    ↓
Backend starts OAuth flow
    ↓
Opens system browser to Nylas OAuth page
    ↓
User authorizes email access
    ↓
Nylas redirects to localhost callback
    ↓
Backend receives auth code
    ↓
Backend exchanges code for access token (PKCE)
    ↓
Backend stores credentials in ~/.interpreter/nylas-credentials.json
    ↓
Settings UI updates to show "Connected"
    ↓
User enables Nylas tool (Start button)
    ↓
Agent can now use nylas_list_messages tool
```

---

## File Structure

All Nylas-related code will be centralized in a single folder:

```
server/mcp/builtin-tools/nylas/
├── IMPLEMENTATION_PLAN.md        # This file
├── index.ts                      # Server definition & registration
├── auth.ts                       # OAuth flow & credential management
├── credentials.ts                # Credential storage operations
├── listMessages.ts               # List messages tool implementation
└── types.ts                      # TypeScript types for Nylas API
```

**Additional modifications required outside this folder:**
- `server/mcp/builtinTools.ts` - Extend interfaces for setup capability
- `server/server.ts` - Add OAuth setup routes
- `src/components/McpServerCard.tsx` - Add setup button to UI
- `src/components/Settings.tsx` - Add setup handler
- `src/api.ts` - Add API client function for setup
- `package.json` - Add `nylas` npm dependency

---

## Component Descriptions

### 1. Type System Extensions

**File**: `server/mcp/builtinTools.ts`

**Purpose**: Extend the builtin tool interface to support tools that require user setup.

**Changes**:
```typescript
export interface BuiltinServerDefinition {
  id: string;
  name: string;
  description: string;
  isBuiltin: true;
  requiresSetup?: boolean;              // NEW: Tool needs setup before use
  setupDescription?: string;            // NEW: Text for setup button/description
  isConfigured?: () => Promise<boolean>; // NEW: Check if already configured
  tools: BuiltinToolDefinition[];
  resources: any[];
  prompts: any[];
}
```

**Natural Language Description**:
The builtin tool interface needs to communicate to the UI that this tool requires setup. Three new optional fields accomplish this:
- `requiresSetup` - Boolean flag indicating setup is needed
- `setupDescription` - User-facing text like "Connect your email account"
- `isConfigured` - Async function that checks if credentials exist

When the Settings page renders, it checks these fields and conditionally shows a "Setup" button. The `isConfigured` function is called to determine button state (Setup vs Reconfigure).

---

### 2. Server Definition

**File**: `server/mcp/builtin-tools/nylas/index.ts`

**Purpose**: Register the Nylas email server with the builtin tools system and configure it as requiring setup.

**Implementation**:
```typescript
import type { BuiltinServerDefinition } from '../../builtinTools.js';
import { listMessagesTool } from './listMessages.js';
import { isNylasConfigured } from './credentials.js';

export const nylasServerDefinition: BuiltinServerDefinition = {
  id: 'nylas',
  name: 'Nylas Email',
  description: 'Access email messages using your connected email account',
  isBuiltin: true,
  requiresSetup: true,
  setupDescription: 'Connect your email account',
  isConfigured: isNylasConfigured,
  tools: [listMessagesTool],
  resources: [],
  prompts: []
};
```

**Registration in BUILTIN_SERVERS array** (`server/mcp/builtinTools.ts`):
```typescript
import { nylasServerDefinition } from './builtin-tools/nylas/index.js';

export const BUILTIN_SERVERS: BuiltinServerDefinition[] = [
  // ... existing tools ...
  nylasServerDefinition
];
```

**Natural Language Description**:
This file exports the server definition that tells the system about the Nylas tool. It's marked as requiring setup, which triggers the Settings UI to show a setup button. The `isConfigured` function is imported from credentials.ts and checks if the user has already connected their email account by looking for stored credentials.

---

### 3. Credential Storage

**File**: `server/mcp/builtin-tools/nylas/credentials.ts`

**Purpose**: Handle reading, writing, and checking Nylas OAuth credentials stored on disk.

**Storage Location**: `~/.interpreter/nylas-credentials.json`

**Credential Format**:
```json
{
  "grant_id": "nylas_grant_abc123",
  "access_token": "nya_v3_access_token_xyz",
  "refresh_token": "nya_v3_refresh_token_xyz",
  "expires_at": 1699900000,
  "email": "user@example.com",
  "provider": "google",
  "connected_at": "2025-11-14T12:00:00Z"
}
```

**Functions**:

```typescript
interface NylasCredentials {
  grant_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email: string;
  provider: string;
  connected_at: string;
}

// Check if credentials exist and are valid
export async function isNylasConfigured(): Promise<boolean>

// Load credentials from disk
export async function getNylasCredentials(): Promise<NylasCredentials | null>

// Save credentials after OAuth
export async function saveNylasCredentials(credentials: NylasCredentials): Promise<void>

// Delete credentials (disconnect)
export async function deleteNylasCredentials(): Promise<void>

// Refresh access token if expired
export async function refreshAccessToken(): Promise<string>
```

**Natural Language Description**:
This module manages the credentials file that stores the user's OAuth tokens. When a user completes OAuth, the tokens are saved to `~/.interpreter/nylas-credentials.json` in the user's home directory. This file persists across app restarts.

The `isNylasConfigured` function checks if the file exists and contains valid credentials. This determines whether the Settings UI shows "Setup" or "Reconfigure".

The `refreshAccessToken` function handles the automatic refresh of expired access tokens using the refresh token. Nylas access tokens expire after 1 hour, but refresh tokens can be used to get new access tokens without re-authenticating.

---

### 4. OAuth Flow

**File**: `server/mcp/builtin-tools/nylas/auth.ts`

**Purpose**: Implement PKCE OAuth flow to obtain user authorization and exchange for access tokens.

**Key Constants**:
```typescript
const NYLAS_CLIENT_ID = 'your_client_id_here'; // Safe to ship in code
const CALLBACK_PORTS = [28000, 28001, 28002];   // Try multiple ports
const NYLAS_AUTH_URL = 'https://api.us.nylas.com/v3/connect/auth';
const NYLAS_TOKEN_URL = 'https://api.us.nylas.com/v3/connect/token';
```

**Functions**:

```typescript
// Generate PKCE challenge and verifier
function generatePKCE(): { verifier: string; challenge: string }

// Start OAuth flow - returns URL to open in browser
export async function startNylasOAuth(): Promise<string>

// Handle OAuth callback - called by Express route
export async function handleOAuthCallback(code: string, redirectUri: string, verifier: string): Promise<void>

// Disconnect - revoke credentials and delete local storage
export async function disconnectNylas(): Promise<void>
```

**Natural Language Description**:

When the user clicks "Setup" in the Settings UI, the backend calls `startNylasOAuth()`. This function:

1. **Generates PKCE credentials**: Creates a random code verifier and SHA256 hashes it to create the challenge. PKCE (Proof Key for Code Exchange) is a security mechanism that prevents authorization code interception attacks. It's essential for public clients like Electron apps that can't store secrets.

2. **Starts local callback server**: Tries to start an Express server on ports 28000, 28001, or 28002 (whichever is available). This server listens for the OAuth callback from Nylas.

3. **Builds authorization URL**: Constructs the Nylas OAuth URL with query parameters:
   - `client_id` - The app's public client ID (safe to hardcode)
   - `redirect_uri` - `http://localhost:[PORT]/callback`
   - `response_type=code` - We want an authorization code
   - `code_challenge` - The PKCE challenge
   - `code_challenge_method=S256` - SHA256 hashing
   - **Note**: The `provider` parameter is intentionally omitted. This allows Nylas to display a provider selection page where users can choose from Google, Microsoft, Yahoo, iCloud, and other supported email providers. This single OAuth flow supports all providers without requiring separate buttons or hardcoded provider values.

4. **Returns URL**: The URL is sent back to the frontend, which opens it in the system browser using Electron's `shell.openExternal()`. The user will see a Nylas-hosted page where they select their email provider (Google, Microsoft, Yahoo, etc.) before being redirected to that provider's login page.

When the user authorizes in the browser, Nylas redirects to `http://localhost:[PORT]/callback?code=AUTH_CODE`. The Express server's `/callback` route receives this and calls `handleOAuthCallback()`, which:

1. **Exchanges code for tokens**: Makes a POST request to Nylas token endpoint with:
   - Authorization code from callback
   - PKCE code verifier (to prove we started the flow)
   - Client ID and redirect URI

2. **Receives tokens**: Nylas returns:
   - `access_token` - Short-lived token (1 hour) for API requests
   - `refresh_token` - Long-lived token to get new access tokens
   - `grant_id` - Unique identifier for this user's email account
   - User email and provider info

3. **Stores credentials**: Saves all tokens to `~/.interpreter/nylas-credentials.json` via `saveNylasCredentials()`.

4. **Closes callback server**: Shuts down the temporary Express server.

The `disconnectNylas()` function deletes the local credentials file and optionally calls Nylas API to revoke the grant (recommended for security).

---

### 5. Backend API Routes

**File**: `server/server.ts`

**Purpose**: Add HTTP endpoints for OAuth setup flow.

**New Routes**:

```typescript
// Initiate OAuth setup
app.post('/api/servers/:serverId/setup', async (req, res) => {
  // Only supports 'nylas' server for now
  // Starts OAuth flow and returns URL to open
  // Frontend opens this URL in browser
})

// Check if tool is configured
app.get('/api/servers/:serverId/setup/status', async (req, res) => {
  // Calls server's isConfigured() function
  // Returns { configured: boolean, email?: string }
})

// OAuth callback endpoint
app.get('/oauth/callback/nylas', async (req, res) => {
  // Receives authorization code from Nylas
  // Exchanges for tokens
  // Saves credentials
  // Shows success page in browser
})

// Disconnect endpoint
app.post('/api/servers/:serverId/disconnect', async (req, res) => {
  // Deletes stored credentials
  // Revokes OAuth grant with Nylas
  // Returns success
})
```

**Natural Language Description**:

These routes bridge the frontend Settings UI with the OAuth flow logic.

The `/api/servers/:serverId/setup` endpoint is called when the user clicks "Setup". It checks if the server ID is 'nylas', then calls `startNylasOAuth()` from auth.ts. This returns an OAuth URL which is sent back to the frontend. The frontend opens this URL in the system browser.

The `/oauth/callback/nylas` endpoint is where Nylas redirects after user authorization. Unlike the frontend routes, this is accessed directly by the user's browser (not via IPC), so it's a plain GET endpoint. It extracts the authorization code from the query string and completes the token exchange, then shows a simple HTML success page telling the user they can close the browser tab.

The `/api/servers/:serverId/setup/status` endpoint allows the frontend to check if setup is complete. This is called when rendering the Settings page to determine whether to show "Setup" or "Reconfigure" button text.

The `/api/servers/:serverId/disconnect` endpoint handles cleanup when the user wants to disconnect their email. It removes local credentials and notifies Nylas to revoke the grant.

---

### 6. Frontend API Client

**File**: `src/api.ts`

**Purpose**: Provide type-safe API functions for the Settings UI.

**New Functions**:

```typescript
export async function setupToolServer(serverId: string): Promise<{ setupUrl: string }> {
  return apiRequest('POST', `/api/servers/${serverId}/setup`);
}

export async function getToolServerSetupStatus(serverId: string): Promise<{ configured: boolean; email?: string }> {
  return apiRequest('GET', `/api/servers/${serverId}/setup/status`);
}

export async function disconnectToolServer(serverId: string): Promise<{ success: boolean }> {
  return apiRequest('POST', `/api/servers/${serverId}/disconnect`);
}
```

**Natural Language Description**:

These functions wrap the HTTP API calls in a clean interface for React components to use. They use the existing `apiRequest` function which handles the Electron IPC bridge to make HTTP requests to the Express server. Each function is typed to return the expected response shape, providing autocomplete and type safety in the UI code.

---

### 7. Settings UI Component Updates

**File**: `src/components/McpServerCard.tsx`

**Purpose**: Display setup button for tools that require setup.

**Changes**:

Add `onSetup` and `onDisconnect` props:
```typescript
interface McpServerCardProps {
  server: {
    id: string;
    name: string;
    description?: string;
    state: McpConnectionState;
    config?: { transport: string; enabled: boolean };
    requiresSetup?: boolean;
    setupDescription?: string;
    isConfigured?: boolean;
  };
  onDelete?: () => void;
  onToggle: () => void;
  onSetup?: () => void;        // NEW
  onDisconnect?: () => void;   // NEW
}
```

Add setup/disconnect buttons in the action button row:
```tsx
<div className="flex gap-2">
  {server.requiresSetup && onSetup && onDisconnect && (
    <>
      {server.isConfigured ? (
        <button
          onClick={onDisconnect}
          className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200"
        >
          Disconnect
        </button>
      ) : (
        <button
          onClick={onSetup}
          className="px-3 py-1 text-sm bg-purple-100 text-purple-700 rounded hover:bg-purple-200"
        >
          Setup
        </button>
      )}
    </>
  )}

  <button onClick={onToggle}>
    {isConnected ? 'Stop' : 'Start'}
  </button>

  <button onClick={() => setExpanded(!expanded)}>
    {expanded ? 'Hide' : 'Details'}
  </button>

  {onDelete && (
    <button onClick={onDelete}>Delete</button>
  )}
</div>
```

Show connected email when configured:
```tsx
{server.isConfigured && server.email && (
  <div className="text-sm text-gray-600 mt-2">
    Connected as: {server.email}
  </div>
)}
```

**Natural Language Description**:

The tool card component now conditionally renders setup/disconnect buttons based on the `requiresSetup` flag and `isConfigured` state.

When a tool is not configured, it shows a purple "Setup" button. When configured, it shows a red "Disconnect" button and displays the connected email address.

The component receives `onSetup` and `onDisconnect` callback functions as props, which are called when the respective buttons are clicked. These callbacks are provided by the parent Settings.tsx component.

The styling uses Tailwind CSS classes to match the existing design system - purple for setup actions and red for destructive actions like disconnect.

---

### 8. Settings Page Logic

**File**: `src/components/Settings.tsx`

**Purpose**: Handle setup and disconnect actions, manage loading state.

**New Handler Functions**:

```typescript
async function handleSetupToolServer(serverId: string) {
  try {
    setLoading(true);

    // Get OAuth URL from backend
    const { setupUrl } = await setupToolServer(serverId);

    // Open in system browser using Electron shell
    window.electron.openExternal(setupUrl);

    showMessage('success', 'Opening setup in browser. Please authorize your email account.');

    // Poll for completion (check every 2 seconds)
    const pollInterval = setInterval(async () => {
      const status = await getToolServerSetupStatus(serverId);
      if (status.configured) {
        clearInterval(pollInterval);
        showMessage('success', `Email connected: ${status.email}`);
        await loadData(); // Refresh tool list
      }
    }, 2000);

    // Stop polling after 5 minutes (timeout)
    setTimeout(() => clearInterval(pollInterval), 300000);

  } catch (error: any) {
    showMessage('error', `Setup failed: ${error.message}`);
  } finally {
    setLoading(false);
  }
}

async function handleDisconnectToolServer(serverId: string) {
  try {
    setLoading(true);

    await disconnectToolServer(serverId);

    showMessage('success', 'Email account disconnected');
    await loadData(); // Refresh to show "Setup" button again

  } catch (error: any) {
    showMessage('error', `Disconnect failed: ${error.message}`);
  } finally {
    setLoading(false);
  }
}
```

**Update tool rendering**:
```tsx
{toolServers.map(server => (
  <McpServerCard
    key={server.id}
    server={server}
    onDelete={server.config ? () => handleDeleteToolServer(server.id) : undefined}
    onToggle={() => handleToggleToolServer(server.id, server.state.status === 'connected')}
    onSetup={server.requiresSetup ? () => handleSetupToolServer(server.id) : undefined}
    onDisconnect={server.requiresSetup ? () => handleDisconnectToolServer(server.id) : undefined}
  />
))}
```

**Natural Language Description**:

The Settings page component orchestrates the OAuth setup flow. When the user clicks "Setup", `handleSetupToolServer` is called.

This function first requests an OAuth URL from the backend. The backend starts a local callback server and returns a Nylas authorization URL. The Settings component then uses `window.electron.openExternal()` to open this URL in the user's default web browser (Chrome, Safari, etc.).

The app cannot detect when OAuth completes (the browser is external), so the component polls the backend every 2 seconds to check if credentials have been saved. Once `getToolServerSetupStatus` returns `configured: true`, polling stops and a success message is shown with the connected email address. The tool list is refreshed to update the UI.

There's a 5-minute timeout on polling to prevent infinite loops if the user abandons the OAuth flow.

The disconnect flow is simpler - it calls the backend disconnect endpoint, shows a success message, and refreshes the tool list to change the button back to "Setup".

---

### 9. Electron Shell Integration

**File**: `electron/preload.ts`

**Purpose**: Expose shell.openExternal to renderer process.

**Addition**:
```typescript
contextBridge.exposeInMainWorld('electron', {
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  apiRequest: (request: { method: string; path: string; body?: any }) =>
    ipcRenderer.invoke('api-request', request),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url), // NEW
  // ... existing methods
});
```

**File**: `electron/main.ts`

**Addition**:
```typescript
import { shell } from 'electron';

ipcMain.handle('open-external', async (_event, url: string) => {
  await shell.openExternal(url);
});
```

**Natural Language Description**:

Electron's security model requires exposing specific APIs to the renderer process via the preload script. The `shell.openExternal` function opens URLs in the system's default browser.

We add an IPC handler in the main process that calls `shell.openExternal`, and expose it to the renderer through the context bridge. This allows the Settings component to call `window.electron.openExternal(oauthUrl)` to open the OAuth page.

This is safer than allowing the renderer to directly access all of Electron's shell APIs - we only expose the specific function we need.

---

### 10. List Messages Tool

**File**: `server/mcp/builtin-tools/nylas/listMessages.ts`

**Purpose**: Implement the actual email listing functionality using Nylas API.

**Implementation**:

```typescript
import type { BuiltinToolDefinition } from '../../builtinTools.js';
import Nylas from 'nylas';
import { getNylasCredentials, refreshAccessToken } from './credentials.js';

export const listMessagesTool: BuiltinToolDefinition = {
  name: 'nylas_list_messages',
  description: 'List recent email messages from the user\'s inbox',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of messages to retrieve (default 10, max 50)',
        default: 10
      },
      unread_only: {
        type: 'boolean',
        description: 'Only return unread messages',
        default: false
      }
    }
  },
  handler: async (args: Record<string, any>) => {
    try {
      // 1. Check if user has connected their email
      const credentials = await getNylasCredentials();
      if (!credentials) {
        return {
          content: [{
            type: 'text',
            text: 'Error: Email not connected. Please set up Nylas in Settings first.'
          }],
          isError: true
        };
      }

      // 2. Check if access token is expired, refresh if needed
      let accessToken = credentials.access_token;
      if (Date.now() / 1000 > credentials.expires_at) {
        accessToken = await refreshAccessToken();
      }

      // 3. Make API request to list messages
      const response = await fetch(
        `https://api.us.nylas.com/v3/grants/${credentials.grant_id}/messages?limit=${args.limit || 10}${args.unread_only ? '&unread=true' : ''}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Nylas API error: ${error.message || response.statusText}`);
      }

      const data = await response.json();
      const messages = data.data;

      // 4. Format messages for AI
      const formatted = messages.map((msg: any) => ({
        id: msg.id,
        subject: msg.subject,
        from: msg.from?.[0]?.email,
        date: new Date(msg.date * 1000).toISOString(),
        snippet: msg.snippet,
        unread: msg.unread
      }));

      // 5. Return formatted results
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(formatted, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error listing messages: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
```

**Natural Language Description**:

This is the actual tool that the AI agent will use to read emails. When the agent calls `nylas_list_messages`, this handler function executes.

First, it checks if the user has connected their email by calling `getNylasCredentials()`. If no credentials exist, it returns an error telling the agent to ask the user to set up Nylas in Settings.

Next, it checks if the access token has expired. Nylas access tokens expire after 1 hour. If expired, it calls `refreshAccessToken()` to get a new one using the refresh token.

Then it makes an HTTP request to the Nylas API to list messages. The request uses:
- The user's `grant_id` to identify which email account
- The `access_token` for authorization
- Query parameters for limit and unread filtering

The Nylas API returns a list of message objects with lots of fields. The handler extracts just the important fields (id, subject, from, date, snippet, unread status) and formats them as a clean JSON array.

This formatted data is returned to the AI agent, which can then use it to answer the user's questions about their emails.

Error handling covers several cases:
- User hasn't set up email → Clear error message with next steps
- API request fails → Include Nylas error details
- Token refresh fails → Propagate error
- Network issues → Generic error handling

---

### 11. TypeScript Types

**File**: `server/mcp/builtin-tools/nylas/types.ts`

**Purpose**: Define TypeScript interfaces for Nylas API responses and internal data structures.

**Definitions**:

```typescript
// Stored credentials
export interface NylasCredentials {
  grant_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email: string;
  provider: 'google' | 'microsoft' | 'yahoo' | 'imap';
  connected_at: string;
}

// Token response from Nylas OAuth
export interface NylasTokenResponse {
  access_token: string;
  refresh_token: string;
  grant_id: string;
  email: string;
  provider: string;
  expires_in: number;
}

// Message object from Nylas API
export interface NylasMessage {
  id: string;
  grant_id: string;
  thread_id: string;
  subject: string;
  from: Array<{ email: string; name?: string }>;
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  date: number;
  snippet: string;
  body?: string;
  unread: boolean;
  starred: boolean;
  folders: string[];
}

// List messages response
export interface NylasListMessagesResponse {
  request_id: string;
  data: NylasMessage[];
  next_cursor?: string;
}
```

**Natural Language Description**:

These type definitions provide type safety throughout the Nylas integration. They describe the shape of data at various points:

- `NylasCredentials` - What we store in the credentials file
- `NylasTokenResponse` - What Nylas returns from the token endpoint
- `NylasMessage` - A single email message from the API
- `NylasListMessagesResponse` - The response wrapper containing messages

Using these types prevents runtime errors from typos or incorrect property access. TypeScript will catch errors at compile time like accessing `credentials.accessToken` when the property is actually `access_token`.

---

## Security Considerations

### What's Safe to Ship in Code

✅ **Safe to hardcode**:
- `NYLAS_CLIENT_ID` - This is a public identifier, like OAuth client IDs for Google/GitHub
- Callback URLs - These are localhost URLs, not secrets
- API endpoints - Public URLs

❌ **Never ship**:
- `NYLAS_API_KEY` - This is a server secret
- User access tokens - User-specific, stored locally
- Refresh tokens - User-specific, stored locally

### PKCE (Proof Key for Code Exchange)

PKCE is used instead of client secrets because Electron apps are public clients - anyone can decompile the app and extract hardcoded secrets. PKCE works by:

1. Generating a random `code_verifier` (high entropy random string)
2. Hashing it to create a `code_challenge`
3. Sending only the challenge to Nylas during authorization
4. Sending the verifier during token exchange

Even if an attacker intercepts the authorization code, they can't use it without the verifier, which never leaves the user's machine until token exchange.

### Credential Storage

Credentials are stored in `~/.interpreter/nylas-credentials.json` which is:
- Only readable by the current user (file permissions)
- Outside the app directory (survives app updates)
- In a hidden directory (not accidentally committed to git)

For additional security, consider encrypting this file using the OS keychain (macOS Keychain, Windows Credential Manager) in future iterations.

### Token Refresh

Access tokens expire after 1 hour. The tool handler checks expiration before each API call and automatically refreshes if needed. This means:
- Short-lived access tokens limit damage if compromised
- Refresh tokens are long-lived but only used for getting new access tokens
- Users don't need to re-authenticate unless refresh token is revoked

---

## Dependencies

### NPM Package

```bash
npm install nylas@^7.0.0
```

**Note**: Version 7.x is for Nylas v3 API. Don't use older versions as they target the deprecated v2 API.

### Native Dependencies

The `nylas` package has no native dependencies - it's pure JavaScript. However, the OAuth flow requires:
- `express` - Already in package.json
- `crypto` - Built into Node.js
- `electron` - Already in package.json

---

## Testing Plan

### Manual Testing Steps

1. **Setup Flow**:
   - Open Settings page
   - Verify Nylas Email tool shows "Setup" button
   - Click Setup
   - Verify browser opens to Nylas OAuth page
   - Authorize with test Gmail account
   - Verify success message appears
   - Verify Settings now shows "Disconnect" and connected email

2. **Credential Persistence**:
   - Restart app
   - Open Settings
   - Verify tool still shows as connected
   - Verify email address is displayed

3. **Tool Usage**:
   - Enable Nylas tool (Start button)
   - Open agent chat
   - Ask "List my recent emails"
   - Verify agent uses nylas_list_messages tool
   - Verify email list is returned and displayed

4. **Token Refresh**:
   - Manually edit credentials file to set `expires_at` to past timestamp
   - Ask agent to list emails
   - Verify token is refreshed automatically
   - Verify emails are retrieved successfully

5. **Disconnect Flow**:
   - Click Disconnect button
   - Verify confirmation message
   - Verify button changes to "Setup"
   - Verify credentials file is deleted
   - Attempt to use tool - verify error about not connected

6. **Error Cases**:
   - Try to use tool before setup → Should see helpful error
   - Disconnect internet during OAuth → Should see network error
   - Revoke grant in Nylas dashboard → Next API call should fail gracefully

---

## Future Enhancements

Once the core infrastructure is proven with `list_messages`, additional tools can be added easily:

### Additional Email Tools
- `nylas_send_email` - Send email messages
- `nylas_search_messages` - Search with Gmail-style syntax
- `nylas_read_message` - Get full message content including body
- `nylas_update_message` - Mark as read/unread, star, move folders
- `nylas_create_draft` - Create draft messages

### Calendar Integration
- `nylas_list_events` - List calendar events
- `nylas_create_event` - Create calendar events
- `nylas_update_event` - Modify events
- Same OAuth flow (calendar uses same grant)

### Multiple Accounts
- Store array of credentials instead of single object
- Add account selector in Settings
- Tool parameter to specify which account

### Enhanced Security
- Encrypt credentials file using OS keychain
- Implement secure token storage
- Add biometric authentication option

---

## Implementation Checklist

### Phase 1: Core Infrastructure
- [ ] Install `nylas` npm package
- [ ] Create `server/mcp/builtin-tools/nylas/` directory
- [ ] Extend `BuiltinServerDefinition` interface in `builtinTools.ts`
- [ ] Create `types.ts` with TypeScript interfaces

### Phase 2: Credential Management
- [ ] Implement `credentials.ts` with storage functions
- [ ] Implement `isNylasConfigured()`
- [ ] Implement `getNylasCredentials()`
- [ ] Implement `saveNylasCredentials()`
- [ ] Implement `deleteNylasCredentials()`
- [ ] Implement `refreshAccessToken()`

### Phase 3: OAuth Flow
- [ ] Implement `auth.ts` with OAuth functions
- [ ] Implement `generatePKCE()`
- [ ] Implement `startNylasOAuth()`
- [ ] Implement `handleOAuthCallback()`
- [ ] Implement `disconnectNylas()`

### Phase 4: Backend Routes
- [ ] Add `POST /api/servers/:serverId/setup` route
- [ ] Add `GET /api/servers/:serverId/setup/status` route
- [ ] Add `GET /oauth/callback/nylas` route
- [ ] Add `POST /api/servers/:serverId/disconnect` route

### Phase 5: Frontend API
- [ ] Add `setupToolServer()` to `src/api.ts`
- [ ] Add `getToolServerSetupStatus()` to `src/api.ts`
- [ ] Add `disconnectToolServer()` to `src/api.ts`
- [ ] Add `openExternal` IPC handler

### Phase 6: UI Components
- [ ] Update `McpServerCard.tsx` props interface
- [ ] Add setup/disconnect buttons to card
- [ ] Add connected email display
- [ ] Add handlers to `Settings.tsx`
- [ ] Implement polling for OAuth completion

### Phase 7: Tool Implementation
- [ ] Create `listMessages.ts` tool
- [ ] Create `index.ts` server definition
- [ ] Register in `BUILTIN_SERVERS` array
- [ ] Test tool with mock data

### Phase 8: Nylas Dashboard Setup
- [ ] Create Nylas application at dashboard-v3.nylas.com
- [ ] Get CLIENT_ID
- [ ] Add callback URIs (localhost:28000-28002)
- [ ] Configure Google connector
- [ ] Update CLIENT_ID in `auth.ts`

### Phase 9: Integration Testing
- [ ] Test complete OAuth flow
- [ ] Test credential persistence
- [ ] Test tool usage after setup
- [ ] Test disconnect and reconnect
- [ ] Test error cases

### Phase 10: Documentation
- [ ] Add inline code comments
- [ ] Document setup process for users
- [ ] Add troubleshooting guide
- [ ] Update main README if needed

---

## Summary

This implementation adds the first authenticated builtin tool to the codebase, establishing patterns for:
- User setup flows with OAuth
- Credential storage and management
- Token refresh and expiration handling
- Settings UI for tool configuration
- Integration with external services

The architecture is designed to be reusable - future tools that need authentication (e.g., Google Calendar, Slack, GitHub) can follow the same pattern of extending `BuiltinServerDefinition` with setup requirements and implementing the OAuth flow.

By starting with just `list_messages`, we validate the entire infrastructure before adding more complexity. Once this works, adding additional Nylas tools is straightforward - just create new tool definition files following the pattern established in `listMessages.ts`.
