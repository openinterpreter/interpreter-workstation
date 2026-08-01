export interface OfficeExtensionOpenUrlOptions {
  port: number;
  filePath: string;
  language: string | null | undefined;
  theme: 'light' | 'dark';
  bustCache?: boolean;
}

export function buildOfficeExtensionOpenUrl({
  port,
  filePath,
  language,
  theme,
  bustCache = false,
}: OfficeExtensionOpenUrlOptions): string {
  const params = new URLSearchParams({
    filepath: filePath,
    lang: language || 'en',
    theme,
  });

  if (bustCache) {
    params.set('t', Date.now().toString());
  }

  return `http://localhost:${port}/open?${params.toString()}`;
}
