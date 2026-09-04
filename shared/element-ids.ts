/**
 * Element IDs - Central Registry
 *
 * All data-testid values are defined HERE. Components and tests import FROM this file.
 * This is a pure strings file - NO imports from React components or browser code.
 *
 * THE CONTRACT:
 * - This file defines: export const MY_ID = 'my-element' as const;
 * - Components import: import { MY_ID } from 'shared/element-ids';
 * - Components use: <div data-testid={MY_ID} />
 * - Tests use: sel('myKey') which maps to ELEMENT_IDS.myKey
 *
 * TypeScript enforcement:
 * - Remove an ID here → components that import it fail to compile
 * - Use wrong key in test → sel('badKey') fails to compile
 * - Use raw string in component → lint fails
 * - ID defined but never used in component → lint fails (check 4)
 */

// =============================================================================
// AGENT SIDEBAR
// =============================================================================
export const AGENT_SIDEBAR_ID = 'agent-sidebar' as const;
export const NEW_AGENT_BUTTON_ID = 'new-agent-button' as const;
export const CREATE_SIDEBAR_AGENT_BUTTON_ID = 'create-sidebar-agent-button' as const;

// =============================================================================
// AGENT TAB
// =============================================================================
export const AGENT_TAB_PREFIX = 'agent-tab-' as const;
export const AGENT_TAB_ID = (agentId: string) => `agent-tab-${agentId}` as const;
export const AGENT_TAB_ANY_SELECTOR = `[data-testid^="${AGENT_TAB_PREFIX}"]` as const;
export const CLOSE_AGENT_ID = (agentId: string) => `close-agent-${agentId}` as const;
export const SIDEBAR_TAB_DROP_INDICATOR_PREFIX = 'sidebar-tab-drop-indicator-' as const;
export const SIDEBAR_TAB_DROP_INDICATOR_ID = (tabId: string, side: 'top' | 'bottom') =>
  `sidebar-tab-drop-indicator-${tabId}-${side}` as const;
export const SIDEBAR_TAB_DROP_INDICATOR_ANY_SELECTOR = `[data-testid^="${SIDEBAR_TAB_DROP_INDICATOR_PREFIX}"]` as const;

// =============================================================================
// AGENT SETTINGS
// =============================================================================
export const AGENT_SETTINGS_BUTTON_ID = 'agent-settings-button' as const;
export const SETTINGS_POPOVER_ID = 'settings-popover' as const;
export const SETTINGS_POPOVER_CLOSE_BUTTON_ID = 'settings-popover-close-button' as const;

function escapeCssAttributeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

// =============================================================================
// FEEDBACK
// =============================================================================
export const FEEDBACK_BUTTON_ID = 'feedback-button' as const;
export const FEEDBACK_POPOVER_ID = 'feedback-popover' as const;

// =============================================================================
// AUTH
// =============================================================================
export const AUTH_SIGN_IN_ID = 'auth-sign-in' as const;
export const ONBOARDING_CONTINUE_BUTTON_ID = 'onboarding-continue-button' as const;

// =============================================================================
// AGENT THREAD
// =============================================================================
export const EDITOR_AGENT_SURFACE_PREFIX = 'editor-agent-surface-' as const;
export const EDITOR_AGENT_SURFACE_ID = (agentId: string) => `editor-agent-surface-${agentId}` as const;
export const EDITOR_AGENT_SURFACE_ANY_SELECTOR = `[data-testid^="${EDITOR_AGENT_SURFACE_PREFIX}"]` as const;
export const PERSISTENT_LAYER_ID = 'persistent-layer' as const;
export const AGENT_THREAD_PREFIX = 'agent-thread-' as const;
export const AGENT_THREAD_ID = (threadId: string) => `agent-thread-${threadId}` as const;
export const ACTIVE_AGENT_THREAD_ID = (threadId: string) => `[data-testid="${AGENT_THREAD_ID(threadId)}"][data-active="true"]` as const;
export const ACTIVE_AGENT_THREAD_SELECTOR = `[data-testid^="${AGENT_THREAD_PREFIX}"][data-active="true"]` as const;

// =============================================================================
// COMPOSER
// =============================================================================
export const MAIN_COMPOSER_INPUT_ID = 'main-composer-input' as const;
export const MAIN_COMPOSER_SEND_BUTTON_ID = 'main-composer-send-button' as const;
export const MAIN_COMPOSER_VOICE_BUTTON_ID = 'main-composer-voice-button' as const;
export const VOICE_OVERLAY_TEXT_ID = 'voice-overlay-text' as const;
export const SEND_BUTTON_ICON_ID = 'send-button-icon' as const;
export const MENTION_POPUP_ID = 'mention-popup' as const;
export const MENTION_NODE_VIEW_CLASS = 'mention-node-view' as const;

