# Nylas Integration Testing Guide

This document provides comprehensive testing instructions for the Nylas email integration.

## Prerequisites

Before testing, ensure you have completed the following setup in the Nylas Dashboard:

### 1. Nylas Dashboard Configuration

1. **Create a Nylas Application**
   - Go to [Nylas Dashboard](https://dashboard.nylas.com/)
   - Create a new application or select an existing one
   - Note your `Client ID` and `Client Secret`

2. **Configure OAuth Callback URLs**
   - Navigate to Application Settings > OAuth
   - Add the following callback URL:
     ```
     http://localhost:3000/api/nylas/callback
     ```
   - Ensure the callback URL matches exactly (including protocol and port)

3. **Enable Email Provider**
   - Select which email providers to support (Google, Microsoft, etc.)
   - Complete provider-specific OAuth setup if required

4. **Environment Variables**
   - Set the following environment variables in your `.env` file:
     ```
     NYLAS_CLIENT_ID=your_client_id_here
     NYLAS_CLIENT_SECRET=your_client_secret_here
     ```

### 2. Application Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the application:
   ```bash
   npm run build
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

---

## Test Scenarios

### Test 1: OAuth Flow - Fresh Setup

**Objective:** Verify the complete OAuth setup flow for a new user.

**Steps:**

1. **Initiate OAuth Flow**
   - Open the application
   - Navigate to Nylas settings or trigger the OAuth flow
   - Click "Connect Email Account" or equivalent button
   - Verify that you're redirected to Nylas hosted authentication page

2. **Provider Selection**
   - Select your email provider (Google, Microsoft, etc.)
   - Verify the provider's OAuth consent screen appears

3. **Grant Permissions**
   - Sign in with your email account
   - Review the requested permissions
   - Grant all requested permissions
   - Verify redirect back to the application

4. **Callback Handling**
   - After OAuth redirect, verify:
     - No error messages appear
     - Success message is displayed
     - Application shows connected status
     - User email address is displayed correctly

**Expected Results:**
- OAuth flow completes without errors
- User is successfully authenticated
- Credentials are saved to `~/.interpreter/nylas-credentials.json`
- Application shows "Connected" status

**How to Verify:**
```bash
# Check credentials file exists and is valid
cat ~/.interpreter/nylas-credentials.json | jq .

# Should show:
# {
#   "grant_id": "...",
#   "access_token": "...",
#   "refresh_token": "...",
#   "expires_at": ...,
#   "email": "your-email@example.com",
#   "provider": "google",
#   "connected_at": "..."
# }
```

---

### Test 2: Credential Persistence

**Objective:** Verify that credentials persist across application restarts.

**Steps:**

1. **Complete OAuth Flow** (Test 1)
   - Ensure you're successfully connected

2. **Restart Application**
   - Close the application completely
   - Restart the application
   - Navigate to email/Nylas section

3. **Verify Connection State**
   - Check that the application shows "Connected" status
   - Verify email address is still displayed
   - No re-authentication should be required

**Expected Results:**
- Application remembers connection state
- No need to re-authenticate
- Credentials loaded from disk successfully

---

### Test 3: List Messages Tool

**Objective:** Test the list_nylas_messages tool functionality.

**Steps:**

1. **Ensure Connected** (Complete Test 1 first)

2. **Invoke Tool via Agent**
   - Open an agent chat
   - Send a message like:
     ```
     Please list my recent emails
     ```
   - Or explicitly request:
     ```
     Use the list_nylas_messages tool to show me my inbox
     ```

3. **Verify Response**
   - Agent should invoke `list_nylas_messages` tool
   - Tool should return a list of messages
   - Check that messages include:
     - Subject lines
     - Sender names/emails
     - Dates
     - Snippets/previews

4. **Test Parameters**
   - Test with limit parameter:
     ```
     Show me the 5 most recent emails
     ```
   - Test unread filter:
     ```
     Show me only unread emails
     ```
   - Test search:
     ```
     Find emails from support@example.com
     ```

**Expected Results:**
- Tool executes successfully
- Returns real messages from your inbox
- Parameters (limit, unread, search) are respected
- Tool UI shows execution details

---

### Test 4: Token Refresh

**Objective:** Verify automatic token refresh when access token expires.

**Steps:**

1. **Setup Expired Token** (Manual)
   - Edit `~/.interpreter/nylas-credentials.json`
   - Set `expires_at` to a past timestamp:
     ```json
     {
       ...
       "expires_at": 1000000000
     }
     ```
   - Save the file

2. **Trigger Tool Use**
   - Use the agent to list messages:
     ```
     Show me my recent emails
     ```

3. **Verify Automatic Refresh**
   - Tool should execute successfully (no errors)
   - Check credentials file was updated:
     ```bash
     cat ~/.interpreter/nylas-credentials.json | jq '.expires_at'
     ```
   - `expires_at` should be a future timestamp
   - `access_token` should be different

**Expected Results:**
- Token refresh happens transparently
- Tool execution succeeds
- New token saved to disk
- No user intervention required

**Note:** This test requires manual file editing. In production, tokens naturally expire after ~1 hour.

---

### Test 5: Disconnect Flow

**Objective:** Test disconnecting the email account.

**Steps:**

1. **Ensure Connected** (Complete Test 1 first)

2. **Trigger Disconnect**
   - Navigate to Nylas settings
   - Click "Disconnect Email Account" button
   - Confirm the disconnect action if prompted

3. **Verify Disconnect**
   - Application should show "Disconnected" status
   - Email address should no longer be displayed
   - Check credentials file is deleted:
     ```bash
     ls ~/.interpreter/nylas-credentials.json
     # Should show: No such file or directory
     ```

4. **Verify Tools Unavailable**
   - Try to use email tools in agent chat
   - Should receive message about needing to connect first

**Expected Results:**
- Disconnect succeeds
- Credentials file deleted
- Application shows disconnected state
- Tools require re-authentication

---

### Test 6: Reconnect After Disconnect

**Objective:** Verify you can reconnect after disconnecting.

**Steps:**

1. **Complete Disconnect** (Test 5)
2. **Reconnect**
   - Click "Connect Email Account" again
   - Complete OAuth flow
   - Verify successful connection

**Expected Results:**
- OAuth flow works again
- New credentials saved
- Tools work correctly

---

## Error Case Testing

### Error Test 1: Invalid Callback Code

**Objective:** Test handling of invalid OAuth callback.

**Steps:**

1. Manually navigate to:
   ```
   http://localhost:3000/api/nylas/callback?code=INVALID_CODE
   ```

**Expected Results:**
- Application shows appropriate error message
- User is informed to try setup again
- No credentials file created

---

### Error Test 2: Missing Environment Variables

**Objective:** Test behavior when Nylas credentials aren't configured.

**Steps:**

1. Remove `NYLAS_CLIENT_ID` and `NYLAS_CLIENT_SECRET` from environment
2. Restart application
3. Try to initiate OAuth flow

**Expected Results:**
- Appropriate error message about missing configuration
- User directed to configure environment variables
- Application doesn't crash

---

### Error Test 3: Network Failure During Refresh

**Objective:** Test handling of network errors during token refresh.

**Steps:**

1. Setup expired token (like Test 4)
2. Disconnect network
3. Try to use email tools

**Expected Results:**
- Application shows network error message
- Suggests checking internet connection
- Doesn't delete credentials

---

### Error Test 4: Corrupted Credentials File

**Objective:** Test handling of corrupted credentials.

**Steps:**

1. Edit `~/.interpreter/nylas-credentials.json`
2. Make it invalid JSON:
   ```
   { invalid json content
   ```
3. Restart application

**Expected Results:**
- Application detects invalid credentials
- Shows "Disconnected" state
- Allows user to reconnect
- Doesn't crash

---

## API Endpoint Testing

### Manual API Tests

Use `curl` to test API endpoints directly:

1. **Setup Endpoint**
   ```bash
   curl -X POST http://localhost:3000/api/nylas/setup
   ```
   - Should return: `{ "url": "https://api.nylas.com/..." }`

2. **Status Endpoint**
   ```bash
   curl http://localhost:3000/api/nylas/status
   ```
   - When connected: `{ "connected": true, "email": "..." }`
   - When disconnected: `{ "connected": false }`

3. **Disconnect Endpoint**
   ```bash
   curl -X POST http://localhost:3000/api/nylas/disconnect
   ```
   - Should return: `{ "message": "Disconnected successfully" }`

---

## Performance Testing

### Test: Large Inbox Performance

**Objective:** Verify performance with large numbers of emails.

**Steps:**

1. Use an email account with 1000+ messages
2. List messages with various limits:
   - `limit=10`
   - `limit=50`
   - `limit=100`
3. Measure response time

**Expected Results:**
- Response time < 5 seconds for limit=50
- No timeout errors
- Results properly paginated

---

## Security Testing

### Security Test 1: Credentials File Permissions

**Objective:** Verify credentials file has appropriate permissions.

**Steps:**

1. After OAuth setup, check file permissions:
   ```bash
   ls -la ~/.interpreter/nylas-credentials.json
   ```

**Expected Results:**
- File is readable only by current user
- Recommended permissions: `600` (rw-------)

### Security Test 2: Token Not Exposed in Logs

**Objective:** Ensure tokens aren't logged.

**Steps:**

1. Enable verbose logging
2. Complete OAuth flow
3. Check application logs

**Expected Results:**
- Access token not visible in logs
- Refresh token not visible in logs
- Only generic success/error messages logged

---

## Cleanup After Testing

After completing all tests:

1. **Disconnect Email Account**
   ```bash
   # Via UI or:
   curl -X POST http://localhost:3000/api/nylas/disconnect
   ```

2. **Remove Credentials File**
   ```bash
   rm ~/.interpreter/nylas-credentials.json
   ```

3. **Revoke App Access** (Optional)
   - Go to your email provider's security settings
   - Revoke access for the Nylas test app

---

## Troubleshooting

### Issue: OAuth redirect doesn't work

**Solution:**
- Verify callback URL in Nylas Dashboard matches exactly
- Check that development server is running on correct port
- Clear browser cookies and try again

### Issue: "No credentials found" after setup

**Solution:**
- Check `~/.interpreter/` directory exists and is writable
- Verify credentials file was created
- Check file contents are valid JSON

### Issue: Tools fail with "Invalid grant"

**Solution:**
- Token may have been revoked
- Disconnect and reconnect
- Check Nylas Dashboard for grant status

### Issue: Messages not appearing

**Solution:**
- Verify email account actually has messages
- Check grant has correct scopes (mail.read)
- Try with limit=1 to test basic functionality

---

## Test Checklist

Use this checklist to track testing progress:

- [ ] OAuth flow - fresh setup (Test 1)
- [ ] Credential persistence (Test 2)
- [ ] List messages tool (Test 3)
- [ ] Token refresh (Test 4)
- [ ] Disconnect flow (Test 5)
- [ ] Reconnect after disconnect (Test 6)
- [ ] Invalid callback code (Error Test 1)
- [ ] Missing environment variables (Error Test 2)
- [ ] Network failure during refresh (Error Test 3)
- [ ] Corrupted credentials file (Error Test 4)
- [ ] API endpoints work correctly
- [ ] Performance with large inbox
- [ ] Credentials file permissions
- [ ] Tokens not exposed in logs

---

## Reporting Issues

When reporting issues, include:

1. **Test scenario** that failed
2. **Steps to reproduce**
3. **Expected vs actual results**
4. **Error messages** (if any)
5. **Credentials file contents** (with tokens redacted)
6. **Application logs** (with tokens redacted)
7. **Environment details** (OS, Node version, etc.)

---

## Additional Resources

- [Nylas API Documentation](https://developer.nylas.com/)
- [OAuth 2.0 Flow](https://developer.nylas.com/docs/v3/auth/)
- [Nylas Dashboard](https://dashboard.nylas.com/)
