/**
 * WhatsApp setup routes.
 * Handles QR code pairing, connection status, and disconnection.
 */

import { Router, type Request } from 'express';
import QRCode from 'qrcode';
import { DisconnectReason } from '@whiskeysockets/baileys';
import {
  initializeSocket,
  disconnectSocket,
  getConnectionState,
  getPhoneNumber,
  connectionEvents,
  loadCredentials,
  isConfigured,
} from './whatsappSetupDependencies';
import type { CloseReason } from '../tools/builtin-tools/whatsapp/types';
import { bindWhatsAppThread, getHeldWhatsAppReplyCount, getWhatsAppThreadBinding, unbindWhatsAppThread } from '../handlers/whatsappThreadBinding';
import { closeWhatsAppBridgeSession } from '../services/whatsappBridge';

const router = Router();

function localSameOrigin(req: Request): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false;
  // A loopback socket alone does not authenticate the Host header: DNS
  // rebinding can direct a browser to loopback under an attacker's hostname.
  const host = req.get('host');
  if (!host) return false;
  let destination: URL;
  try { destination = new URL(`http://${host}`); }
  catch { return false; }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname) ||
      destination.username || destination.password || destination.pathname !== '/' ||
      destination.search || destination.hash || !destination.port || destination.host !== host.toLowerCase()) return false;
  const actualPort = req.socket.localPort;
  const forwardedDevPort = Number(destination.port) >= 5173 && Number(destination.port) <= 5193;
  const origin = req.get('origin');
  if (!origin) return Number(destination.port) === actualPort; // Local native clients must address this server.
  // Opaque origins are not app identity: packaged Electron uses its trusted
  // main-frame IPC proxy, which makes a loopback request without Origin.
  try {
    const source = new URL(origin);
    return source.protocol === 'http:' && !source.username && !source.password &&
      source.origin === destination.origin && (Number(destination.port) === actualPort || forwardedDevPort);
  }
  catch { return false; }
}

router.get('/thread-binding', async (req, res) => {
  if (!localSameOrigin(req)) return res.status(403).json({ error: 'Local access required.' });
  try {
    const binding = await getWhatsAppThreadBinding();
    const account = getPhoneNumber()?.replace(/\D/g, '') ?? null;
    res.json({ threadId: binding?.threadId ?? null, configured: isConfigured(), connected: getConnectionState() === 'connected',
      accountMatches: !!binding && account === binding.accountId,
      heldReplies: binding ? await getHeldWhatsAppReplyCount(binding.threadId) : 0 });
  } catch { res.status(503).json({ error: 'Channel status unavailable.' }); }
});

router.put('/thread-binding', async (req, res) => {
  if (!localSameOrigin(req)) return res.status(403).json({ error: 'Local access required.' });
  try {
    const binding = await bindWhatsAppThread(req.body?.threadId);
    closeWhatsAppBridgeSession();
    res.json({ threadId: binding.threadId, connected: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not bind this conversation.' });
  }
});

router.delete('/thread-binding', async (req, res) => {
  if (!localSameOrigin(req)) return res.status(403).json({ error: 'Local access required.' });
  try { await unbindWhatsAppThread(req.body?.threadId); res.json({ success: true }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Could not unbind this conversation.' }); }
});

function isRestartRequiredDisconnect(reason: CloseReason): boolean {
  return reason.status === DisconnectReason.restartRequired;
}

function formatDisconnectMessage(reason: CloseReason): string {
  if (reason.isLoggedOut) {
    return 'WhatsApp session logged out. Please connect again.';
  }

  const error = reason.error;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof (error as { message?: unknown })?.message === 'string'
          ? String((error as { message?: unknown }).message)
          : '';

  if (message) {
    return `WhatsApp connection failed: ${message}`;
  }

  if (typeof reason.status === 'number') {
    return `WhatsApp connection failed (status ${reason.status}).`;
  }

  return 'WhatsApp connection failed. Check your network/firewall and try again.';
}

/**
 * POST /setup - Initialize WhatsApp socket and begin QR generation.
 */
router.post('/setup', async (_req, res) => {
  try {
    await initializeSocket();
    res.json({ success: true, message: 'WhatsApp setup initiated. Listen on /setup/qr-stream for QR codes.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /setup/status - Check if WhatsApp is configured and connected.
 */
router.get('/setup/status', async (_req, res) => {
  try {
    const state = getConnectionState();

    if (state === 'connected') {
      const phoneNumber = getPhoneNumber();
      return res.json({ configured: true, phoneNumber });
    }

    // Check if we have saved credentials (may just need reconnection)
    if (isConfigured()) {
      const creds = await loadCredentials();
      return res.json({
        configured: true,
        phoneNumber: creds?.phoneNumber,
        connectionState: state,
      });
    }

    res.json({ configured: false });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /setup/qr-stream - SSE endpoint streaming QR code updates in real time.
 */
router.get('/setup/qr-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onQr = async (qr: string) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      res.write(`event: qr\ndata: ${JSON.stringify({ qrCode: dataUrl })}\n\n`);
    } catch (err) {
      console.error('[WhatsApp] Failed to generate QR data URL:', err);
    }
  };

  const onConnected = (data: { phoneNumber?: string }) => {
    res.write(`event: connected\ndata: ${JSON.stringify({ configured: true, phoneNumber: data.phoneNumber })}\n\n`);
    cleanup();
    res.end();
  };

  const onConnecting = () => {
    res.write('event: connecting\ndata: {}\n\n');
  };

  const onDisconnected = (reason: CloseReason) => {
    if (isRestartRequiredDisconnect(reason)) {
      return;
    }

    res.write(`event: disconnected\ndata: ${JSON.stringify({
      configured: false,
      status: reason.status,
      isLoggedOut: reason.isLoggedOut,
      message: formatDisconnectMessage(reason),
    })}\n\n`);
  };

  const onLoggedOut = () => {
    res.write(`event: logged_out\ndata: ${JSON.stringify({ configured: false })}\n\n`);
    cleanup();
    res.end();
  };

  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

  connectionEvents.on('qr', onQr);
  connectionEvents.on('connecting', onConnecting);
  connectionEvents.on('disconnected', onDisconnected);
  connectionEvents.on('connected', onConnected);
  connectionEvents.on('logged_out', onLoggedOut);

  function cleanup() {
    clearInterval(keepalive);
    connectionEvents.off('qr', onQr);
    connectionEvents.off('connecting', onConnecting);
    connectionEvents.off('disconnected', onDisconnected);
    connectionEvents.off('connected', onConnected);
    connectionEvents.off('logged_out', onLoggedOut);
  }

  req.on('close', cleanup);

  // If already connected, send immediate status
  if (getConnectionState() === 'connected') {
    res.write(`event: connected\ndata: ${JSON.stringify({ configured: true, phoneNumber: getPhoneNumber() })}\n\n`);
  }
});

/**
 * POST /disconnect - Stop socket, delete credentials + auth state.
 */
router.post('/disconnect', async (_req, res) => {
  try {
    await disconnectSocket();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
