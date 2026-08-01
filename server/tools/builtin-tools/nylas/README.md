# Nylas Email Integration

A comprehensive email integration for the Interpreter Workstation application using the Nylas API. This integration enables AI agents to read and interact with email messages through a secure OAuth flow.

---

## Features

- **OAuth 2.0 Authentication** with PKCE security
- **Multiple Provider Support**: Google, Microsoft, Yahoo, IMAP
- **Automatic Token Refresh** with 5-minute buffer
- **Secure Credential Storage** in `~/.interpreter/`
- **List Messages Tool** for AI agent integration
- **Built-in Interpreter Workstation** compatible

---

## Architecture

### Module Structure

```
nylas/
├── index.ts              # Tool registration and exports
├── types.ts              # TypeScript type definitions
├── credentials.ts        # Credential management (read/write/refresh)
├── auth.ts               # OAuth flow implementation
├── listMessages.ts       # List messages MCP tool
├── credentials.test.ts   # Unit tests
├── TESTING.md           # Manual testing guide
├── TEST-COVERAGE.md     # Test coverage summary
└── README.md            # This file
```

### Data Flow

```
User → Setup UI → OAuth Flow → Nylas API → Credentials Storage
                                               ↓
Agent → List Messages Tool → Refresh Token → Nylas API → Results
```

---

## Setup

### Prerequisites

