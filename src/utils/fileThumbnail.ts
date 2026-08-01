import type { FileThumbnailData } from '../../shared/types/fileThumbnail';

export function getPreviewThumbnailData(
  thumbnailData: FileThumbnailData | null | undefined,
): FileThumbnailData | null {
  if (!thumbnailData || thumbnailData.kind !== 'preview' || !thumbnailData.dataUrl) {
    return null;
  }

  return thumbnailData;
}

export function getPreviewThumbnailUrl(
  thumbnailData: FileThumbnailData | null | undefined,
): string | null {
  return getPreviewThumbnailData(thumbnailData)?.dataUrl ?? null;
}
