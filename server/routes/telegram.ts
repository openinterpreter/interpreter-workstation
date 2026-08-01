/**
 * Telegram setup routes.
 * Handles bot token validation, connection status, and disconnection.
 */

import { Router } from 'express';
import {
  initializeBot,
  disconnectBot,
  isBotRunning,
  getBotUsername,
} from '../tools/builtin-tools/telegram/bot';
import { loadCredentials, isConfigured } from '../tools/builtin-tools/telegram/credentials';

const router = Router();

/**
 * POST /setup - Accepts bot token, validates, saves credentials, starts polling.
 */
router.post('/setup', async (req, res) => {
  try {
    const { botToken } = req.body;

    if (!botToken || typeof botToken !== 'string') {
      return res.status(400).json({ error: 'botToken is required' });
    }

    const token = botToken.trim();
    if (!token.includes(':')) {
      return res.status(400).json({ error: 'Invalid bot token format. Expected format: 123456:ABC-DEF...' });
    }

    const result = await initializeBot(token);
    res.json({ configured: true, botUsername: result.botUsername });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /setup/status - Returns connection status and bot username.
 */
router.get('/setup/status', async (_req, res) => {
  try {
    if (isBotRunning()) {
      return res.json({
        configured: true,
        botUsername: getBotUsername(),
      });
    }

    // Check saved credentials
    if (isConfigured()) {
      const creds = await loadCredentials();
      if (creds) {
        // Try to reconnect with saved token
        try {
          const result = await initializeBot(creds.botToken);
          return res.json({
            configured: true,
            botUsername: result.botUsername,
          });
        } catch {
          // Token no longer valid
          return res.json({ configured: false });
        }
      }
    }

    res.json({ configured: false });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /disconnect - Stop bot, delete credentials.
 */
router.post('/disconnect', async (_req, res) => {
  try {
    await disconnectBot();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
