/**
 * Workstation Context Types
 *
 * Shared types for capturing the full UI state of the workstation,
 * used for providing context to the LLM agent.
 *
 * Aligned with existing types:
 * - LayoutState (src/utils/layoutHelpers.ts)
 */

/**
 * Represents the source of selected text in the workstation
 */
export type SelectionSource =
  | { type: 'file'; path: string; startLine: number; endLine: number }
  | { type: 'pdf'; path: string; page: number }
  | { type: 'browser'; browserId: string }
  | { type: 'email'; emailId: string }
  | { type: 'unknown' };

/**
 * Represents text selection with its source location
 */
export interface TextSelection {
  type: 'text';
  text: string;
  source: SelectionSource;
}

/**
 * Represents a selected explorer entry
 */
export interface SelectedEntry {
  path: string;
  kind: 'file' | 'folder';
}

/**
 * Represents files/folders selected (shift/cmd-click) in the explorer
 */
export interface FileSelection {
  type: 'files';
  items: SelectedEntry[];
}

export type OfficeSelectionPrimitive = string | number | boolean | null;

export interface OfficeSelectedObject {
  type?: OfficeSelectionPrimitive;
  value?: OfficeSelectionPrimitive;
  id?: OfficeSelectionPrimitive;
  imageUrl?: string;
  imageName?: string;
  hasImage?: boolean;
}

interface OfficeSelectionBase {
  type: 'office';
  filePath: string;
  filename: string;
  doctype: string;
}

export interface OfficeCellSelection extends OfficeSelectionBase {
  kind: 'cell';
  cell?: string;
  range?: string;
  activeCell?: string;
  sheetIndex?: number;
  text?: string;
}

export interface OfficeTextSelection extends OfficeSelectionBase {
  kind: 'text';
  text: string;
  objects?: OfficeSelectedObject[];
}

export interface OfficeObjectSelection extends OfficeSelectionBase {
  kind: 'image' | 'object';
  objects: OfficeSelectedObject[];
}

export type OfficeSelection = OfficeCellSelection | OfficeTextSelection | OfficeObjectSelection;

export type PdfFormFieldValue = string | number | boolean | string[] | null;

export interface PdfFormFieldSelection {
  type: 'pdf';
  kind: 'formField';
  filePath: string;
  fieldName: string;
  fieldType: string;
  page: number;
  value?: PdfFormFieldValue;
  fieldId?: string;
  fieldIndex?: number;
}

/**
 * Discriminated union of all selection types.
 * Any part of the app can produce a Selection; only one is active at a time.
 */
export type Selection = TextSelection | FileSelection | OfficeSelection | PdfFormFieldSelection;

/**
 * File tab information
 */
export interface FileTabContext {
  path: string;
  isActive: boolean;
}

/**
 * Browser tab information
 */
export interface BrowserTabContext {
  browserId: string;
  title: string;
  url: string;
  isActive: boolean;
}

/**
 * Email tab information
 */
export interface EmailTabContext {
  emailId: string;
  subject: string;
  isActive: boolean;
}

/**
 * Collection of all open tabs organized by type
 */
export interface TabsContext {
  files: FileTabContext[];
  browsers: BrowserTabContext[];
  emails: EmailTabContext[];
}

/**
 * Sidebar state for left sidebar
 */
export interface LeftSidebarContext {
  isOpen: boolean;
  activeTab: 'explorer' | 'browser' | 'inbox';
}

/**
 * Sidebar state for the pinned-agent sidebar
 */
export interface RightSidebarContext {
  isOpen: boolean;
}

/**
 * Combined sidebar state
 */
export interface SidebarsContext {
  left: LeftSidebarContext;
  right: RightSidebarContext;
}

/**
 * WorkstationContext - captures all relevant UI state for the LLM agent
 *
 * This type represents a snapshot of the workstation's current state,
 * including the workspace, open tabs, text selection, and sidebar states.
 */
export interface WorkstationContext {
  /** Current workspace directory path, or null if no workspace is open */
  workspace: string | null;

  /** All open tabs organized by type */
  tabs: TabsContext;

  /** Current selection (text, files, etc.), or null if nothing is selected */
  selection: Selection | null;

  /** State of left and right sidebars */
  sidebars: SidebarsContext;
}