// =============================================================================
// QUEUED MESSAGES
// =============================================================================
export const QUEUED_MESSAGES_CONTAINER_ID = 'queued-messages-container' as const;
export const QUEUED_MESSAGES_CLEAR_ALL_ID = 'queued-messages-clear-all' as const;

// =============================================================================
// THREAD MESSAGES
// =============================================================================
export const TYPING_INDICATOR_ID = 'typing-indicator' as const;
export const TYPING_INDICATOR_DOT_CLASS = 'ellipsis-dot-1' as const;
export const ERROR_MESSAGE_ID = 'error-message' as const;
export const MESSAGE_ID = (messageId: string) => `${messageId}` as const;
export const USER_MESSAGE_CONTENT_ID = 'user-message-content' as const;

// =============================================================================
// TOOL CALLS
// =============================================================================
export const TOOL_CALL_ID = (toolName: string) => `tool-call-${toolName}` as const;

// =============================================================================
// DIFF ACTIONS (Keep All / Undo All)
// =============================================================================
export const KEEP_ALL_BUTTON_ID = 'keep-all-button' as const;
export const UNDO_ALL_BUTTON_ID = 'undo-all-button' as const;

// =============================================================================
// LAYOUT
// =============================================================================
export const CUSTOM_TITLEBAR_ID = 'custom-titlebar' as const;
export const EDITOR_LAYOUT_ID = 'editor-layout' as const;
export const TOP_BAR_ID = 'top-bar' as const;
export const EDITOR_AREA_ID = 'editor-area' as const;

// =============================================================================
// TABS
// =============================================================================
export const TAB_ID = (id: string) => `tab-${id}` as const;
export const TAB_BAR_ID = (id: string) => `tab-bar-${id}` as const;
export const PANE_CONTENT_ANY_SELECTOR = '[data-testid^="pane-content-"]' as const;
export const PANE_CONTENT_ID = (id: string) => `pane-content-${id}` as const;
export const NEW_TAB_BUTTON_ID = (id: string) => `new-tab-button-${id}` as const;
export const REFRESH_TAB_BUTTON_ID = (id: string) => `refresh-tab-button-${id}` as const;
export const COLUMN_ID = (id: string) => `column-${id}` as const;

// =============================================================================
// EMPTY AGENT STATE
// =============================================================================
export const AGENT_EMPTY_STATE_PAGE_ID = 'agent-empty-state-page' as const;
export const NEW_TAB_PAGE_ID = 'new-tab-page' as const;
export const SUGGESTION_PILL_PREFIX = 'suggestion-pill-' as const;
export const SUGGESTION_PILL_ID = (pillId: string) => `suggestion-pill-${pillId}` as const;
export const SUGGESTION_PILL_ANY_SELECTOR = `[data-testid^="${SUGGESTION_PILL_PREFIX}"]` as const;
export const SKILL_BUTTON_ID = (skillId: string) => `skill-button-${skillId}` as const;
export const SKILL_BUTTON_ANY_SELECTOR = '[data-testid^="skill-button-"]' as const;
export const INTERVIEW_INVITE_BANNER_ID = 'interview-invite-banner' as const;
export const INTERVIEW_INVITE_SCHEDULE_BUTTON_ID = 'interview-invite-schedule-button' as const;
export const INTERVIEW_INVITE_DISMISS_BUTTON_ID = 'interview-invite-dismiss-button' as const;
export const TOP_NOTICE_ID = (noticeId: string) => `top-notice-${noticeId}` as const;
export const TOP_NOTICE_DISMISS_BUTTON_ID = (noticeId: string) => `top-notice-dismiss-${noticeId}` as const;

// =============================================================================
// SIDEBAR BUTTONS
// =============================================================================
export const EXPLORER_BUTTON_ID = 'explorer-button' as const;
export const BROWSER_BUTTON_ID = 'browser-button' as const;
export const CHAT_BUTTON_ID = 'chat-button' as const;
export const NOTIFICATIONS_BUTTON_ID = 'notifications-button' as const;
export const SETTINGS_BUTTON_ID = 'settings-button' as const;
export const APPROVALS_BUTTON_ID = 'approvals-button' as const;

