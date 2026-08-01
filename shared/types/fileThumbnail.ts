export type FileThumbnailKind = 'preview' | 'icon';

export interface FileThumbnailData {
  dataUrl: string;
  width?: number;
  height?: number;
  kind: FileThumbnailKind;
}
