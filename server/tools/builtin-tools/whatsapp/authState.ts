import { useLegacyMultiFileAuthState, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { hasAuthState } from './credentials';

// A fresh pairing uses baileyrs's native store. The legacy loader requires
// creds.json and is reserved for existing upstream-Baileys sessions; using it
// for a new user prevents the pairing QR from ever appearing.
export async function loadWhatsAppAuthState(authDir: string) {
  return hasAuthState(authDir)
    ? useLegacyMultiFileAuthState(authDir)
    : useMultiFileAuthState(authDir);
}
