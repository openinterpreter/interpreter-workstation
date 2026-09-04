/**
 * Type-Safe Test Selectors
 *
 * ALL test selectors MUST go through this module.
 * This module ONLY allows selectors registered in shared/element-ids.ts.
 *
 * THE CONTRACT:
 * - Component exports its ID: export const MY_ID = 'my-element' as const;
 * - Component uses it: <div data-testid={MY_ID} />
 * - element-ids.ts imports and organizes all IDs
 * - Tests use sel('key') which only accepts keys from ELEMENT_IDS
 *
 * If a component removes its export → element-ids.ts fails to compile
 * If a test uses invalid key → test fails to compile
 */

import { ELEMENT_IDS, StaticElementId } from '../shared/element-ids';

/**
 * Get selector for a static element ID
 * Usage: sel('agentSidebar') → '[data-testid="agent-sidebar"]'
 */
function selStatic<K extends StaticElementId>(key: K): string {
  return `[data-testid="${ELEMENT_IDS[key]}"]`;
}

/**
 * Main selector function with dynamic methods for parameterized IDs
 *
 * Static IDs: sel('agentSidebar')
 * Dynamic IDs: sel.agentTab('id-123')
 */
export const sel = Object.assign(selStatic, {
  // === DYNAMIC SELECTORS (require parameters) ===
  agentTab: (id: string) => `[data-testid="${ELEMENT_IDS.agentTab(id)}"]`,
  closeAgent: (id: string) => `[data-testid="${ELEMENT_IDS.closeAgent(id)}"]`,
  sidebarTabDropIndicator: (id: string, side: 'top' | 'bottom') =>
    `[data-testid="${ELEMENT_IDS.sidebarTabDropIndicator(id, side)}"]`,
  editorAgentSurface: (id: string) => `[data-testid="${ELEMENT_IDS.editorAgentSurface(id)}"]`,
  agentThread: (id: string) => `[data-testid="${ELEMENT_IDS.agentThread(id)}"]`,
  approvalItem: (id: string) => `[data-testid="${ELEMENT_IDS.approvalItem(id)}"]`,
  message: (id: string) => `[data-testid="${ELEMENT_IDS.message(id)}"]`,
  toolCall: (toolName: string) => `[data-testid="${ELEMENT_IDS.toolCall(toolName)}"]`,

  // === DYNAMIC SELECTORS (return raw selectors from ELEMENT_IDS) ===
  fileEntryByName: (filename: string) => ELEMENT_IDS.fileEntryByName(filename),
  tabByPath: (path: string) => ELEMENT_IDS.tabByPath(path),
  tabBar: (id: string) => `[data-testid="${ELEMENT_IDS.tabBar(id)}"]`,
  paneContent: (id: string) => `[data-testid="${ELEMENT_IDS.paneContent(id)}"]`,
  column: (id: string) => `[data-testid="${ELEMENT_IDS.column(id)}"]`,
  treeItem: () => ELEMENT_IDS.treeItem,
  treeItemByName: (name: string) => ELEMENT_IDS.treeItemByName(name),

  // === PREFIX MATCHERS (match any element of a type) ===
  agentTabAny: () => ELEMENT_IDS.agentTabAnySelector,
  sidebarTabDropIndicatorAny: () => ELEMENT_IDS.sidebarTabDropIndicatorAnySelector,
  editorAgentSurfaceAny: () => ELEMENT_IDS.editorAgentSurfaceAnySelector,
  approvalItemAny: () => ELEMENT_IDS.approvalItemAnySelector,
  paneContentAny: () => ELEMENT_IDS.paneContentAnySelector,
  activeAgentThread: () => ELEMENT_IDS.activeAgentThreadSelector,

  // === CLASS SELECTORS ===
  typingIndicatorDot: () => `.${ELEMENT_IDS.typingIndicatorDotClass}`,
  mentionNodeView: () => ELEMENT_IDS.mentionNodeView,

  // === COMPOUND SELECTORS (combine testid with state attributes) ===
  sectionHeaderExpanded: () => `${selStatic('sectionHeader')}[data-expanded="true"]`,
  sectionHeaderCollapsed: () => `${selStatic('sectionHeader')}[data-expanded="false"]`,
  activeComposer: () => `${ELEMENT_IDS.editorAgentSurfaceAnySelector}:visible ${selStatic('mainComposerInput')}`,
  activeSettings: () => `${ELEMENT_IDS.editorAgentSurfaceAnySelector}:visible ${selStatic('agentSettingsButton')}`,

  // === OFFICE VIEWER STATE ===
  officeViewerState: (state: 'loading' | 'ready' | 'error') =>
    `${selStatic('officeExtensionViewer')}[data-office-viewer-state="${state}"]`,
  officeViewerReady: () => `${selStatic('officeExtensionViewer')}[data-office-viewer-ready="true"]`,
  officeViewerError: () => `${selStatic('officeExtensionViewer')}[data-office-viewer-error="true"]`,
  officeReadOnlyPreviewState: (state: 'loading' | 'ready' | 'error') =>
    `${selStatic('officeReadOnlyPreview')}[data-office-viewer-state="${state}"]`,

  // === CONVERSATION HISTORY ===
  conversationItem: (conversationId: string) => `[data-testid="${ELEMENT_IDS.conversationItem(conversationId)}"]`,

  // === SUBAGENT TOOL UI ===
  subagentToolContainer: (parentToolCallId: string) => `[data-testid="${ELEMENT_IDS.subagentToolContainer(parentToolCallId)}"]`,
  subagentToolItem: (toolCallId: string) => `[data-testid="${ELEMENT_IDS.subagentToolItem(toolCallId)}"]`,
  subagentToolItemAny: () => `[data-testid^="subagent-tool-item-"]`,

  // === SKILLS ===
  suggestionPill: (pillId: string) => `[data-testid="${ELEMENT_IDS.suggestionPill(pillId)}"]`,
  suggestionPillAny: () => ELEMENT_IDS.suggestionPillAnySelector,
  skillButton: (skillId: string) => `[data-testid="${ELEMENT_IDS.skillButton(skillId)}"]`,
  skillButtonAny: () => ELEMENT_IDS.skillButtonAnySelector,

  // === QUESTION UI ===
  questionOption: (questionIdx: number, optionIdx: number) => `[data-testid="${ELEMENT_IDS.questionOption(questionIdx, optionIdx)}"]`,
  questionOtherInput: (questionIdx: number) => `[data-testid="${ELEMENT_IDS.questionOtherInput(questionIdx)}"]`,

  // === CODEX ===
  codexTab: (id: string) => `[data-testid="${ELEMENT_IDS.codexTab(id)}"]`,

  // === MOVIE ===
  movieClip: (clipId: string) => `[data-testid="${ELEMENT_IDS.movieClip(clipId)}"]`,
  movieTrack: (trackId: string) => `[data-testid="${ELEMENT_IDS.movieTrack(trackId)}"]`,
  movieSourcePreviewExpandButton: (inputId: string) => `[data-testid="${ELEMENT_IDS.movieSourcePreviewExpandButton(inputId)}"]`,
  movieSourcePreviewExpandButtonAny: () => ELEMENT_IDS.movieSourcePreviewExpandButtonAnySelector,

  // === PROVIDERS ===
  providerItem: (providerId: string) => `[data-testid="${ELEMENT_IDS.providerItem(providerId)}"]`,
  settingsTab: (tabId: string) => `[data-testid="${ELEMENT_IDS.settingsTab(tabId)}"]`,
  profileCard: (profileId: string) => `[data-testid="${ELEMENT_IDS.profileCard(profileId)}"]`,
  profileProviderTab: (providerType: string) => `[data-testid="${ELEMENT_IDS.profileProviderTab(providerType)}"]`,
  hostedModelPickerGroup: (groupId: string) => `${selStatic('hostedModelPickerGroupHeading')}[data-group-id="${groupId}"]`,
  hostedModelPickerOption: (modelId: string) => `${selStatic('hostedModelPickerOptionItem')}[data-model-id="${modelId}"]`,
});

/**
 * Get just the ID value (for page.getByTestId)
 */
export function testId<K extends StaticElementId>(key: K): string {
  return ELEMENT_IDS[key] as string;
}