// =============================================================================
// EXPLORER
// =============================================================================
export const EXPLORER_ID = 'explorer' as const;
export const EXPLORER_SIDEBAR_ID = 'explorer-sidebar' as const;
export const FILE_TREE_ID = 'file-tree' as const;
export const FILE_ENTRY_BY_NAME = (filename: string) => `[role="treeitem"][data-name="${filename}"]` as const;
export const EXPLORER_SEARCH_INPUT_ID = 'explorer-search-input' as const;
export const EXPLORER_RENAME_INPUT_ID = 'explorer-rename-input' as const;
export const WORKSPACE_PICKER_BUTTON_ID = 'workspace-picker-button' as const;
export const SEARCH_COMPUTER_BUTTON_ID = 'search-computer-button' as const;
export const RUN_AGENT_SEARCH_BUTTON_ID = 'run-agent-search-button' as const;
export const TREE_ITEM_SELECTOR = '[role="treeitem"]' as const;
export const TREE_ITEM_BY_NAME = (name: string) => `[role="treeitem"][data-name="${name}"]` as const;

// =============================================================================
// APPROVALS
// =============================================================================
export const APPROVALS_LIST_ID = 'approvals-list' as const;
export const APPROVAL_ITEM_ID = (id: string) => `approval-item-${id}` as const;
export const APPROVAL_ITEM_ANY_SELECTOR = '[data-testid^="approval-item-"]' as const;
export const APPROVAL_BADGE_ID = 'approval-badge' as const;
export const APPROVE_BUTTON_ID = 'approve-button' as const;
export const DENY_BUTTON_ID = 'deny-button' as const;

// =============================================================================
// QUESTION UI (ask_user_question tool)
// =============================================================================
export const QUESTION_SUBMIT_BUTTON_ID = 'question-submit-button' as const;
export const QUESTION_SKIP_BUTTON_ID = 'question-skip-button' as const;
export const QUESTION_OPTION_ID = (questionIdx: number, optionIdx: number) =>
  `question-option-${questionIdx}-${optionIdx}` as const;
export const QUESTION_OTHER_INPUT_ID = (questionIdx: number) =>
  `question-other-input-${questionIdx}` as const;

// =============================================================================
// VIEWERS
// =============================================================================
export const PDF_VIEWER_ID = 'pdf-viewer' as const;
export const PDF_ADD_ANNOTATION_BUTTON_ID = 'pdf-add-annotation-button' as const;
export const PDF_SAVE_BUTTON_ID = 'pdf-save-button' as const;
export const PDF_ANNOTATION_TOOLBAR_ID = 'pdf-annotation-toolbar' as const;
export const PDF_MULTI_SELECT_TOOLBAR_ID = 'pdf-multi-select-toolbar' as const;
export const IMAGE_VIEWER_ID = 'image-viewer' as const;
export const VIDEO_VIEWER_ID = 'video-viewer' as const;
export const HTML_VIEWER_ID = 'html-viewer' as const;
export const OFFICE_EXTENSION_VIEWER_ID = 'office-extension-viewer' as const;
export const OFFICE_READ_ONLY_PREVIEW_ID = 'office-read-only-preview' as const;
export const REMOTION_VIEWER_ID = 'remotion-viewer' as const;
export const MOVIE_VIEWER_ID = 'movie-viewer' as const;
export const MOVIE_PREVIEW_PLAYER_ID = 'movie-preview-player' as const;
export const MOVIE_TIMELINE_ID = 'movie-timeline' as const;
export const MOVIE_ASSET_LIBRARY_ID = 'movie-asset-library' as const;
export const MOVIE_EXPORT_BUTTON_ID = 'movie-export-button' as const;
export const MOVIE_RECORD_AT_PLAYHEAD_BUTTON_ID = 'movie-record-at-playhead-button' as const;
export const MOVIE_IMPORT_MEDIA_BUTTON_ID = 'movie-import-media-button' as const;
export const MOVIE_REFERENCE_MEDIA_BUTTON_ID = 'movie-reference-media-button' as const;
export const MOVIE_PLAY_BUTTON_ID = 'movie-play-button' as const;
export const MOVIE_UNLINK_AUDIO_BUTTON_ID = 'movie-unlink-audio-button' as const;
export const MOVIE_SOURCE_PREVIEW_MODAL_ID = 'movie-source-preview-modal' as const;
export const MOVIE_SOURCE_PREVIEW_DELAY_SLIDER_ID = 'movie-source-preview-delay-slider' as const;
export const MOVIE_SOURCE_PREVIEW_CLOSE_BUTTON_ID = 'movie-source-preview-close-button' as const;
export const MOVIE_SOURCE_PREVIEW_EXPAND_BUTTON_PREFIX = 'movie-source-preview-expand-button-' as const;
export const MOVIE_SOURCE_PREVIEW_EXPAND_BUTTON_ID = (inputId: string) => `movie-source-preview-expand-button-${inputId}` as const;
export const MOVIE_SOURCE_PREVIEW_EXPAND_BUTTON_ANY_SELECTOR = `[data-testid^="${MOVIE_SOURCE_PREVIEW_EXPAND_BUTTON_PREFIX}"]` as const;
export const MOVIE_CLIP_ID = (clipId: string) => `movie-clip-${clipId}` as const;
export const MOVIE_TRACK_ID = (trackId: string) => `movie-track-${trackId}` as const;
export const EDITOR_CONTENT_ID = 'editor-content' as const;
export const MARKDOWN_FRONTMATTER_CARD_ID = 'markdown-frontmatter-card' as const;
export const BROWSER_VIEW_CONTAINER_ID = 'browser-view-container' as const;

