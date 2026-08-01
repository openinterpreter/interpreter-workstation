import { Router, Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { clearServerJWT, setServerJWT, getServerJWT } from '../lib/jwtStore';
import { emitServerAuthChanged } from '../lib/auth-events';
import { getAuthTokens, setAuthTokens, clearAuthTokens } from '../configStore';
import { DISK_SPACE_FULL_WARNING, type DiskSpaceFullWarning, isDiskSpaceFullError } from '../../shared/diskSpace';

const router = Router();

/**
 * Set Sentry user context from JWT access token
 */
function setSentryUser(accessToken: string | null): void {
  if (!accessToken) {
    Sentry.setUser(null);
    return;
  }
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    Sentry.setUser({
      id: payload.sub,
      email: payload.email,
    });
  } catch {
    Sentry.setUser(null);
  }
}

// =============================================================================
// Auth Routes
// =============================================================================
//
// Authentication flow:
// 1. Primary: Supabase handles auth via localStorage in the frontend
// 2. Server cache: Frontend calls update-jwt to populate server's in-memory cache
// 3. Config file: Tokens are written to config file for CI/test bootstrapping
//
// On app startup:
// - Frontend checks Supabase localStorage first
// - If no session, frontend can request stored-tokens to bootstrap from config
// - This allows CI to pre-populate config with tokens before running tests

// In-memory store for pending OAuth sessions (for cross-browser OAuth transfer)
type PendingSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  user?: any;
  timestamp: number;
};

const pendingSessions = new Map<string, PendingSession>();

/**
 * POST /api/auth/logout
 * Clear auth from all stores (server cache + config file)
 */
router.post('/logout', async (_req: Request, res: Response) => {
  console.log('[Auth Route] Logout requested, clearing all auth stores');
  clearServerJWT();
  setSentryUser(null);
  await clearAuthTokens();
  emitServerAuthChanged({ authenticated: false });
  res.json({ success: true });
});

/**
 * GET /api/auth/session
 * Get the current server-side session status
 */
router.get('/session', (_req: Request, res: Response) => {
  const jwt = getServerJWT();
  res.json({
    authenticated: !!jwt,
    hasToken: !!jwt,
  });
});

/**
 * POST /api/auth/update-jwt
 * Update server JWT cache AND write-through to config file
 * Called by frontend on auth state changes (login, token refresh)
 */
router.post('/update-jwt', async (req: Request, res: Response) => {
  const { access_token, refresh_token, token } = req.body;
  let warning: DiskSpaceFullWarning | undefined;

  // Support both formats
  const accessToken = access_token || token;

  if (!accessToken) {
    res.status(400).json({ error: 'Missing access token' });
    return;
  }

  // Update in-memory cache (for immediate use by server)
  setServerJWT(accessToken);
  setSentryUser(accessToken);

  // Write-through to config file (only in dev/test for CI bootstrapping)
  if (process.env.NODE_ENV !== 'production') {
    try {
      await setAuthTokens(accessToken, refresh_token);
    } catch (error) {
      if (!isDiskSpaceFullError(error)) {
        throw error;
      }
      console.warn('[Auth Route] Disk full while persisting auth tokens:', error);
      warning = DISK_SPACE_FULL_WARNING;
    }
  }

  emitServerAuthChanged({ authenticated: true });
  res.json({ success: true, ...(warning ? { warning } : {}) });
});

/**
 * GET /api/auth/stored-tokens
 * Get tokens from config file (for bootstrapping when no Supabase session)
 * Used by frontend on startup to check if config file has tokens to restore
 */
router.get('/stored-tokens', async (_req: Request, res: Response) => {
  try {
    const tokens = await getAuthTokens();
    res.json(tokens);
  } catch (error) {
    console.error('[Auth Route] Error retrieving stored tokens:', error);
    res.json({ access_token: null, refresh_token: null });
  }
});

/**
 * POST /api/auth/transfer-session
 * Store a session temporarily for cross-browser OAuth transfer
 */
router.post('/transfer-session', async (req: Request, res: Response) => {
  try {
    const { sessionId, access_token, refresh_token, expires_at, expires_in, user } = req.body;

    if (!sessionId || !access_token || !refresh_token) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Store the session data temporarily
    pendingSessions.set(sessionId, {
      access_token,
      refresh_token,
      expires_at,
      expires_in,
      user,
      timestamp: Date.now(),
    });

    console.log('[Auth Route] Session stored for transfer:', sessionId);

    // Clean up old sessions (older than 5 minutes)
    for (const [id, session] of pendingSessions.entries()) {
      if (Date.now() - session.timestamp > 5 * 60 * 1000) {
        pendingSessions.delete(id);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Auth Route] Error storing session:', error);
    res.status(500).json({ error: 'Failed to store session' });
  }
});

/**
 * GET /api/auth/transfer-session
 * Retrieve a session for cross-browser OAuth transfer (one-time use)
 */
router.get('/transfer-session', async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId' });
      return;
    }

    // Clean up expired sessions on every GET request
    for (const [id, session] of pendingSessions.entries()) {
      if (Date.now() - session.timestamp > 5 * 60 * 1000) {
        pendingSessions.delete(id);
      }
    }

    const sessionData = pendingSessions.get(sessionId);

    if (!sessionData) {
      res.json({ authenticated: false });
      return;
    }

    // Delete the session after retrieving it (one-time use)
    pendingSessions.delete(sessionId);

    console.log('[Auth Route] Session retrieved and deleted:', sessionId);

    // Update server cache
    setServerJWT(sessionData.access_token);
    setSentryUser(sessionData.access_token);

    // Write-through to config file (only in dev/test for CI bootstrapping)
    if (process.env.NODE_ENV !== 'production') {
      await setAuthTokens(sessionData.access_token, sessionData.refresh_token);
    }

    res.json({
      authenticated: true,
      session: sessionData,
    });
  } catch (error) {
    console.error('[Auth Route] Error retrieving session:', error);
    res.json({ authenticated: false });
  }
});

export default router;
