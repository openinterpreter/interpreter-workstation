import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import { AudioViewer } from './AudioViewer';
import { PDFViewer } from './PDFViewer';
import { OfficeExtensionViewer } from './OfficeExtensionViewer';
import { MarkdownViewer } from './MarkdownViewer';
import { HtmlViewer } from './HtmlViewer';
import { PlainTextViewer } from './PlainTextViewer';
import { CodeViewer } from './CodeViewer';
import { AutomationViewer } from './automation/AutomationViewer';
import { EDITOR_AREA_ID } from '../../shared/element-ids';
import { OFFICE_EDITOR_EXTENSIONS } from '../../shared/utils/converterFormats';
import { Suspense, lazy, useEffect } from 'react';
import { isUnpackagedElectron, pathBasename } from '../ipc';
import { trackFileOpened } from '../utils/telemetry';

const viteEnv = (import.meta as ImportMeta & {
  env?: {
    DEV?: boolean;
    VITE_ENABLE_DEV_VIDEO_TOOLING?: string;
  };
}).env;

const DEV_VIDEO_TOOLING_BUILD_ENABLED =
  Boolean(viteEnv?.DEV) || viteEnv?.VITE_ENABLE_DEV_VIDEO_TOOLING === '1';

const LazyRemotionViewer = DEV_VIDEO_TOOLING_BUILD_ENABLED
  ? lazy(async () => ({ default: (await import('./RemotionViewer')).RemotionViewer }))
  : null;

const LazyMovieViewer = lazy(async () => ({ default: (await import('./MovieViewer')).MovieViewer }));

interface EditorAreaProps {
  filePath: string;
  refreshKey?: number;
  pdfPage?: number;
}

export function EditorArea({ filePath, refreshKey, pdfPage }: EditorAreaProps) {
  // Determine file type based on extension (whitelist only)
  const extension = pathBasename(filePath).split('.').pop()?.toLowerCase();
  const isDevVideoToolingAvailable = DEV_VIDEO_TOOLING_BUILD_ENABLED && isUnpackagedElectron();
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'heic', 'heif'];
  const videoExtensions = ['mp4', 'webm', 'ogg', 'mov', 'avi'];
  const audioExtensions = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'wma', 'aiff', 'opus'];
  const pdfExtensions = ['pdf'];
  const markdownExtensions = ['md', 'markdown'];
  const htmlExtensions = ['html', 'htm'];
  // Plain text files use TipTap-based editor for real-time selection tracking
  const plainTextExtensions = ['txt'];
  const automationExtensions = ['automation'];
  const movieExtensions = ['movie'];
  const remotionExtensions = ['remotion'];
  // Code files with syntax highlighting
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'json', 'css', 'scss', 'sass',
    'yml', 'yaml', 'xml', 'sh', 'bash', 'py', 'rb', 'java', 'c', 'cpp', 'h', 'hpp',
    'cs', 'go', 'rs', 'php', 'swift', 'kt', 'sql', 'r', 'lua', 'pl', 'tex'
  ];
  // Config/text files without syntax highlighting
  const textExtensions = [
    'vim', 'log', 'gitignore', 'env', 'config', 'conf', 'ini', 'toml', 'lock', 'gradle', 'properties'
  ];

  let type = 'unsupported';
  if (imageExtensions.includes(extension || '')) {
    type = 'image';
  } else if (videoExtensions.includes(extension || '')) {
    type = 'video';
  } else if (audioExtensions.includes(extension || '')) {
    type = 'audio';
  } else if (pdfExtensions.includes(extension || '')) {
    type = 'pdf';
  } else if (markdownExtensions.includes(extension || '')) {
    type = 'markdown';
  } else if (htmlExtensions.includes(extension || '')) {
    type = 'html';
  } else if (plainTextExtensions.includes(extension || '')) {
    type = 'plaintext';
  } else if (OFFICE_EDITOR_EXTENSIONS.has(extension || '')) {
    type = 'office';
  } else if (automationExtensions.includes(extension || '')) {
    type = 'automation';
  } else if (movieExtensions.includes(extension || '')) {
    type = 'movie';
  } else if (remotionExtensions.includes(extension || '')) {
    type = isDevVideoToolingAvailable ? 'remotion' : 'dev-video-unavailable';
  } else if (codeExtensions.includes(extension || '')) {
    type = 'code';
  } else if (textExtensions.includes(extension || '') || !extension) {
    type = 'text';
  }

  useEffect(() => {
    trackFileOpened({ extension: extension || 'none', fileType: type, filePath });
  }, [filePath, extension, type]);

  return (
    <div className="editor-area flex h-full flex-col bg-background" id={EDITOR_AREA_ID} data-testid={EDITOR_AREA_ID} role="main" data-file-path={filePath}>
      {type === 'image' ? (
        <ImageViewer filePath={filePath} />
      ) : type === 'video' ? (
        <VideoViewer filePath={filePath} />
      ) : type === 'audio' ? (
        <AudioViewer filePath={filePath} />
      ) : type === 'pdf' ? (
        <PDFViewer filePath={filePath} initialPage={pdfPage} />
      ) : type === 'markdown' ? (
        <MarkdownViewer filePath={filePath} />
      ) : type === 'html' ? (
        <HtmlViewer filePath={filePath} refreshKey={refreshKey} />
      ) : type === 'plaintext' ? (
        <PlainTextViewer filePath={filePath} />
      ) : type === 'office' ? (
        <OfficeExtensionViewer filePath={filePath} refreshKey={refreshKey} />
      ) : type === 'automation' ? (
        <AutomationViewer filePath={filePath} />
      ) : type === 'movie' ? (
        <Suspense fallback={<div className="flex h-full items-center justify-center text-muted-foreground">Loading movie editor...</div>}>
          <LazyMovieViewer filePath={filePath} refreshKey={refreshKey} />
        </Suspense>
      ) : type === 'remotion' ? (
        LazyRemotionViewer ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-muted-foreground">Loading Remotion Studio...</div>}>
            <LazyRemotionViewer filePath={filePath} refreshKey={refreshKey} />
          </Suspense>
        ) : null
      ) : type === 'dev-video-unavailable' ? (
        <div className="flex flex-col h-full">
          <div className="flex-1 flex items-center justify-center text-muted-foreground px-8">
            <div className="text-center">
              <div className="text-lg mb-2">Development-only file type</div>
              <div className="text-ui-base">.{extension} files are available only in development mode</div>
            </div>
          </div>
        </div>
      ) : type === 'code' ? (
        <CodeViewer filePath={filePath} />
      ) : type === 'unsupported' ? (
        <div className="flex flex-col h-full">
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <div className="text-lg mb-2">File type not supported</div>
              <div className="text-ui-base">.{extension} files cannot be viewed</div>
            </div>
          </div>
        </div>
      ) : (
        <PlainTextViewer filePath={filePath} />
      )}
    </div>
  );
}
