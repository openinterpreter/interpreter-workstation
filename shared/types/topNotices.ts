export interface TopNoticeItem {
  id: string;
  titleKey: string;
  bodyKey: string;
  promptKey?: string;
  settingsSection?: string;
  requiresBrowserConnection?: boolean;
}

export interface TopNoticeAction {
  labelKey: string;
  url: string;
}

export interface TopNoticeRelease {
  id: string;
  kind: 'release';
  version: string;
  labelKey: string;
  dismissLabelKey: string;
  titleKey: string;
  subtitleKey: string;
  items: TopNoticeItem[];
  footerKey?: string;
  youtubeVideoId?: string;
  action?: TopNoticeAction;
}

export type TopNotice = TopNoticeRelease;
