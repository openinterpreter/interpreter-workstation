import { pathBasename } from '@/ipc';

export function stripMarkdownFileExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '');
}

/**
 * Normalize how local markdown note references are displayed inline.
 *
 * We only strip `.md` / `.markdown` when the label is the raw basename of the
 * referenced file. Custom aliases stay untouched.
 */
export function getLocalReferenceDisplayLabel(options: {
  label: string;
  path?: string | null;
  itemType?: 'file' | 'directory' | 'browser-tab';
}): string {
  const { label, path, itemType } = options;

  if (itemType !== 'file' || !label || !path) {
    return label;
  }

  const basename = pathBasename(path) || path;
  const basenameWithoutMarkdownExtension = stripMarkdownFileExtension(basename);

  if (basenameWithoutMarkdownExtension === basename) {
    return label;
  }

  return label === basename || label === basenameWithoutMarkdownExtension
    ? basenameWithoutMarkdownExtension
    : label;
}
