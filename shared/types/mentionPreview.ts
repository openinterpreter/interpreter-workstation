export const MENTION_PREVIEW_START_EVENT = 'mention:preview-start';
export const MENTION_PREVIEW_END_EVENT = 'mention:preview-end';
export const MENTION_PREVIEW_DELAY_MS = 500;

export type MentionPreviewType = 'file' | 'directory' | 'browser-tab' | 'skill';

export interface MentionPreviewRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface MentionPreviewDetail {
  type: MentionPreviewType;
  mentionRect: MentionPreviewRect;
  sourceKey?: string;
  id?: string;
  label?: string;
  path?: string;
  url?: string;
  faviconUrl?: string;
  description?: string;
}