// =============================================================================
// FILE SYSTEM
// =============================================================================
export const FILE_SYSTEM_PROXY_TYPE_FILE = 'file' as const;
export const FILE_SYSTEM_PROXY_TYPE_DIRECTORY = 'directory' as const;

// =============================================================================
// SETTINGS
// =============================================================================
export const SETTINGS_PANEL_ID = 'settings-panel' as const;
export const ADD_MCP_SERVER_BUTTON_ID = 'add-mcp-server-button' as const;
export const GLOBAL_SETTINGS_VIEW_ID = 'global-settings-view' as const;
export const SETTINGS_HEADING_ID = 'settings-heading' as const;
export const TOOLS_SECTION_ID = 'tools-section' as const;
export const TOOL_TOGGLE_SWITCH_ID = 'tool-toggle-switch' as const;
export const KEYBOARD_SHORTCUTS_SECTION_ID = 'keyboard-shortcuts-section' as const;

// =============================================================================
// PROVIDERS SECTION
// =============================================================================
export const PROVIDERS_SECTION_ID = 'providers-section' as const;
export const PROVIDER_ITEM_ID = (providerId: string) => `provider-item-${providerId}` as const;
export const ADD_PROVIDER_BUTTON_ID = 'add-provider-button' as const;
export const SETTINGS_ERROR_CONTAINER_ID = 'settings-error-container' as const;

// =============================================================================
// PROFILE MANAGER
// =============================================================================
function toTestIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

export const PERMISSION_SELECT_SYSTEM_ID = 'permission-select-system' as const;
export const PERMISSION_SELECT_WORKSPACE_ID = 'permission-select-workspace' as const;
export const PERMISSION_SELECT_CUSTOM_ID = (path: string) => `permission-select-custom-${path.replace(/\//g, '-')}` as const;
export const SETTINGS_TAB_ID = (tabId: string) => `settings-tab-${toTestIdSegment(tabId)}` as const;
export const PROFILE_CARD_ID = (profileId: string) => `profile-card-${toTestIdSegment(profileId)}` as const;
export const PROFILE_PROVIDER_TAB_ID = (providerType: string) => `profile-provider-tab-${toTestIdSegment(providerType)}` as const;
export const HOSTED_MODEL_PICKER_TRIGGER_ID = 'hosted-model-picker-trigger' as const;
export const HOSTED_MODEL_PICKER_POPOVER_ID = 'hosted-model-picker-popover' as const;
export const HOSTED_MODEL_PICKER_SEARCH_INPUT_ID = 'hosted-model-picker-search-input' as const;
export const HOSTED_MODEL_PICKER_REFRESH_BUTTON_ID = 'hosted-model-picker-refresh-button' as const;
export const HOSTED_MODEL_PICKER_EMPTY_STATE_ID = 'hosted-model-picker-empty-state' as const;
export const HOSTED_MODEL_PICKER_GROUP_HEADING_ID = 'hosted-model-picker-group-heading' as const;
export const HOSTED_MODEL_PICKER_OPTION_ITEM_ID = 'hosted-model-picker-option-item' as const;
export const API_BASE_URL_PICKER_TRIGGER_ID = 'api-base-url-picker-trigger' as const;
export const API_BASE_URL_PICKER_POPOVER_ID = 'api-base-url-picker-popover' as const;
export const API_BASE_URL_PICKER_INPUT_ID = 'api-base-url-picker-input' as const;
export const API_BASE_URL_PICKER_OPTION_ITEM_ID = 'api-base-url-picker-option-item' as const;
export const API_BASE_URL_PICKER_EDIT_INPUT_ID = 'api-base-url-picker-edit-input' as const;
export const PROFILE_CUSTOM_MODEL_INPUT_ID = 'profile-custom-model-input' as const;
export const PROFILE_MODEL_SELECT_ID = 'profile-model-select' as const;

