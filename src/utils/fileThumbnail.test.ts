import { describe, expect, test } from 'bun:test';

import { getPreviewThumbnailData, getPreviewThumbnailUrl } from './fileThumbnail';

describe('fileThumbnail helpers', () => {
  test('keeps preview thumbnails', () => {
    const thumbnail = {
      dataUrl: 'data:image/png;base64,preview',
      width: 64,
      height: 64,
      kind: 'preview' as const,
    };

    expect(getPreviewThumbnailData(thumbnail)).toEqual(thumbnail);
    expect(getPreviewThumbnailUrl(thumbnail)).toBe(thumbnail.dataUrl);
  });

  test('drops icon-backed thumbnail fallbacks', () => {
    const thumbnail = {
      dataUrl: 'data:image/png;base64,icon',
      width: 32,
      height: 32,
      kind: 'icon' as const,
    };

    expect(getPreviewThumbnailData(thumbnail)).toBeNull();
    expect(getPreviewThumbnailUrl(thumbnail)).toBeNull();
  });

  test('handles missing thumbnails', () => {
    expect(getPreviewThumbnailData(undefined)).toBeNull();
    expect(getPreviewThumbnailUrl(null)).toBeNull();
  });
});
