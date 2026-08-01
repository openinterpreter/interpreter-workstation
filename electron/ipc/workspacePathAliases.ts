const SPECIAL_FOLDER_ALIASES: Record<string, 'desktop' | 'documents' | 'downloads'> = {
  desktop: 'desktop',
  documentos: 'documents',
  documents: 'documents',
  descargas: 'downloads',
  downloads: 'downloads',
  escritorio: 'desktop',
};

export function resolveSpecialFolderAlias(inputPath: string): 'desktop' | 'documents' | 'downloads' | null {
  const normalizedPath = inputPath.trim().toLowerCase();
  return SPECIAL_FOLDER_ALIASES[normalizedPath] ?? null;
}