// =============================================================================
// UI COMPONENTS
// =============================================================================
export const SECTION_HEADER_ID = 'section-header' as const;
export const SECTION_EXPANDED_ID = 'section-expanded' as const;
export const SECTION_COLLAPSED_ID = 'section-collapsed' as const;
export const CHEVRON_DOWN_ID = 'chevron-down' as const;
export const CHEVRON_RIGHT_ID = 'chevron-right' as const;
export const TOOL_SERVER_CARD_ID = 'tool-server-card' as const;

// =============================================================================
// ECHO SECRET (Tool UI)
// =============================================================================
export const ECHO_SECRET_INPUT_ID = 'echo-secret-input' as const;
export const ECHO_SECRET_TEST_BUTTON_ID = 'echo-secret-test-button' as const;
export const ECHO_SECRET_SAVE_BUTTON_ID = 'echo-secret-save-button' as const;
export const ECHO_SECRET_LAST_RESULT_ID = 'echo-secret-last-result' as const;

// =============================================================================
// CONVERSATION HISTORY
// =============================================================================
export const RIGHT_PANEL_HISTORY_TAB_ID = 'right-panel-history-tab' as const;
export const CONVERSATION_HISTORY_LIST_ID = 'conversation-history-list' as const;
export const CONVERSATION_ITEM_PREFIX = 'conversation-' as const;
export const CONVERSATION_ITEM_ID = (conversationId: string) => `conversation-${conversationId}` as const;

// =============================================================================
// SUBAGENT TOOL UI
// =============================================================================
export const SUBAGENT_TOOL_CONTAINER_ID = (parentToolCallId: string) =>
  `subagent-tool-container-${parentToolCallId}` as const;
export const SUBAGENT_TOOL_ITEM_ID = (toolCallId: string) =>
  `subagent-tool-item-${toolCallId}` as const;

// =============================================================================
// TERMINAL
// =============================================================================
export const TERMINAL_TAB_PREFIX = 'terminal-tab-' as const;
export const TERMINAL_TAB_ID = (tabId: string) => `terminal-tab-${tabId}` as const;
export const TERMINAL_VIEW_ID = 'terminal-view' as const;

// =============================================================================
// CODEX
// =============================================================================
export const CODEX_TAB_PREFIX = 'codex-tab-' as const;
export const CODEX_TAB_ID = (tabId: string) => `codex-tab-${tabId}` as const;

// =============================================================================
// CENTRAL REGISTRY (for tests)
// =============================================================================

