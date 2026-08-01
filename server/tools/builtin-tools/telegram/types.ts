/**
 * Telegram types for the workstation integration.
 */

export interface TelegramCredentials {
  botToken: string;
  botUsername: string;
  connectedAt: string;
}

export interface TelegramChat {
  id: string;           // Chat ID
  name: string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  lastMessageTime?: string;
  lastMessage?: string;
  unreadCount: number;
}

export interface TelegramStoredMessage {
  id: number;
  chatId: number;
  from: string;
  fromId: number;
  date: number;
  text: string;
  isOutgoing: boolean;
  chatType: string;
  chatTitle?: string;
}
