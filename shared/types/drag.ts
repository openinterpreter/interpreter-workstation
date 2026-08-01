/**
 * Drag Data Types
 *
 * Type-safe interfaces for drag-and-drop data transfer.
 * Used across FileSystemProxy, AgentTab, BaseTiptapComposer, etc.
 */

/**
 * Drag data for files and directories
 */
export interface FileDragData {
  type: 'file';
  /** Where the drag originated (used to avoid conflicting drop handlers) */
  sourceContext: 'explorer' | 'tabs' | 'unknown';
  filePath: string;
  fileName: string;
  isDirectory: boolean;
}

/**
 * Drag data for browser tabs
 */
export interface BrowserTabDragData {
  type: 'browser-tab';
  url: string;
  fileName: string;  // title
  browserId: string;
  faviconUrl?: string;
}

/**
 * Drag data for email tabs
 */
export interface EmailTabDragData {
  type: 'email-tab';
  emailId: string;
  subject: string;
}

/**
 * Union type for all drag data
 */
export type DragData = FileDragData | BrowserTabDragData | EmailTabDragData;

/**
 * Type guard for file drag data
 */
export function isFileDragData(data: unknown): data is FileDragData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as any).type === 'file' &&
    'sourceContext' in data &&
    ((data as any).sourceContext === 'explorer' ||
      (data as any).sourceContext === 'tabs' ||
      (data as any).sourceContext === 'unknown') &&
    'filePath' in data &&
    typeof (data as any).filePath === 'string'
  );
}

/**
 * Type guard for browser tab drag data
 */
export function isBrowserTabDragData(data: unknown): data is BrowserTabDragData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as any).type === 'browser-tab' &&
    'browserId' in data &&
    typeof (data as any).browserId === 'string'
  );
}

/**
 * Type guard for email tab drag data
 */
export function isEmailTabDragData(data: unknown): data is EmailTabDragData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as any).type === 'email-tab' &&
    'emailId' in data &&
    typeof (data as any).emailId === 'string'
  );
}

/**
 * Safely parse drag data from JSON string
 * Returns null if parsing fails or data doesn't match expected format
 */
export function parseDragData(jsonString: string): DragData | null {
  try {
    const data = JSON.parse(jsonString);
    if (isFileDragData(data)) return data;
    if (isBrowserTabDragData(data)) return data;
    if (isEmailTabDragData(data)) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Create file drag data
 */
export function createFileDragData(
  filePath: string,
  fileName: string,
  isDirectory: boolean,
  sourceContext: FileDragData['sourceContext']
): FileDragData {
  return {
    type: 'file',
    sourceContext,
    filePath,
    fileName,
    isDirectory,
  };
}

/**
 * Create browser tab drag data
 */
export function createBrowserTabDragData(
  browserId: string,
  url: string,
  fileName: string,
  faviconUrl?: string
): BrowserTabDragData {
  return {
    type: 'browser-tab',
    browserId,
    url,
    fileName,
    faviconUrl,
  };
}

/**
 * Create email tab drag data
 */
export function createEmailTabDragData(
  emailId: string,
  subject: string
): EmailTabDragData {
  return {
    type: 'email-tab',
    emailId,
    subject,
  };
}
