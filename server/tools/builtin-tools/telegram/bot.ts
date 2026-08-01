/**
 * Telegram bot manager.
 * Singleton grammY Bot with long-polling and in-memory message cache.
 * Simplified from Open Claw's comprehensive bot.ts.
 */

import { Bot } from 'grammy';
import type { TelegramStoredMessage } from './types';
import { saveCredentials, deleteCredentials } from './credentials';

// Singleton state
let bot: Bot | null = null;
let botUsername: string | undefined;
let botRunning = false;

// In-memory message store (messages received while bot is running)
const messageStore: TelegramStoredMessage[] = [];
const MAX_STORED_MESSAGES = 5000;

export function getBot(): Bot | null {
  return bot;
}

export function getBotUsername(): string | undefined {
  return botUsername;
}

export function isBotRunning(): boolean {
  return botRunning;
}

export function getStoredMessages(): TelegramStoredMessage[] {
  return messageStore;
}

/**
 * Initialize the bot with a token, validate via getMe(), start long-polling.
 * Caches inbound messages in memory.
 */
export async function initializeBot(token: string): Promise<{ botUsername: string }> {
  if (bot) {
    await stopBot();
  }

  const newBot = new Bot(token);

  // Validate token
  const me = await newBot.api.getMe();
  botUsername = me.username;

  // Set up message caching
  newBot.on('message', (ctx) => {
    const msg = ctx.message;
    if (!msg) return;

    const stored: TelegramStoredMessage = {
      id: msg.message_id,
      chatId: msg.chat.id,
      from: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown',
      fromId: msg.from?.id || 0,
      date: msg.date,
      text: msg.text || msg.caption || '[media]',
      isOutgoing: false,
      chatType: msg.chat.type,
      chatTitle: (msg.chat as any).title || (msg.chat as any).first_name || undefined,
    };

    messageStore.push(stored);

    // Trim old messages
    while (messageStore.length > MAX_STORED_MESSAGES) {
      messageStore.shift();
    }
  });

  // Error handling
  newBot.catch((err) => {
    console.error('[Telegram] Bot error:', err.message || err);
  });

  // Start long-polling
  newBot.start({
    onStart: () => {
      console.log('[Telegram] Bot started polling as @' + botUsername);
      botRunning = true;
    },
  });

  bot = newBot;

  // Save credentials
  await saveCredentials({
    botToken: token,
    botUsername: botUsername!,
    connectedAt: new Date().toISOString(),
  });

  return { botUsername: botUsername! };
}

/**
 * Stop the bot and clean up.
 * Does NOT delete credentials so auto-reconnect can work on restart.
 * Use disconnectBot() for explicit user disconnection.
 */
export async function stopBot(): Promise<void> {
  if (bot) {
    try {
      await bot.stop();
    } catch {
      // Ignore stop errors
    }
    bot = null;
  }
  botRunning = false;
  botUsername = undefined;
  messageStore.length = 0;
}

/**
 * Fully disconnect: stop bot, delete credentials, clear state.
 */
export async function disconnectBot(): Promise<void> {
  await stopBot();
  await deleteCredentials();
}

/**
 * Send a message via the bot API.
 */
export async function sendMessage(chatId: string | number, text: string): Promise<{ messageId: number; chatId: number }> {
  if (!bot) {
    throw new Error('Telegram bot not initialized');
  }

  const result = await bot.api.sendMessage(chatId, text);

  // Cache outgoing message
  const stored: TelegramStoredMessage = {
    id: result.message_id,
    chatId: result.chat.id,
    from: botUsername || 'Bot',
    fromId: result.from?.id || 0,
    date: result.date,
    text,
    isOutgoing: true,
    chatType: result.chat.type,
    chatTitle: (result.chat as any).title || (result.chat as any).first_name || undefined,
  };
  messageStore.push(stored);

  return { messageId: result.message_id, chatId: result.chat.id };
}
