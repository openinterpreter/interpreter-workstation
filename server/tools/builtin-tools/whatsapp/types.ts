/**
 * WhatsApp types for the workstation integration.
 * Inspired by Open Claw's type patterns.
 */

export interface WhatsAppCredentials {
  phoneNumber?: string;
  connectedAt?: string;
}

export interface CachedChat {
  id: string;          // JID
  name: string;
  isGroup: boolean;
  lastMessageTime: number;  // Unix ms
  lastMessage: string;
  unreadCount: number;
  lastMessageId?: string;
  lastMessageFromMe?: boolean;
}

export interface CachedMessage {
  id: string;
  chatId: string;
  from: string;         // Display name
  fromId: string;       // JID
  timestamp: number;    // Unix ms
  body: string;
  isOutgoing: boolean;
  isGroup: boolean;
  groupName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  mediaType?: string;   // 'image' | 'video' | 'audio' | 'document' | 'sticker'
  deliveryStatus?: 'pending' | 'server_ack' | 'delivered' | 'read' | 'played' | 'error' | 'unknown';
  deliveryStatusCode?: number;
  deliveryUpdatedAt?: number;
}

export interface CloseReason {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
}

/**
 * Events emitted by the WhatsApp service.
 * These allow external consumers (inbox, agent triggers, future monitors)
 * to hook into the WhatsApp lifecycle without coupling to internals.
 */
export interface WhatsAppServiceEvents {
  /** New QR code for pairing */
  qr: (qr: string) => void;
  /** Successfully connected */
  connected: (data: { phoneNumber?: string }) => void;
  /** Disconnected (may reconnect) */
  disconnected: (reason: CloseReason) => void;
  /** Logged out (credentials cleared) */
  logged_out: () => void;
  /** New message received or sent */
  message: (message: CachedMessage) => void;
  /** Delivery/read/error status update for an existing message */
  message_status: (update: {
    chatId: string;
    messageId: string;
    status: CachedMessage['deliveryStatus'];
    statusCode?: number;
    timestamp: number;
  }) => void;
  /** Chat list updated */
  chat_update: (chat: CachedChat) => void;
}
