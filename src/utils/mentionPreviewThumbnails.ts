import { getFileThumbnails } from '@/ipc';
import { getPreviewThumbnailUrl } from './fileThumbnail';

export const FILE_MENTION_PREVIEW_WIDTH = 240;
export const FILE_MENTION_PREVIEW_HEIGHT = 148;
export const FILE_MENTION_PREVIEW_THUMBNAIL_SIZE = 512;

const mentionPreviewThumbnailCache = new Map<string, string>();

export async function fetchMentionPreviewThumbnails(paths: string[]): Promise<Record<string, string | null>> {
  const uniquePaths = [...new Set(paths.filter((path) => typeof path === 'string' && path.length > 0))];
  const result: Record<string, string | null> = {};
  const missingPaths: string[] = [];

  for (const path of uniquePaths) {
    const cached = mentionPreviewThumbnailCache.get(path);
    if (cached) {
      result[path] = cached;
      continue;
    }
    missingPaths.push(path);
  }

  if (missingPaths.length === 0) {
    return result;
  }

  const { thumbnails } = await getFileThumbnails(missingPaths, FILE_MENTION_PREVIEW_THUMBNAIL_SIZE);

  for (const path of missingPaths) {
    const thumbnailData = thumbnails[path];
    const thumbnailUrl = getPreviewThumbnailUrl(thumbnailData);

    if (thumbnailUrl) {
      mentionPreviewThumbnailCache.set(path, thumbnailUrl);
    }

    result[path] = thumbnailUrl;
  }

  return result;
}
