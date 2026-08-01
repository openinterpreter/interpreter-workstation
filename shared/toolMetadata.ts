/**
 * Tool metadata - shared between server and frontend
 *
 * This is the single source of truth for tool display info.
 * Tools on the server reference this, frontend imports it directly.
 *
 * To add a new tool:
 * 1. Add it to TOOL_DISPLAY below
 * 2. The ToolName type is auto-generated from the keys
 * 3. Use ToolName type in your tool definition for compile-time safety
 */

// ============================================================================
// TYPES
// ============================================================================

export type ToolCategory = 'explore' | 'edit' | 'run' | 'browse' | 'email' | 'messaging' | 'workstation' | 'other';

export interface ToolDisplayInfo {
  category: ToolCategory;
  verb: {
    /** Present participle (e.g., "Reading", "Editing") */
    active: string;
    /** Past tense (e.g., "Read", "Edited") */
    past: string;
  };
}

// ============================================================================
// TOOL DISPLAY INFO
// ============================================================================

/**
 * Display info for all tools - defines how they appear in grouped UI
 * Add new tools here - the ToolName type is derived from these keys
 */
const TOOL_DISPLAY_INTERNAL = {
  // ============================================================================
  // FILESYSTEM
  // ============================================================================
  read_file: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  read_multiple_files: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  Read: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  read_image: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  read_word: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  write_file: { category: 'edit', verb: { active: 'Writing', past: 'Wrote' } },
  write_file_content: { category: 'edit', verb: { active: 'Writing', past: 'Wrote' } },
  Edit: { category: 'edit', verb: { active: 'Editing', past: 'Edited' } },
  apply_patch: { category: 'edit', verb: { active: 'Patching', past: 'Patched' } },
  create_directory: { category: 'edit', verb: { active: 'Creating', past: 'Created' } },
  directory_tree: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  list_directory: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  list_allowed_directories: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  move_file: { category: 'edit', verb: { active: 'Moving', past: 'Moved' } },
  copy_file: { category: 'edit', verb: { active: 'Copying', past: 'Copied' } },
  delete_file: { category: 'edit', verb: { active: 'Deleting', past: 'Deleted' } },
  search_files: { category: 'explore', verb: { active: 'Searching', past: 'Searched' } },
  grep: { category: 'explore', verb: { active: 'Searching', past: 'Searched' } },
  indexed_search: { category: 'explore', verb: { active: 'Searching', past: 'Searched' } },
  get_file_info: { category: 'explore', verb: { active: 'Inspecting', past: 'Inspected' } },
  download_file: { category: 'edit', verb: { active: 'Downloading', past: 'Downloaded' } },
  list_transcription_models: { category: 'explore', verb: { active: 'Listing transcription models', past: 'Listed transcription models' } },
  download_model: { category: 'edit', verb: { active: 'Downloading model', past: 'Downloaded model' } },
  transcribe_audio: { category: 'run', verb: { active: 'Transcribing', past: 'Transcribed' } },

  // ============================================================================
  // DOCX TOOLS
  // ============================================================================
  replace_text_in_docx: { category: 'edit', verb: { active: 'Editing DOCX', past: 'Edited DOCX' } },
  replace_paragraphs_in_docx: { category: 'edit', verb: { active: 'Replacing DOCX paragraphs', past: 'Replaced DOCX paragraphs' } },
  insert_paragraphs_in_docx: { category: 'edit', verb: { active: 'Inserting DOCX paragraphs', past: 'Inserted DOCX paragraphs' } },
  insert_table_in_docx: { category: 'edit', verb: { active: 'Inserting DOCX table', past: 'Inserted DOCX table' } },
  update_table_cells_in_docx: { category: 'edit', verb: { active: 'Updating DOCX table cells', past: 'Updated DOCX table cells' } },

  // ============================================================================
  // USER QUESTIONS
  // ============================================================================
  ask_user_question: { category: 'other', verb: { active: 'Asking', past: 'Asked' } },

  // ============================================================================
  // BROWSER
  // ============================================================================
  navigate: { category: 'browse', verb: { active: 'Navigating', past: 'Navigated' } },
  browser_navigate: { category: 'browse', verb: { active: 'Navigating', past: 'Navigated' } },
  browser_screenshot: { category: 'browse', verb: { active: 'Capturing', past: 'Captured' } },
  browser_take_screenshot: { category: 'browse', verb: { active: 'Capturing', past: 'Captured' } },
  browser_click: { category: 'browse', verb: { active: 'Clicking', past: 'Clicked' } },
  browser_type: { category: 'browse', verb: { active: 'Typing', past: 'Typed' } },
  browser_scroll: { category: 'browse', verb: { active: 'Scrolling', past: 'Scrolled' } },
  browser_select: { category: 'browse', verb: { active: 'Selecting', past: 'Selected' } },
  browser_hover: { category: 'browse', verb: { active: 'Hovering', past: 'Hovered' } },
  browser_back: { category: 'browse', verb: { active: 'Going back', past: 'Went back' } },
  browser_go_back: { category: 'browse', verb: { active: 'Going back', past: 'Went back' } },
  browser_forward: { category: 'browse', verb: { active: 'Going forward', past: 'Went forward' } },
  browser_go_forward: { category: 'browse', verb: { active: 'Going forward', past: 'Went forward' } },
  browser_refresh: { category: 'browse', verb: { active: 'Refreshing', past: 'Refreshed' } },
  browser_reload: { category: 'browse', verb: { active: 'Refreshing', past: 'Refreshed' } },
  browser_close: { category: 'browse', verb: { active: 'Closing', past: 'Closed' } },
  browser_wait: { category: 'browse', verb: { active: 'Waiting', past: 'Waited' } },
  browser_execute_js: { category: 'browse', verb: { active: 'Executing', past: 'Executed' } },
  browser_get_text: { category: 'browse', verb: { active: 'Reading', past: 'Read' } },
  browser_get_html: { category: 'browse', verb: { active: 'Reading', past: 'Read' } },
  browser_form_input: { category: 'browse', verb: { active: 'Filling', past: 'Filled' } },
  browser_get_tab_state: { category: 'browse', verb: { active: 'Viewing tab', past: 'Viewed tab' } },
  browser_read_page: { category: 'browse', verb: { active: 'Reading', past: 'Read' } },
  read_page: { category: 'browse', verb: { active: 'Reading', past: 'Read' } },
  web_search: { category: 'browse', verb: { active: 'Searching', past: 'Searched' } },

  // ============================================================================
  // EMAIL - NYLAS
  // ============================================================================
  nylas_list_messages: { category: 'email', verb: { active: 'Listing', past: 'Listed' } },
  nylas_read_message: { category: 'email', verb: { active: 'Reading', past: 'Read' } },
  nylas_search_messages: { category: 'email', verb: { active: 'Searching', past: 'Searched' } },
  nylas_send_message: { category: 'email', verb: { active: 'Sending', past: 'Sent' } },
  nylas_draft_message: { category: 'email', verb: { active: 'Drafting', past: 'Drafted' } },
  nylas_reply_to_message: { category: 'email', verb: { active: 'Replying', past: 'Replied' } },
  nylas_download_attachment: { category: 'email', verb: { active: 'Downloading', past: 'Downloaded' } },
  nylas_list_folders: { category: 'email', verb: { active: 'Listing', past: 'Listed' } },
  nylas_list_labels: { category: 'email', verb: { active: 'Listing', past: 'Listed' } },
  nylas_create_draft: { category: 'email', verb: { active: 'Drafting', past: 'Drafted' } },
  nylas_list_drafts: { category: 'email', verb: { active: 'Listing', past: 'Listed' } },
  nylas_list_threads: { category: 'email', verb: { active: 'Listing', past: 'Listed' } },
  nylas_send_draft: { category: 'email', verb: { active: 'Sending', past: 'Sent' } },
  nylas_send_email: { category: 'email', verb: { active: 'Sending', past: 'Sent' } },

  // ============================================================================
  // MESSAGING - WHATSAPP
  // ============================================================================
  whatsapp_list_chats: { category: 'messaging', verb: { active: 'Listing', past: 'Listed' } },
  whatsapp_read_chat: { category: 'messaging', verb: { active: 'Reading', past: 'Read' } },
  whatsapp_send_message: { category: 'messaging', verb: { active: 'Sending', past: 'Sent' } },
  whatsapp_search_messages: { category: 'messaging', verb: { active: 'Searching', past: 'Searched' } },

  // ============================================================================
  // MESSAGING - TELEGRAM
  // ============================================================================
  telegram_list_chats: { category: 'messaging', verb: { active: 'Listing', past: 'Listed' } },
  telegram_read_chat: { category: 'messaging', verb: { active: 'Reading', past: 'Read' } },
  telegram_send_message: { category: 'messaging', verb: { active: 'Sending', past: 'Sent' } },
  telegram_search_messages: { category: 'messaging', verb: { active: 'Searching', past: 'Searched' } },

  // ============================================================================
  // DOCUMENTS - PDF
  // ============================================================================
  read_pdf: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  create_pdf: { category: 'edit', verb: { active: 'Creating', past: 'Created' } },
  fill_pdf_form: { category: 'edit', verb: { active: 'Filling', past: 'Filled' } },
  merge_pdfs: { category: 'edit', verb: { active: 'Merging', past: 'Merged' } },
  add_pdf_annotations: { category: 'edit', verb: { active: 'Annotating', past: 'Annotated' } },
  add_pdf_image_annotations: { category: 'edit', verb: { active: 'Annotating', past: 'Annotated' } },
  remove_pdf_annotations: { category: 'edit', verb: { active: 'Removing', past: 'Removed' } },

  // ============================================================================
  // DOCUMENTS - DOCX
  // ============================================================================
  read_docx: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  create_docx: { category: 'edit', verb: { active: 'Creating', past: 'Created' } },
  write_docx: { category: 'edit', verb: { active: 'Writing', past: 'Wrote' } },
  add_docx_comments: { category: 'edit', verb: { active: 'Commenting', past: 'Commented' } },
  add_docx_image: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  add_docx_relationship: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },

  // ============================================================================
  // DOCUMENTS - XLSX (CELLS)
  // ============================================================================
  read_xlsx: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  write_xlsx: { category: 'edit', verb: { active: 'Writing', past: 'Wrote' } },
  set_cell_formula: { category: 'edit', verb: { active: 'Setting', past: 'Set' } },
  get_cell_formula: { category: 'explore', verb: { active: 'Reading formula', past: 'Read formula' } },
  set_formula_range: { category: 'edit', verb: { active: 'Setting', past: 'Set' } },
  get_formula_range: { category: 'explore', verb: { active: 'Reading formulas', past: 'Read formulas' } },
  update_cell: { category: 'edit', verb: { active: 'Updating', past: 'Updated' } },
  update_worksheet: { category: 'edit', verb: { active: 'Updating', past: 'Updated' } },
  read_worksheet: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  write_worksheet: { category: 'edit', verb: { active: 'Writing', past: 'Wrote' } },
  hide_unhide_rows_columns: { category: 'edit', verb: { active: 'Modifying', past: 'Modified' } },
  write_data_to_excel: { category: 'edit', verb: { active: 'Writing', past: 'Wrote' } },
  // Additional cells tools
  add_column: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  add_row: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  add_sheet: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  delete_column: { category: 'edit', verb: { active: 'Deleting', past: 'Deleted' } },
  delete_row: { category: 'edit', verb: { active: 'Deleting', past: 'Deleted' } },
  delete_sheet: { category: 'edit', verb: { active: 'Deleting', past: 'Deleted' } },
  list_sheets: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  read_cell: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  read_range: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  read_spreadsheet: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  search_cells: { category: 'explore', verb: { active: 'Searching', past: 'Searched' } },
  clear_range: { category: 'edit', verb: { active: 'Clearing', past: 'Cleared' } },
  copy_paste_cells: { category: 'edit', verb: { active: 'Copying', past: 'Copied' } },
  merge_cells: { category: 'edit', verb: { active: 'Merging', past: 'Merged' } },
  resize_rows_columns: { category: 'edit', verb: { active: 'Resizing', past: 'Resized' } },
  cell_format: { category: 'edit', verb: { active: 'Formatting', past: 'Formatted' } },
  export_spreadsheet: { category: 'edit', verb: { active: 'Exporting', past: 'Exported' } },
  get_spreadsheet_info: { category: 'explore', verb: { active: 'Inspecting spreadsheet', past: 'Inspected spreadsheet' } },
  batch_edit_spreadsheet: { category: 'edit', verb: { active: 'Editing', past: 'Edited' } },
  // Advanced spreadsheet features exposed by compatible engines
  pivot_table: { category: 'edit', verb: { active: 'Managing', past: 'Managed' } },
  chart: { category: 'edit', verb: { active: 'Managing', past: 'Managed' } },
  conditional_format: { category: 'edit', verb: { active: 'Formatting', past: 'Formatted' } },
  data_validation: { category: 'edit', verb: { active: 'Validating', past: 'Validated' } },
  named_range: { category: 'edit', verb: { active: 'Managing', past: 'Managed' } },
  auto_filter: { category: 'edit', verb: { active: 'Filtering', past: 'Filtered' } },
  freeze_panes: { category: 'edit', verb: { active: 'Freezing', past: 'Froze' } },
  recalculate_workbook: { category: 'edit', verb: { active: 'Recalculating', past: 'Recalculated' } },
  page_setup: { category: 'edit', verb: { active: 'Configuring', past: 'Configured' } },
  sparkline: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  insert_image: { category: 'edit', verb: { active: 'Inserting', past: 'Inserted' } },
  protect_sheet: { category: 'edit', verb: { active: 'Protecting', past: 'Protected' } },
  cell_comment: { category: 'edit', verb: { active: 'Commenting', past: 'Commented' } },
  hyperlink: { category: 'edit', verb: { active: 'Linking', past: 'Linked' } },
  group_rows_columns: { category: 'edit', verb: { active: 'Grouping', past: 'Grouped' } },

  // ============================================================================
  // DOCUMENTS - PPTX (SLIDES)
  // ============================================================================
  create_presentation: { category: 'edit', verb: { active: 'Creating', past: 'Created' } },
  read_pptx: { category: 'explore', verb: { active: 'Reading', past: 'Read' } },
  write_pptx: { category: 'edit', verb: { active: 'Writing', past: 'Wrote' } },
  PptxOpen: { category: 'explore', verb: { active: 'Opening', past: 'Opened' } },
  PptxSave: { category: 'edit', verb: { active: 'Saving', past: 'Saved' } },
  PptxSlideAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  PptxSlideRemove: { category: 'edit', verb: { active: 'Removing', past: 'Removed' } },
  PptxSlideList: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  PptxSlideReorder: { category: 'edit', verb: { active: 'Reordering', past: 'Reordered' } },
  PptxSlideExport: { category: 'edit', verb: { active: 'Exporting', past: 'Exported' } },
  PptxSlideSizeGet: { category: 'explore', verb: { active: 'Reading slide size', past: 'Read slide size' } },
  PptxSlideSizeSet: { category: 'edit', verb: { active: 'Setting', past: 'Set' } },
  PptxShapeAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  PptxShapeList: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  PptxShapeModify: { category: 'edit', verb: { active: 'Modifying', past: 'Modified' } },
  PptxShapeRemove: { category: 'edit', verb: { active: 'Removing', past: 'Removed' } },
  PptxTextGet: { category: 'explore', verb: { active: 'Reading text', past: 'Read text' } },
  PptxTextSet: { category: 'edit', verb: { active: 'Setting', past: 'Set' } },
  PptxImageAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  PptxImageReplace: { category: 'edit', verb: { active: 'Replacing', past: 'Replaced' } },
  PptxTableAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  PptxTableModify: { category: 'edit', verb: { active: 'Modifying', past: 'Modified' } },
  PptxChartAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  PptxChartModify: { category: 'edit', verb: { active: 'Modifying', past: 'Modified' } },
  PptxAnimationAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  PptxAnimationList: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  PptxAnimationRemove: { category: 'edit', verb: { active: 'Removing', past: 'Removed' } },
  PptxTransitionSet: { category: 'edit', verb: { active: 'Setting', past: 'Set' } },
  PptxNotesGet: { category: 'explore', verb: { active: 'Reading notes', past: 'Read notes' } },
  PptxNotesSet: { category: 'edit', verb: { active: 'Setting', past: 'Set' } },
  PptxPropertiesGet: { category: 'explore', verb: { active: 'Reading properties', past: 'Read properties' } },
  PptxPropertiesSet: { category: 'edit', verb: { active: 'Setting', past: 'Set' } },
  PptxSectionManage: { category: 'edit', verb: { active: 'Managing', past: 'Managed' } },
  PptxSmartArtAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  PptxSmartArtModify: { category: 'edit', verb: { active: 'Modifying', past: 'Modified' } },
  PptxMediaModify: { category: 'edit', verb: { active: 'Modifying', past: 'Modified' } },
  PptxAudioAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  PptxVideoAdd: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },

  // ============================================================================
  // CONVERTER
  // ============================================================================
  convert_file: { category: 'edit', verb: { active: 'Converting', past: 'Converted' } },

  // ============================================================================
  // MCP MANAGEMENT
  // ============================================================================
  list_mcp_servers: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  get_mcp_server_tools: { category: 'explore', verb: { active: 'Listing tools', past: 'Listed tools' } },
  mcp_add_server: { category: 'edit', verb: { active: 'Adding', past: 'Added' } },
  mcp_get_server: { category: 'explore', verb: { active: 'Viewing server', past: 'Viewed server' } },
  mcp_list_servers: { category: 'explore', verb: { active: 'Listing', past: 'Listed' } },
  mcp_remove_server: { category: 'edit', verb: { active: 'Removing', past: 'Removed' } },
  mcp_toggle_server: { category: 'edit', verb: { active: 'Toggling', past: 'Toggled' } },
  mcp_update_server: { category: 'edit', verb: { active: 'Updating', past: 'Updated' } },
  mcp_search_store: { category: 'explore', verb: { active: 'Searching', past: 'Searched' } },
  mcp_refresh_tools: { category: 'edit', verb: { active: 'Refreshing tools', past: 'Refreshed tools' } },

  // ============================================================================
  // WORKSTATION
  // ============================================================================
  open_file: { category: 'workstation', verb: { active: 'Opening', past: 'Opened' } },
  list_open_tabs: { category: 'workstation', verb: { active: 'Viewing open tabs', past: 'Viewed open tabs' } },
  close_tab: { category: 'workstation', verb: { active: 'Closing tab', past: 'Closed tab' } },
  interpreter_close_tab: { category: 'workstation', verb: { active: 'Closing tab', past: 'Closed tab' } },
  interpreter_refresh_file: { category: 'workstation', verb: { active: 'Refreshing file', past: 'Refreshed file' } },
  interpreter_show_in_folder: { category: 'workstation', verb: { active: 'Revealing path', past: 'Revealed path' } },
  interpreter_get_context: { category: 'workstation', verb: { active: 'Viewing Interpreter', past: 'Viewed Interpreter' } },
  interpreter_get_selection: { category: 'workstation', verb: { active: 'Viewing selection', past: 'Viewed selection' } },
  read_current_selection: { category: 'workstation', verb: { active: 'Reading selection', past: 'Read selection' } },
  interpreter_get: { category: 'workstation', verb: { active: 'Viewing Interpreter', past: 'Viewed Interpreter' } },
  interpreter_set: { category: 'workstation', verb: { active: 'Updating Interpreter layout', past: 'Updated Interpreter layout' } },
  interpreter_vault: { category: 'workstation', verb: { active: 'Inspecting note graph', past: 'Inspected note graph' } },
  interpreter_settings_get: { category: 'workstation', verb: { active: 'Viewing settings', past: 'Viewed settings' } },
  interpreter_settings_set: { category: 'workstation', verb: { active: 'Updating settings', past: 'Updated settings' } },
  interpreter_custom_instructions_get: { category: 'workstation', verb: { active: 'Reading custom instructions', past: 'Read custom instructions' } },
  interpreter_custom_instructions_set: { category: 'workstation', verb: { active: 'Updating custom instructions', past: 'Updated custom instructions' } },
  interpreter_whole_computer_state_get: { category: 'workstation', verb: { active: 'Reading computer state', past: 'Read computer state' } },
  interpreter_browser_tab_activate: { category: 'workstation', verb: { active: 'Activating browser tab', past: 'Activated browser tab' } },
  interpreter_browser_page_inspect: { category: 'workstation', verb: { active: 'Inspecting browser page', past: 'Inspected browser page' } },
  interpreter_browser_page_trace: { category: 'workstation', verb: { active: 'Drawing browser trace', past: 'Drew browser trace' } },
  interpreter_browser_page_click: { category: 'workstation', verb: { active: 'Clicking browser element', past: 'Clicked browser element' } },
  interpreter_browser_page_type: { category: 'workstation', verb: { active: 'Typing browser text', past: 'Typed browser text' } },
  interpreter_browser_page_select: { category: 'workstation', verb: { active: 'Selecting browser option', past: 'Selected browser option' } },
  interpreter_browser_page_scroll: { category: 'workstation', verb: { active: 'Scrolling browser page', past: 'Scrolled browser page' } },
  interpreter_config_restart_runtime: { category: 'workstation', verb: { active: 'Restarting runtime', past: 'Restarted runtime' } },
  interpreter_usage_get: { category: 'workstation', verb: { active: 'Viewing usage', past: 'Viewed usage' } },
  list_agent_windows: { category: 'workstation', verb: { active: 'Listing agent windows', past: 'Listed agent windows' } },
  launch_agent_window: { category: 'workstation', verb: { active: 'Launching agent', past: 'Launched agent' } },
  send_agent_window_message: { category: 'workstation', verb: { active: 'Sending message to agent', past: 'Sent message to agent' } },
  reveal_agent_window: { category: 'workstation', verb: { active: 'Revealing agent', past: 'Revealed agent' } },
  stop_agent_window: { category: 'workstation', verb: { active: 'Stopping agent', past: 'Stopped agent' } },
  close_agent_window: { category: 'workstation', verb: { active: 'Closing agent', past: 'Closed agent' } },
  await_agent_window: { category: 'workstation', verb: { active: 'Waiting for agent', past: 'Waited for agent' } },
  interpreter_cua: { category: 'workstation', verb: { active: 'Controlling apps', past: 'Controlled apps' } },
  list_apps: { category: 'workstation', verb: { active: 'Listing apps', past: 'Listed apps' } },
  list_windows: { category: 'workstation', verb: { active: 'Listing windows', past: 'Listed windows' } },
  list_automation_targets: { category: 'workstation', verb: { active: 'Listing automation targets', past: 'Listed automation targets' } },
  list_com_objects: { category: 'workstation', verb: { active: 'Listing COM objects', past: 'Listed COM objects' } },
  launch_app: { category: 'workstation', verb: { active: 'Launching app', past: 'Launched app' } },
  check_permissions: { category: 'workstation', verb: { active: 'Checking permissions', past: 'Checked permissions' } },
  get_screen_size: { category: 'workstation', verb: { active: 'Reading screen size', past: 'Read screen size' } },
  get_cursor_position: { category: 'workstation', verb: { active: 'Reading cursor position', past: 'Read cursor position' } },
  get_accessibility_tree: { category: 'workstation', verb: { active: 'Inspecting desktop', past: 'Inspected desktop' } },
  get_window_state: { category: 'workstation', verb: { active: 'Inspecting window', past: 'Inspected window' } },
  get_config: { category: 'workstation', verb: { active: 'Reading Cua Driver config', past: 'Read Cua Driver config' } },
  set_config: { category: 'workstation', verb: { active: 'Updating Cua Driver config', past: 'Updated Cua Driver config' } },
  get_agent_cursor_state: { category: 'workstation', verb: { active: 'Reading agent cursor', past: 'Read agent cursor' } },
  set_agent_cursor_enabled: { category: 'workstation', verb: { active: 'Toggling agent cursor', past: 'Toggled agent cursor' } },
  set_agent_cursor_motion: { category: 'workstation', verb: { active: 'Updating agent cursor', past: 'Updated agent cursor' } },
  get_recording_state: { category: 'workstation', verb: { active: 'Reading recording state', past: 'Read recording state' } },
  set_recording: { category: 'workstation', verb: { active: 'Updating recording state', past: 'Updated recording state' } },
  get_app_state: { category: 'workstation', verb: { active: 'Inspecting app', past: 'Inspected app' } },
  click: { category: 'workstation', verb: { active: 'Clicking app', past: 'Clicked app' } },
  com_automation: { category: 'workstation', verb: { active: 'Using COM Automation', past: 'Used COM Automation' } },
  double_click: { category: 'workstation', verb: { active: 'Double-clicking app', past: 'Double-clicked app' } },
  right_click: { category: 'workstation', verb: { active: 'Right-clicking app', past: 'Right-clicked app' } },
  drag: { category: 'workstation', verb: { active: 'Dragging in app', past: 'Dragged in app' } },
  move_cursor: { category: 'workstation', verb: { active: 'Moving cursor', past: 'Moved cursor' } },
  press_key: { category: 'workstation', verb: { active: 'Pressing key', past: 'Pressed key' } },
  hotkey: { category: 'workstation', verb: { active: 'Pressing hotkey', past: 'Pressed hotkey' } },
  scroll: { category: 'workstation', verb: { active: 'Scrolling app', past: 'Scrolled app' } },
  set_value: { category: 'workstation', verb: { active: 'Setting value', past: 'Set value' } },
  type_text: { category: 'workstation', verb: { active: 'Typing in app', past: 'Typed in app' } },
  type_text_chars: { category: 'workstation', verb: { active: 'Typing in app', past: 'Typed in app' } },
  screenshot: { category: 'workstation', verb: { active: 'Capturing app', past: 'Captured app' } },
  zoom: { category: 'workstation', verb: { active: 'Zooming screenshot', past: 'Zoomed screenshot' } },
  replay_trajectory: { category: 'workstation', verb: { active: 'Replaying trajectory', past: 'Replayed trajectory' } },
  perform_secondary_action: { category: 'workstation', verb: { active: 'Running app action', past: 'Ran app action' } },
  overlay_read_context: { category: 'workstation', verb: { active: 'Reading overlay', past: 'Read overlay' } },
  overlay_screenshot: { category: 'workstation', verb: { active: 'Capturing overlay', past: 'Captured overlay' } },
  computer_batch: { category: 'workstation', verb: { active: 'Running overlay batch', past: 'Ran overlay batch' } },
  overlay_show_drawings: { category: 'workstation', verb: { active: 'Showing overlay drawings', past: 'Showed overlay drawings' } },
  overlay_clear_drawings: { category: 'workstation', verb: { active: 'Clearing overlay drawings', past: 'Cleared overlay drawings' } },
  call_hidden_agent: { category: 'workstation', verb: { active: 'Calling hidden agent', past: 'Called hidden agent' } },
  overlay_click: { category: 'workstation', verb: { active: 'Clicking overlay', past: 'Clicked overlay' } },
  overlay_type: { category: 'workstation', verb: { active: 'Typing in overlay', past: 'Typed in overlay' } },
  overlay_hotkey: { category: 'workstation', verb: { active: 'Pressing overlay hotkey', past: 'Pressed overlay hotkey' } },
  overlay_scroll: { category: 'workstation', verb: { active: 'Scrolling overlay', past: 'Scrolled overlay' } },
  overlay_detach: { category: 'workstation', verb: { active: 'Detaching overlay', past: 'Detached overlay' } },
  overlay_complete: { category: 'workstation', verb: { active: 'Completing overlay', past: 'Completed overlay' } },

  // ============================================================================
  // UTILITY
  // ============================================================================
  wait: { category: 'other', verb: { active: 'Waiting', past: 'Waited' } },
  calculate: { category: 'other', verb: { active: 'Calculating', past: 'Calculated' } },
  speak_text: { category: 'other', verb: { active: 'Speaking', past: 'Spoke' } },
  js_repl: { category: 'run', verb: { active: 'Running JavaScript', past: 'Ran JavaScript' } },
  js_repl_reset: { category: 'run', verb: { active: 'Resetting JS kernel', past: 'Reset JS kernel' } },
  ask_user: { category: 'other', verb: { active: 'Asking', past: 'Asked' } },
  create_tasks: { category: 'other', verb: { active: 'Planning tasks', past: 'Planned tasks' } },
  update_task: { category: 'other', verb: { active: 'Updating task', past: 'Updated task' } },

  // ============================================================================
  // MEDIA AI
  // ============================================================================
  search_media_models: { category: 'explore', verb: { active: 'Searching', past: 'Searched' } },
  estimate_media_cost: { category: 'explore', verb: { active: 'Estimating', past: 'Estimated' } },
  run_media_model: { category: 'run', verb: { active: 'Generating', past: 'Generated' } },

  // ============================================================================
  // REMOTION
  // ============================================================================
  remotion_get_state: { category: 'other', verb: { active: 'Reading state', past: 'Read state' } },
  remotion_play: { category: 'other', verb: { active: 'Playing', past: 'Played' } },
  remotion_pause: { category: 'other', verb: { active: 'Pausing', past: 'Paused' } },
  remotion_seek: { category: 'other', verb: { active: 'Seeking', past: 'Seeked' } },
  remotion_exec_js: { category: 'other', verb: { active: 'Running JS', past: 'Ran JS' } },

  // ============================================================================
  // TEST/INTERNAL
  // ============================================================================
  test_approval: { category: 'other', verb: { active: 'Testing', past: 'Tested' } },
  run_agent: { category: 'run', verb: { active: 'Running', past: 'Ran' } },
  run_agent_ui: { category: 'run', verb: { active: 'Running', past: 'Ran' } },
  echo_secret: { category: 'other', verb: { active: 'Echoing', past: 'Echoed' } },
} as const satisfies Record<string, ToolDisplayInfo>;

/**
 * Union type of all known tool names
 * Tool definitions should use this type for compile-time safety
 */
export type ToolName = keyof typeof TOOL_DISPLAY_INTERNAL;

/**
 * Exported tool display info
 */
export const TOOL_DISPLAY: Record<ToolName, ToolDisplayInfo> = TOOL_DISPLAY_INTERNAL;

// ============================================================================
// SUBAGENT TOOLS
// ============================================================================

/**
 * Tools that spawn subagents and need SubagentToolUI
 */
export const SUBAGENT_TOOLS: readonly ToolName[] = [];

/**
 * Check if a tool is a subagent tool
 */
export function isSubagentTool(toolName: string): boolean {
  return (SUBAGENT_TOOLS as readonly string[]).includes(toolName);
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Get display info for a tool
 * Returns undefined for unknown tools (e.g., MCP tools)
 */
export function getToolDisplay(toolName: string): ToolDisplayInfo | undefined {
  return TOOL_DISPLAY[toolName as ToolName];
}

/**
 * Default display for unknown tools
 */
export const DEFAULT_DISPLAY: ToolDisplayInfo = {
  category: 'other',
  verb: { active: 'Processing', past: 'Processed' },
};