export const ELEMENT_IDS = {
  // === AGENT SIDEBAR ===
  agentSidebar: AGENT_SIDEBAR_ID,
  newAgentButton: NEW_AGENT_BUTTON_ID,
  createSidebarAgentButton: CREATE_SIDEBAR_AGENT_BUTTON_ID,
  agentTab: AGENT_TAB_ID,
  agentTabAnySelector: AGENT_TAB_ANY_SELECTOR,
  closeAgent: CLOSE_AGENT_ID,
  sidebarTabDropIndicator: SIDEBAR_TAB_DROP_INDICATOR_ID,
  sidebarTabDropIndicatorAnySelector: SIDEBAR_TAB_DROP_INDICATOR_ANY_SELECTOR,
  agentSettingsButton: AGENT_SETTINGS_BUTTON_ID,

  // === AGENT THREAD ===
  editorAgentSurface: EDITOR_AGENT_SURFACE_ID,
  editorAgentSurfaceAnySelector: EDITOR_AGENT_SURFACE_ANY_SELECTOR,
  persistentLayer: PERSISTENT_LAYER_ID,
  agentThread: AGENT_THREAD_ID,
  activeAgentThread: ACTIVE_AGENT_THREAD_ID,
  activeAgentThreadSelector: ACTIVE_AGENT_THREAD_SELECTOR,
  typingIndicator: TYPING_INDICATOR_ID,
  typingIndicatorDotClass: TYPING_INDICATOR_DOT_CLASS,
  errorMessage: ERROR_MESSAGE_ID,
  message: MESSAGE_ID,
  toolCall: TOOL_CALL_ID,

  // === DIFF ACTIONS ===
  keepAllButton: KEEP_ALL_BUTTON_ID,
  undoAllButton: UNDO_ALL_BUTTON_ID,

  // === COMPOSER ===
  mainComposerInput: MAIN_COMPOSER_INPUT_ID,
  mainComposerSendButton: MAIN_COMPOSER_SEND_BUTTON_ID,
  mainComposerVoiceButton: MAIN_COMPOSER_VOICE_BUTTON_ID,
  voiceOverlayText: VOICE_OVERLAY_TEXT_ID,
  sendButtonIcon: SEND_BUTTON_ICON_ID,
  mentionPopup: MENTION_POPUP_ID,
  mentionNodeView: `.${MENTION_NODE_VIEW_CLASS}`,
  queuedMessagesContainer: QUEUED_MESSAGES_CONTAINER_ID,
  queuedMessagesClearAll: QUEUED_MESSAGES_CLEAR_ALL_ID,
  userMessageContent: USER_MESSAGE_CONTENT_ID,

  // === LAYOUT ===
  customTitlebar: CUSTOM_TITLEBAR_ID,
  editorLayout: EDITOR_LAYOUT_ID,
  topBar: TOP_BAR_ID,
  editorArea: EDITOR_AREA_ID,

  // === TABS ===
  tabByPath: (path: string) => `[data-tab-path="${escapeCssAttributeValue(path)}"]`,

  // === EMPTY AGENT STATE ===
  agentEmptyStatePage: AGENT_EMPTY_STATE_PAGE_ID,
  newTabPage: NEW_TAB_PAGE_ID,
  suggestionPill: SUGGESTION_PILL_ID,
  suggestionPillAnySelector: SUGGESTION_PILL_ANY_SELECTOR,
  skillButton: SKILL_BUTTON_ID,
  skillButtonAnySelector: SKILL_BUTTON_ANY_SELECTOR,
  interviewInviteBanner: INTERVIEW_INVITE_BANNER_ID,
  interviewInviteScheduleButton: INTERVIEW_INVITE_SCHEDULE_BUTTON_ID,
  interviewInviteDismissButton: INTERVIEW_INVITE_DISMISS_BUTTON_ID,
  topNotice: TOP_NOTICE_ID,
  topNoticeDismissButton: TOP_NOTICE_DISMISS_BUTTON_ID,

  // === SIDEBAR BUTTONS ===
  explorerButton: EXPLORER_BUTTON_ID,
  browserButton: BROWSER_BUTTON_ID,
  chatButton: CHAT_BUTTON_ID,
  notificationsButton: NOTIFICATIONS_BUTTON_ID,
  settingsButton: SETTINGS_BUTTON_ID,
  approvalsButton: APPROVALS_BUTTON_ID,

  // === EXPLORER ===
  explorer: EXPLORER_ID,
  explorerSidebar: EXPLORER_SIDEBAR_ID,
  fileTree: FILE_TREE_ID,
  fileEntryByName: FILE_ENTRY_BY_NAME,
  explorerSearchInput: EXPLORER_SEARCH_INPUT_ID,
  explorerRenameInput: EXPLORER_RENAME_INPUT_ID,
  workspacePickerButton: WORKSPACE_PICKER_BUTTON_ID,
  searchComputerButton: SEARCH_COMPUTER_BUTTON_ID,
  runAgentSearchButton: RUN_AGENT_SEARCH_BUTTON_ID,
  treeItem: TREE_ITEM_SELECTOR,
  treeItemByName: TREE_ITEM_BY_NAME,

  // === APPROVALS ===
  approvalsList: APPROVALS_LIST_ID,
  approvalItem: APPROVAL_ITEM_ID,
  approvalItemAnySelector: APPROVAL_ITEM_ANY_SELECTOR,
  approvalBadge: APPROVAL_BADGE_ID,
  approveButton: APPROVE_BUTTON_ID,
  denyButton: DENY_BUTTON_ID,

  // === QUESTION UI ===
  questionSubmitButton: QUESTION_SUBMIT_BUTTON_ID,
  questionSkipButton: QUESTION_SKIP_BUTTON_ID,
  questionOption: QUESTION_OPTION_ID,
  questionOtherInput: QUESTION_OTHER_INPUT_ID,

  // === VIEWERS ===
  pdfViewer: PDF_VIEWER_ID,
  pdfAddAnnotationButton: PDF_ADD_ANNOTATION_BUTTON_ID,
  pdfSaveButton: PDF_SAVE_BUTTON_ID,
  pdfAnnotationToolbar: PDF_ANNOTATION_TOOLBAR_ID,
  pdfMultiSelectToolbar: PDF_MULTI_SELECT_TOOLBAR_ID,
  imageViewer: IMAGE_VIEWER_ID,
  videoViewer: VIDEO_VIEWER_ID,
  htmlViewer: HTML_VIEWER_ID,
  officeExtensionViewer: OFFICE_EXTENSION_VIEWER_ID,
  officeReadOnlyPreview: OFFICE_READ_ONLY_PREVIEW_ID,
  remotionViewer: REMOTION_VIEWER_ID,
  movieViewer: MOVIE_VIEWER_ID,
  moviePreviewPlayer: MOVIE_PREVIEW_PLAYER_ID,
  movieTimeline: MOVIE_TIMELINE_ID,
  movieAssetLibrary: MOVIE_ASSET_LIBRARY_ID,
  movieExportButton: MOVIE_EXPORT_BUTTON_ID,
  movieRecordAtPlayheadButton: MOVIE_RECORD_AT_PLAYHEAD_BUTTON_ID,
  movieImportMediaButton: MOVIE_IMPORT_MEDIA_BUTTON_ID,
  movieReferenceMediaButton: MOVIE_REFERENCE_MEDIA_BUTTON_ID,
  moviePlayButton: MOVIE_PLAY_BUTTON_ID,
  movieUnlinkAudioButton: MOVIE_UNLINK_AUDIO_BUTTON_ID,
  movieSourcePreviewModal: MOVIE_SOURCE_PREVIEW_MODAL_ID,
  movieSourcePreviewDelaySlider: MOVIE_SOURCE_PREVIEW_DELAY_SLIDER_ID,
  movieSourcePreviewCloseButton: MOVIE_SOURCE_PREVIEW_CLOSE_BUTTON_ID,
  movieSourcePreviewExpandButton: MOVIE_SOURCE_PREVIEW_EXPAND_BUTTON_ID,
  movieSourcePreviewExpandButtonAnySelector: MOVIE_SOURCE_PREVIEW_EXPAND_BUTTON_ANY_SELECTOR,
  movieClip: MOVIE_CLIP_ID,
  movieTrack: MOVIE_TRACK_ID,
  editorContent: EDITOR_CONTENT_ID,
  markdownFrontmatterCard: MARKDOWN_FRONTMATTER_CARD_ID,
  browserViewContainer: BROWSER_VIEW_CONTAINER_ID,

  // === FILE SYSTEM ===
  fileSystemProxyTypeFile: FILE_SYSTEM_PROXY_TYPE_FILE,
  fileSystemProxyTypeDirectory: FILE_SYSTEM_PROXY_TYPE_DIRECTORY,

  // === SETTINGS ===
  settingsPanel: SETTINGS_PANEL_ID,
  addMcpServerButton: ADD_MCP_SERVER_BUTTON_ID,
  settingsView: GLOBAL_SETTINGS_VIEW_ID,
  settingsHeading: SETTINGS_HEADING_ID,
  toolServerSection: TOOLS_SECTION_ID,
  toggleSwitch: TOOL_TOGGLE_SWITCH_ID,
  errorContainer: SETTINGS_ERROR_CONTAINER_ID,
  builtinTools: TOOLS_SECTION_ID, // Same as toolServerSection (consolidated)
  settingsPopover: SETTINGS_POPOVER_ID,
  settingsPopoverCloseButton: SETTINGS_POPOVER_CLOSE_BUTTON_ID,
  permissionSelectSystem: PERMISSION_SELECT_SYSTEM_ID,
  permissionSelectWorkspace: PERMISSION_SELECT_WORKSPACE_ID,
  permissionSelectCustom: PERMISSION_SELECT_CUSTOM_ID,
  settingsTab: SETTINGS_TAB_ID,
  profileCard: PROFILE_CARD_ID,
  profileProviderTab: PROFILE_PROVIDER_TAB_ID,
  hostedModelPickerTrigger: HOSTED_MODEL_PICKER_TRIGGER_ID,
  hostedModelPickerPopover: HOSTED_MODEL_PICKER_POPOVER_ID,
  hostedModelPickerSearchInput: HOSTED_MODEL_PICKER_SEARCH_INPUT_ID,
  hostedModelPickerRefreshButton: HOSTED_MODEL_PICKER_REFRESH_BUTTON_ID,
  hostedModelPickerEmptyState: HOSTED_MODEL_PICKER_EMPTY_STATE_ID,
  hostedModelPickerGroupHeading: HOSTED_MODEL_PICKER_GROUP_HEADING_ID,
  hostedModelPickerOptionItem: HOSTED_MODEL_PICKER_OPTION_ITEM_ID,
  apiBaseUrlPickerTrigger: API_BASE_URL_PICKER_TRIGGER_ID,
  apiBaseUrlPickerPopover: API_BASE_URL_PICKER_POPOVER_ID,
  apiBaseUrlPickerInput: API_BASE_URL_PICKER_INPUT_ID,
  apiBaseUrlPickerOptionItem: API_BASE_URL_PICKER_OPTION_ITEM_ID,
  apiBaseUrlPickerEditInput: API_BASE_URL_PICKER_EDIT_INPUT_ID,
  profileCustomModelInput: PROFILE_CUSTOM_MODEL_INPUT_ID,
  profileModelSelect: PROFILE_MODEL_SELECT_ID,
  keyboardShortcutsSection: KEYBOARD_SHORTCUTS_SECTION_ID,

  // === PROVIDERS ===
  providersSection: PROVIDERS_SECTION_ID,
  providerItem: PROVIDER_ITEM_ID,
  addProviderButton: ADD_PROVIDER_BUTTON_ID,

  // === LAYOUT - TABS & COLUMNS ===
  tab: TAB_ID,
  tabBar: TAB_BAR_ID,
  paneContentAnySelector: PANE_CONTENT_ANY_SELECTOR,
  paneContent: PANE_CONTENT_ID,
  newTabButton: NEW_TAB_BUTTON_ID,
  refreshTabButton: REFRESH_TAB_BUTTON_ID,
  column: COLUMN_ID,

  // === UI COMPONENTS ===
  sectionHeader: SECTION_HEADER_ID,
  sectionExpanded: SECTION_EXPANDED_ID,
  sectionCollapsed: SECTION_COLLAPSED_ID,
  chevronDown: CHEVRON_DOWN_ID,
  chevronRight: CHEVRON_RIGHT_ID,
  toolCards: TOOL_SERVER_CARD_ID,

  // === ECHO SECRET ===
  echoSecretInput: ECHO_SECRET_INPUT_ID,
  echoSecretTestButton: ECHO_SECRET_TEST_BUTTON_ID,
  echoSecretSaveButton: ECHO_SECRET_SAVE_BUTTON_ID,
  echoSecretLastResult: ECHO_SECRET_LAST_RESULT_ID,

  // === CONVERSATION HISTORY ===
  rightPanelHistoryTab: RIGHT_PANEL_HISTORY_TAB_ID,
  conversationHistoryList: CONVERSATION_HISTORY_LIST_ID,
  conversationItem: CONVERSATION_ITEM_ID,

  // === SUBAGENT TOOL UI ===
  subagentToolContainer: SUBAGENT_TOOL_CONTAINER_ID,
  subagentToolItem: SUBAGENT_TOOL_ITEM_ID,

  // === TERMINAL ===
  terminalTab: TERMINAL_TAB_ID,
  terminalView: TERMINAL_VIEW_ID,

  // === CODEX ===
  codexTab: CODEX_TAB_ID,

  // === AUTH ===
  authSignIn: AUTH_SIGN_IN_ID,
  onboardingContinueButton: ONBOARDING_CONTINUE_BUTTON_ID,

  // === FEEDBACK ===
  feedbackButton: FEEDBACK_BUTTON_ID,
  feedbackPopover: FEEDBACK_POPOVER_ID,
} as const;

// =============================================================================
// TYPES
// =============================================================================

type StaticIds = {
  [K in keyof typeof ELEMENT_IDS]: (typeof ELEMENT_IDS)[K] extends string ? K : never;
}[keyof typeof ELEMENT_IDS];

type DynamicIds = {
  [K in keyof typeof ELEMENT_IDS]: (typeof ELEMENT_IDS)[K] extends (...args: unknown[]) => string ? K : never;
}[keyof typeof ELEMENT_IDS];

export type StaticElementId = StaticIds;
export type DynamicElementId = DynamicIds;
export type ElementIdKey = keyof typeof ELEMENT_IDS;
