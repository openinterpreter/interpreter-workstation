/**
 * Unified Messaging Types
 *
 * Shared types for the multi-channel inbox (Email, WhatsApp, Telegram).
 */

export type MessagingChannel = 'email' | 'whatsapp' | 'telegram';

export interface UnifiedMessage {
  id: string;
  channel: MessagingChannel;
  threadId: string;
  from: string;
  fromId: string;
  date: string;
  snippet: string;
  subject?: string;        // email only
  unread: boolean;
  isGroup?: boolean;
  groupName?: string;
}

export interface UnifiedThread {
  id: string;
  channel: MessagingChannel;
  participants: { id: string; name: string }[];
  messages: UnifiedThreadMessage[];
  subject?: string;
}

export interface UnifiedThreadMessage {
  id: string;
  from: string;
  fromId: string;
  date: string;
  body: string;
  isOutgoing: boolean;
  deliveryStatus?: 'pending' | 'server_ack' | 'delivered' | 'read' | 'played' | 'error' | 'unknown';
  deliveryStatusCode?: number;
  deliveryUpdatedAt?: string;
  attachments?: { id: string; filename: string; mimeType: string; size: number }[];
}

export interface ChannelStatus {
  channel: MessagingChannel;
  configured: boolean;
  label?: string;   // email address, phone number, bot username
}