1. **Nylas Account**
   - Sign up at [Nylas Dashboard](https://dashboard.nylas.com/)
   - Create an application
   - Note your Client ID and Client Secret

2. **Configure OAuth Callback**
   - In Nylas Dashboard → Application Settings → OAuth
   - Add callback URL: `http://localhost:3000/api/nylas/callback`
   - Save settings

3. **Environment Variables**

Create or update `.env` file:

```bash
NYLAS_CLIENT_ID=your_client_id_here
NYLAS_CLIENT_SECRET=your_client_secret_here
```

### Installation

The Nylas integration is built-in to the Interpreter Workstation application. No additional installation required.

### Build

```bash
npm run build
```

---

## Usage

### 1. Connect Email Account

**Via API:**

```bash
curl -X POST http://localhost:3000/api/nylas/setup
```

Response:
```json
{
  "url": "https://api.nylas.com/v3/connect/auth?..."
}
```

Open the URL in a browser to complete OAuth.

**Via UI:**

- Navigate to settings
- Click "Connect Email Account"
- Follow OAuth flow
- Grant permissions

### 2. Check Connection Status

```bash
curl http://localhost:3000/api/nylas/status
```

Response when connected:
```json
{
  "connected": true,
  "email": "user@example.com",
  "provider": "google"
}
```

### 3. Use Email Tools in Agent

```
User: Show me my recent emails

Agent: [Calls list_nylas_messages tool]
```

The agent will automatically:
1. Check if token needs refresh
2. Refresh token if needed
3. Call Nylas API
4. Return formatted results

### 4. Disconnect Account

```bash
curl -X POST http://localhost:3000/api/nylas/disconnect
```

This deletes stored credentials from disk.

---

## API Endpoints

### POST /api/nylas/setup

Initiates OAuth flow.

**Response:**
```json
{
  "url": "https://api.nylas.com/v3/connect/auth?..."
}
```

### GET /api/nylas/callback

OAuth callback endpoint (used by Nylas, not called directly).

**Query Parameters:**
- `code`: Authorization code from Nylas

**Response:**
- Success: HTML page with success message
- Error: HTML page with error message

### GET /api/nylas/status

Check connection status.

**Response:**
```json
{
  "connected": true,
  "email": "user@example.com",
  "provider": "google"
}
```

### POST /api/nylas/disconnect

Disconnect email account.

**Response:**
```json
{
  "message": "Disconnected successfully"
}
```

---

## Interpreter Workstation

### list_nylas_messages

Lists email messages from the connected account.

**Input Schema:**
```typescript
{
  limit?: number;      // Max messages to return (default: 10)
  unread?: boolean;    // Filter to unread only
  search?: string;     // Search query
}
```

**Example Agent Usage:**
```
User: Show me the 5 most recent unread emails

Agent calls tool with:
{
  "limit": 5,
  "unread": true
}
```

**Output:**
```json
[
  {
    "id": "message_123",
    "subject": "Meeting reminder",
    "from": "sender@example.com",
    "date": "2024-01-15T10:30:00.000Z",
    "snippet": "Don't forget about tomorrow's meeting...",
    "unread": true
  }
]
```

---

## Credential Storage

### File Location

```
~/.interpreter/nylas-credentials.json
```

### File Format

```json
{
  "grant_id": "grant_abc123",
  "access_token": "nylas_access_token_here",
  "refresh_token": "nylas_refresh_token_here",
  "expires_at": 1705320000,
  "email": "user@example.com",
  "provider": "google",
  "connected_at": "2024-01-15T10:00:00.000Z"
}
```

### Security

- File created with default system permissions
- Stored in user's home directory
- Not included in version control
- Tokens not logged to console
- Recommend setting file permissions to `600`

---

## Token Management

### Access Token Lifecycle

1. **Initial Grant** - Token obtained during OAuth flow
2. **Usage** - Token used for API calls
3. **Expiration** - Tokens expire after ~1 hour
4. **Refresh** - Automatic refresh when needed

### Automatic Refresh

The `refreshAccessToken()` function:
- Checks token expiration before each API call
- Applies 5-minute buffer (refreshes if < 5 min remaining)
- Exchanges refresh token for new access token
- Updates stored credentials with new token
- Returns new access token for immediate use

**Example:**
```typescript
const token = await refreshAccessToken();
// Use token immediately for API call
```

### Error Handling

If refresh fails:
- Error logged to console
- User prompted to reconnect
- Stored credentials may be invalid

---

## Error Scenarios

### "No credentials found"

**Cause:** User hasn't connected email account

**Solution:** Complete OAuth setup flow

### "Token refresh failed"

**Cause:**
- Network error
- Refresh token expired/revoked
- Nylas API issue

**Solution:**
- Check internet connection
- Disconnect and reconnect
- Check Nylas Dashboard for grant status

### "Invalid grant"

**Cause:** OAuth grant revoked or invalid

**Solution:**
- Disconnect and reconnect
- Check grant in Nylas Dashboard
- Ensure OAuth callback URL is correct

### "Missing environment variables"

**Cause:** `NYLAS_CLIENT_ID` or `NYLAS_CLIENT_SECRET` not set

**Solution:** Add to `.env` file and restart server

---

## Testing

### Run Unit Tests

```bash
npx tsx --test server/mcp/builtin-tools/nylas/credentials.test.ts
```

**Expected:** 21 tests pass

### Manual Testing

Follow the comprehensive guide in `TESTING.md`:

1. OAuth flow testing
2. Credential persistence
3. Tool functionality
4. Token refresh
5. Error handling
6. Security validation

See `TESTING.md` for detailed steps.

### Test Coverage

See `TEST-COVERAGE.md` for:
- Coverage summary
- What's tested vs. what's not
- Recommendations for additional testing

---

## Development

### Adding New Tools

1. Create tool implementation in new file (e.g., `sendMessage.ts`)
2. Define tool schema
3. Implement tool logic
4. Register tool in `index.ts`

**Example:**
```typescript
// sendMessage.ts
export const sendMessageTool = {
  name: 'send_nylas_message',
  description: 'Send an email message',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' }
    },
    required: ['to', 'subject', 'body']
  }
};

export async function sendMessage({ to, subject, body }) {
  const token = await refreshAccessToken();
  // Call Nylas API to send message
}
```

### Debugging

Enable verbose logging:
```typescript
// Add to credentials.ts or auth.ts
console.log('[Nylas Debug]', /* debug info */);
```

Check credentials file:
```bash
cat ~/.interpreter/nylas-credentials.json | jq .
```

Test API endpoints directly:
```bash
curl -v http://localhost:3000/api/nylas/status
```

---

## Troubleshooting

### OAuth redirect doesn't work

1. Verify callback URL in Nylas Dashboard matches exactly
2. Check server is running on port 3000
3. Clear browser cookies and try again

### Credentials file not created

1. Check `~/.interpreter/` directory exists and is writable
2. Check console for errors
3. Verify OAuth flow completed successfully

### Tools not available in agent

1. Verify connection status: `GET /api/nylas/status`
2. Check credentials exist: `ls ~/.interpreter/nylas-credentials.json`
3. Restart server to reload tools

### Messages not appearing

1. Verify email account has messages
2. Check grant has correct scopes in Nylas Dashboard
3. Try with `limit=1` to test basic functionality

---

## API Documentation

### Nylas API Version

This integration uses **Nylas API v3**.

### Key Endpoints Used

- `POST /v3/connect/token` - Token exchange and refresh
- `GET /v3/grants/{grant_id}/messages` - List messages
- OAuth endpoints for authentication

### Rate Limits

Nylas API has rate limits:
- Check response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`
- Implement backoff if rate limited
- Consider caching for frequently accessed data

### Supported Scopes

Current implementation uses:
- `email.read_only` - Read email messages
- `email.modify` - Modify messages (future use)
- `email.send` - Send messages (future use)

---

## Roadmap

### Planned Features

- [ ] Send email messages
- [ ] Search with advanced filters
- [ ] Mark as read/unread
- [ ] Delete messages
- [ ] Create drafts
- [ ] Attachment handling
- [ ] Calendar integration
- [ ] Contact management

### Potential Improvements

- [ ] Add integration tests
- [ ] Implement webhook support
- [ ] Add email synchronization
- [ ] Improve error messaging
- [ ] Add retry logic for API calls
- [ ] Implement caching

---

## Contributing

When contributing to the Nylas integration:

1. **Run Tests**
   ```bash
   npx tsx --test server/mcp/builtin-tools/nylas/credentials.test.ts
   npm run build
   ```

2. **Follow Patterns**
   - Use TypeScript strict mode
   - Add JSDoc comments
   - Handle errors gracefully
   - Log appropriately (no sensitive data)

3. **Add Tests**
   - Add unit tests for new logic
   - Update `TESTING.md` with manual test procedures
   - Update `TEST-COVERAGE.md` with coverage info

4. **Security**
   - Never log tokens
   - Validate all inputs
   - Handle errors securely
   - Follow OAuth best practices

---

## Resources

- [Nylas API Documentation](https://developer.nylas.com/)
- [OAuth 2.0 with PKCE](https://developer.nylas.com/docs/v3/auth/)
- [Nylas Dashboard](https://dashboard.nylas.com/)
- [Interpreter Workstation Documentation](../../README.md)

---

## License

Part of the Interpreter Workstation application. See main project license.

---

## Support

For issues or questions:
1. Check `TESTING.md` for common issues
2. Review `TEST-COVERAGE.md` for known limitations
3. Check Nylas Dashboard for grant status
4. Review application logs for errors

---

## Changelog

### Phase 7 - Testing & Validation (Current)
- Added unit tests (21 tests)
- Created manual testing guide
- Fixed TypeScript compilation errors
- Documented test coverage

### Phase 6 - Tool Implementation
- Implemented list_nylas_messages tool
- Added tool registration

### Phase 5 - Token Refresh
- Implemented automatic token refresh
- Added 5-minute buffer logic

### Phase 4 - Credential Management
- File-based credential storage
- Validation and error handling

### Phase 3 - OAuth Callback
- Callback endpoint implementation
- Token exchange logic

### Phase 2 - OAuth Flow
- PKCE implementation
- Authorization URL generation

### Phase 1 - Setup
- Initial project structure
- Type definitions
- Environment configuration
