import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { NylasCredentials, NylasTokenResponse } from './types';

// Placeholder for Nylas client ID - should be configured via environment variable
const CLIENT_ID = process.env.NYLAS_CLIENT_ID || 'YOUR_NYLAS_CLIENT_ID';
const NYLAS_TOKEN_ENDPOINT = 'https://api.us.nylas.com/v3/connect/token';

// Path to credentials file
const CREDENTIALS_DIR = path.join(os.homedir(), '.interpreter');
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, 'nylas-credentials.json');

// Error types that indicate the token is permanently invalid and credentials should be cleared
const INVALID_TOKEN_ERRORS = [
  'token.unauthorized_access',
  'Bearer token invalid',
  'invalid_grant',
  'access_denied'
];

// Default timeout for Nylas API requests (30 seconds)
const API_TIMEOUT_MS = 30000;

/**
 * Fetch with timeout support
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if Nylas is configured with valid credentials
 * @returns true if credentials exist and are valid, false otherwise
 */
export async function isNylasConfigured(): Promise<boolean> {
  try {
    const credentials = await getNylasCredentials();
    return credentials !== null;
  } catch (error) {
    return false;
  }
}

/**
 * Load Nylas credentials from disk
 * @returns credentials object or null if not found/invalid
 */
export async function getNylasCredentials(): Promise<NylasCredentials | null> {
  try {
    const data = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
    const credentials = JSON.parse(data) as NylasCredentials;

    // Validate required fields (refresh_token is optional for PKCE flow)
    if (
      !credentials.grant_id ||
      !credentials.access_token ||
      !credentials.expires_at ||
      !credentials.email ||
      !credentials.provider
    ) {
      console.warn('Invalid Nylas credentials format - missing required fields');
      console.warn('Has grant_id:', !!credentials.grant_id);
      console.warn('Has access_token:', !!credentials.access_token);
      console.warn('Has expires_at:', !!credentials.expires_at);
      console.warn('Has email:', !!credentials.email);
      console.warn('Has provider:', !!credentials.provider);
      return null;
    }

    return credentials;
  } catch (error) {
    // File doesn't exist or is invalid JSON
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.error('Error reading Nylas credentials:', error);
    return null;
  }
}

/**
 * Save Nylas credentials to disk
 * @param credentials - The credentials to save
 */
export async function saveNylasCredentials(credentials: NylasCredentials): Promise<void> {
  try {
    // Ensure the directory exists
    await fs.mkdir(CREDENTIALS_DIR, { recursive: true });

    // Write credentials with pretty formatting
    await fs.writeFile(
      CREDENTIALS_PATH,
      JSON.stringify(credentials, null, 2),
      'utf-8'
    );
  } catch (error) {
    console.error('Error saving Nylas credentials:', error);
    throw new Error(`Failed to save Nylas credentials: ${error}`);
  }
}

/**
 * Delete the Nylas credentials file
 */
export async function deleteNylasCredentials(): Promise<void> {
  try {
    await fs.unlink(CREDENTIALS_PATH);
  } catch (error) {
    // Don't throw error if file doesn't exist
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Error deleting Nylas credentials:', error);
      throw new Error(`Failed to delete Nylas credentials: ${error}`);
    }
  }
}

/**
 * Check if an error indicates the token is permanently invalid
 * If so, automatically delete credentials so user can re-authenticate
 * @param errorResponse - The error response text or object from Nylas API
 * @returns true if credentials were cleared, false otherwise
 */
export async function handleTokenError(errorResponse: string): Promise<boolean> {
  const isInvalidToken = INVALID_TOKEN_ERRORS.some(err =>
    errorResponse.includes(err)
  );

  if (isInvalidToken) {
    console.warn('[Nylas] Token invalid, clearing credentials for re-authentication');
    await deleteNylasCredentials();
    return true;
  }
  return false;
}

/**
 * Refresh the access token if it's expired
 * @returns the current (or newly refreshed) access token
 */
export async function refreshAccessToken(): Promise<string> {
  const credentials = await getNylasCredentials();

  if (!credentials) {
    throw new Error('No Nylas credentials found');
  }

  // Check if token is expired (add 5 minute buffer)
  const now = Math.floor(Date.now() / 1000);
  const bufferSeconds = 300; // 5 minutes

  if (credentials.expires_at > now + bufferSeconds) {
    // Token is still valid
    return credentials.access_token;
  }

  // Token is expired or about to expire, refresh it
  // Check if we have a refresh token
  if (!credentials.refresh_token) {
    throw new Error('Access token expired and no refresh token available. Please reconnect your email in Settings.');
  }

  try {
    const response = await fetch(NYLAS_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: credentials.refresh_token,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as NylasTokenResponse;

    // Update credentials with new access token and expiration
    // Preserve existing refresh_token if new one not provided
    const updatedCredentials: NylasCredentials = {
      ...credentials,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || credentials.refresh_token,
      expires_at: now + tokenData.expires_in,
    };

    // Save updated credentials
    await saveNylasCredentials(updatedCredentials);

    return tokenData.access_token;
  } catch (error) {
    console.error('Error refreshing access token:', error);
    throw new Error(`Failed to refresh Nylas access token: ${error}`);
  }
}
