import React from 'react';

const INDENT_WIDTH = 20;
// Base padding before the icon slot (from FileSystemProxy)
const BASE_PADDING = 12;
// Icon slot width (consistent 18px for both chevrons and thumbnails)
const ICON_SLOT_WIDTH = 18;
// Temporary: these explorer guide lines are not centered correctly, so keep them hidden
// until the positioning math is fixed.
const SHOW_INDENT_GUIDES = false;

interface IndentGuidesProps {
  level: number;
}

export const IndentGuides = React.memo(function IndentGuides({
  level,
}: IndentGuidesProps) {
  if (!SHOW_INDENT_GUIDES || level === 0) return null;

  // Each guide should be positioned at the center of the icon slot for that level
  // Icon slot starts at: level * INDENT_WIDTH + BASE_PADDING
  // Icon slot center = level * INDENT_WIDTH + BASE_PADDING + (ICON_SLOT_WIDTH / 2)
  // For level 0: 0 * 20 + 12 + 9 = 21px
  // For level 1: 1 * 20 + 12 + 9 = 41px
  // etc.
  const guides = [];
  for (let i = 0; i < level; i++) {
    const leftPosition = i * INDENT_WIDTH + BASE_PADDING + (ICON_SLOT_WIDTH / 2);
    guides.push(
      <div
        key={i}
        className="absolute top-0 h-full"
        style={{
          left: `${leftPosition}px`,
          width: 'var(--border-width)',
          background: 'var(--border)',
        }}
      />
    );
  }

  return (
    <div className="absolute top-0 left-0 h-full w-full pointer-events-none" data-indent-guides>
      {guides}
    </div>
  );
});

export { INDENT_WIDTH };
