export interface AdvancedVoiceToolResponse {
  output: string;
  followUpUserMessage?: string;
  requestResponse?: boolean;
}

export function buildAdvancedVoiceDelegatedToolResponse(
  lastAssistantText: string,
): AdvancedVoiceToolResponse {
  const hasResult = Boolean(lastAssistantText.trim());
  return {
    output: JSON.stringify({
      status: hasResult ? 'finished' : 'accepted_and_working',
      resultReady: hasResult,
      responsePolicy: hasResult
        ? 'call_read_agent_assistant_messages_once_and_report_only_the_user_visible_result'
        : 'stay_silent_until_user_asks_for_progress_or_completion_notice',
      userFacingSpeechPolicy: hasResult
        ? 'report_the_result_without_mentioning_agents_tools_threads_or_internal_routing'
        : 'do_not_speak',
    }),
    followUpUserMessage: hasResult
      ? 'The delegated work finished. Check the user-visible result now.'
      : undefined,
    requestResponse: hasResult,
  };
}
