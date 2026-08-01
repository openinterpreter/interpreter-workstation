import crypto from 'crypto';
import express from 'express';
import { NylasCredentials, NylasTokenResponse } from './types';
import { saveNylasCredentials, deleteNylasCredentials } from './credentials';

// Nylas OAuth configuration
// NYLAS_CLIENT_ID is baked in at build time via esbuild define
const NYLAS_CLIENT_ID = process.env.NYLAS_CLIENT_ID;
const CALLBACK_PORTS = [28000, 28001, 28002];
const NYLAS_AUTH_URL = 'https://api.us.nylas.com/v3/connect/auth';
const NYLAS_TOKEN_URL = 'https://api.us.nylas.com/v3/connect/token';

/**
 * Generate PKCE (Proof Key for Code Exchange) credentials
 * Uses Nylas's expected format: UUID verifier, hex-to-base64 challenge
 * @returns Object containing verifier and challenge
 */
export function generatePKCE(): { verifier: string; challenge: string } {
  // Generate UUID as verifier (matches Nylas SDK implementation)
  const verifier = crypto.randomUUID();

  // Nylas-specific challenge computation:
  // 1. SHA256 hash the verifier
  // 2. Get hex string representation
  // 3. Base64 encode the hex string (not the raw bytes!)
  // 4. Remove padding
  const hexHash = crypto.createHash('sha256').update(verifier).digest('hex');
  const challenge = Buffer.from(hexHash).toString('base64').replace(/=+$/, '');

  console.log('[Nylas PKCE] Generated verifier:', verifier);
  console.log('[Nylas PKCE] Generated challenge:', challenge);

  return { verifier, challenge };
}

/**
 * Start the OAuth flow by creating a callback server and authorization URL
 * Uses PKCE for secure authentication without shipping secrets
 * @returns Object with authUrl, callbackServer, verifier, and redirectUri
 */
export async function startNylasOAuth(): Promise<{
  authUrl: string;
  callbackServer: any;
  httpServer: any;
  verifier: string;
  redirectUri: string;
}> {
  // Validate Nylas configuration
  if (!NYLAS_CLIENT_ID) {
    throw new Error(
      'Nylas is not configured. NYLAS_CLIENT_ID was not baked into build. ' +
      'Check build-electron.mjs define configuration.'
    );
  }

  // Generate PKCE credentials
  const { verifier, challenge } = generatePKCE();

  // Try to start server on available port
  let expressApp: any = null;
  let httpServer: any = null;
  let port: number = 0;

  for (const candidatePort of CALLBACK_PORTS) {
    try {
      const app = express();

      // Attempt to start server on this port
      httpServer = await new Promise<any>((resolve, reject) => {
        const s = app.listen(candidatePort, () => {
          port = candidatePort;
          expressApp = app;
          resolve(s);
        }).on('error', reject);
      });

      // Successfully bound to port
      break;
    } catch (error) {
      // Port is in use, try next one
      continue;
    }
  }

  if (!httpServer || !expressApp) {
    throw new Error('Failed to start OAuth callback server - all ports in use');
  }

  // Build redirect URI
  const redirectUri = `http://localhost:${port}/callback`;

  // Build authorization URL with PKCE parameters
  // Note: provider parameter is intentionally omitted to allow Nylas to show provider selection
  // access_type=offline to get refresh tokens for long-term access
  const authUrl = `${NYLAS_AUTH_URL}?` +
    `client_id=${encodeURIComponent(NYLAS_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&access_type=offline` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=s256`;

  console.log('[Nylas OAuth] Starting OAuth flow with redirect:', redirectUri);
  console.log('[Nylas OAuth] Full auth URL:', authUrl);
  console.log('[Nylas OAuth] Verifier:', verifier);
  console.log('[Nylas OAuth] Challenge:', challenge);

  return {
    authUrl,
    callbackServer: expressApp,
    httpServer,
    verifier,
    redirectUri,
  };
}

/**
 * Handle the OAuth callback by exchanging authorization code for access tokens
 * Uses PKCE flow - no API key needed
 * @param code - Authorization code from callback
 * @param verifier - PKCE verifier used in initial request
 * @param redirectUri - Redirect URI used in initial request
 */
export async function handleOAuthCallback(
  code: string,
  verifier: string,
  redirectUri: string
): Promise<void> {
  try {
    console.log('[Nylas OAuth] Token exchange with PKCE verifier:', verifier);

    // Build request body for PKCE flow (no client_secret needed)
    const requestBody = {
      client_id: NYLAS_CLIENT_ID,
      code: code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    };

    // Exchange authorization code for tokens
    const response = await fetch(NYLAS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Nylas OAuth] Token exchange failed:', errorText);
      throw new Error(
        `Token exchange failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const tokenResponse = (await response.json()) as NylasTokenResponse;
    console.log('[Nylas OAuth] Token response:', JSON.stringify(tokenResponse, null, 2));

    // Calculate expiration timestamp
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + tokenResponse.expires_in;

    // Create credentials object
    const credentials: NylasCredentials = {
      grant_id: tokenResponse.grant_id,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      expires_at: expiresAt,
      email: tokenResponse.email,
      provider: tokenResponse.provider as 'google' | 'microsoft' | 'yahoo' | 'imap',
      connected_at: new Date().toISOString(),
    };

    // Save credentials to disk
    await saveNylasCredentials(credentials);
    console.log('[Nylas OAuth] Successfully authenticated:', credentials.email);
  } catch (error) {
    console.error('[Nylas OAuth] Error handling callback:', error);
    throw new Error(`Failed to complete OAuth flow: ${error}`);
  }
}

/**
 * Disconnect Nylas by deleting stored credentials
 */
export async function disconnectNylas(): Promise<void> {
  await deleteNylasCredentials();
  console.log('[Nylas OAuth] Disconnected and credentials deleted');
  // TODO: Optionally revoke grant with Nylas API
  // This would require calling DELETE /v3/grants/{grant_id}
}
