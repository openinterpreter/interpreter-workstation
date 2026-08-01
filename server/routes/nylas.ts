import { Router, Request, Response } from 'express';
import { startNylasOAuth, handleOAuthCallback, disconnectNylas } from '../tools/builtin-tools/nylas/auth';
import { isNylasConfigured, getNylasCredentials } from '../tools/builtin-tools/nylas/credentials';
import { authPage } from '../utils/authPage';

const router = Router();

// Initiate OAuth setup for Nylas
router.post('/setup', async (_req: Request, res: Response) => {
  try {
    const { authUrl, callbackServer, httpServer, verifier, redirectUri } = await startNylasOAuth();

    // Set up callback route on the Express app
    callbackServer.get('/callback', async (callbackReq: any, callbackRes: any) => {
      const code = callbackReq.query.code as string;

      if (!code) {
        callbackRes.status(400).send(authPage('No authorization code received. You can close this window and try again.'));
        httpServer.close();
        return;
      }

      try {
        await handleOAuthCallback(code, verifier, redirectUri);
        callbackRes.send(authPage('Your email has been connected. You can close this window.', true));
      } catch (error: any) {
        callbackRes.status(500).send(authPage(`Failed to complete authorization: ${error.message}. You can close this window and try again.`));
      } finally {
        // Close the HTTP server after handling
        setTimeout(() => httpServer.close(), 1000);
      }
    });

    res.json({ setupUrl: authUrl });
  } catch (error: any) {
    console.error('[Nylas Setup] Error:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
});

// Check if Nylas is configured
router.get('/setup/status', async (_req: Request, res: Response) => {
  try {
    const configured = await isNylasConfigured();

    if (configured) {
      const credentials = await getNylasCredentials();
      res.json({ configured: true, email: credentials?.email });
    } else {
      res.json({ configured: false });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect Nylas (delete credentials)
router.post('/disconnect', async (_req: Request, res: Response) => {
  try {
    await disconnectNylas();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
