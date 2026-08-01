// Stored credentials
export interface NylasCredentials {
  grant_id: string;
  access_token: string;
  refresh_token?: string;  // Optional - not provided for online access_type
  expires_at: number;
  email: string;
  provider: 'google' | 'microsoft' | 'yahoo' | 'imap';
  connected_at: string;
}

// Token response from Nylas OAuth
export interface NylasTokenResponse {
  access_token: string;
  refresh_token?: string;  // Optional - only returned with access_type=offline
  grant_id: string;
  email: string;
  provider: string;
  expires_in: number;
}

// Message object from Nylas API
export interface NylasMessage {
  id: string;
  grant_id: string;
  thread_id: string;
  subject: string;
  from: Array<{ email: string; name?: string }>;
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  date: number;
  snippet: string;
  body?: string;
  unread: boolean;
  starred: boolean;
  folders: string[];
  attachments?: NylasAttachment[];
}

// Attachment object from Nylas API
export interface NylasAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  content_id?: string;
}

// List messages response
export interface NylasListMessagesResponse {
  request_id: string;
  data: NylasMessage[];
  next_cursor?: string;
}
