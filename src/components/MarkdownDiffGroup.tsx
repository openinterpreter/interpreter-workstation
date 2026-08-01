import { TipTapViewer } from './TipTapViewer';
import { markdownToTiptap } from '../utils/markdown-parser';
import { Button } from './ui/button';

export interface DiffGroup {
  index: number;
  oldContent: string;
  newContent: string;
  lineNumber: number;
  oldLines: number;
  newLines: number;
}

interface MarkdownDiffGroupProps {
  group: DiffGroup;
  onAccept: (index: number) => void;
  onReject: (index: number) => void;
}

/**
 * Component for displaying a single diff group with accept/reject buttons
 * Shows old content (red) and new content (green) with proper markdown rendering
 */
export function MarkdownDiffGroup({
  group,
  onAccept,
  onReject
}: MarkdownDiffGroupProps) {
  // Calculate metadata text
  const getMetadata = () => {
    if (group.oldContent && group.newContent) {
      const diff = group.newLines - group.oldLines;
      if (diff > 0) {
        return `Modifies ${group.oldLines} ${group.oldLines === 1 ? 'line' : 'lines'}, adds ${diff} ${diff === 1 ? 'line' : 'lines'}`;
      } else if (diff < 0) {
        return `Modifies ${group.newLines} ${group.newLines === 1 ? 'line' : 'lines'}, removes ${Math.abs(diff)} ${Math.abs(diff) === 1 ? 'line' : 'lines'}`;
      } else {
        return `Modifies ${group.oldLines} ${group.oldLines === 1 ? 'line' : 'lines'}`;
      }
    } else if (group.oldContent) {
      return `Removes ${group.oldLines} ${group.oldLines === 1 ? 'line' : 'lines'}`;
    } else {
      return `Adds ${group.newLines} ${group.newLines === 1 ? 'line' : 'lines'}`;
    }
  };

  return (
    <div className="border-y border-border" style={{ borderWidth: 'var(--border-width)' }}>
      {/* Old content - Red background */}
      {group.oldContent && (
        <div className="bg-red-500/10 px-4 py-2 diff-content">
          <TipTapViewer
            content={markdownToTiptap(group.oldContent.trimEnd())}
          />
        </div>
      )}

      {/* New content - Green background */}
      {group.newContent && (
        <div className="bg-green-500/10 px-4 py-2 diff-content">
          <TipTapViewer
            content={markdownToTiptap(group.newContent.trimEnd())}
          />
        </div>
      )}

      {/* Gray action strip */}
      <div className="bg-muted px-4 py-2 flex justify-between items-center border-t border-border" style={{ borderTopWidth: 'var(--border-width)' }}>
        <div className="text-ui-sm text-muted-foreground">
          {getMetadata()}
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => onReject(group.index)}
            variant="outline"
            size="xs"
          >
            Reject
          </Button>
          <Button
            onClick={() => onAccept(group.index)}
            variant="default"
            size="xs"
          >
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
