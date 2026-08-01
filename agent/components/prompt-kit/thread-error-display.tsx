import { type ComponentProps, type FC, type ReactElement, useMemo } from 'react';
import { ERROR_MESSAGE_ID } from '../../../shared/element-ids';
import { usePaidPlanStatus } from '../../../src/hooks/usePaidPlanStatus';
import {
  extractNestedErrorMessage,
  getResponsesToolCallingContractError,
  getUnsupportedImageInputError,
  formatChatGptUsageLimitMessage,
  isHostedHighDemandMessage,
  isChatGptUsageLimitSentence,
  INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE,
  isLocalRuntimeUpdateMessage,
  IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE,
  INTERPRETER_HOSTED_OVERLOADED_MESSAGE,
  OPENAI_CUSTOM_TOOL_MODEL_MESSAGE,
  TOOL_USE_ROUTE_UNAVAILABLE_MESSAGE,
} from '../../../src/lib/codex/errors';
import i18n, { tr } from '../../../src/i18n';
import { openFeedbackPopover } from '../../../src/utils/feedback';
import { Button } from '../../../src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../src/components/ui/tooltip';

const URL_PREFIXES = ['http://', 'https://'] as const;
const TRAILING_URL_PUNCTUATION = [')', '.', ',', '!', '?', ';', ':'] as const;
const URL_BODY_PATTERN = /^\S*/;

function findNextUrlStart(text: string, fromIndex: number): number {
  const nextIndexes = URL_PREFIXES
    .map((prefix) => text.indexOf(prefix, fromIndex))
    .filter((index) => index >= 0);

  if (nextIndexes.length === 0) {
    return -1;
  }

  return Math.min(...nextIndexes);
}

function findUrlEnd(text: string, startIndex: number): number {
  const remainder = text.slice(startIndex);
  const urlBody = remainder.match(URL_BODY_PATTERN)?.[0] ?? '';
  return startIndex + urlBody.length;
}

function trimTrailingUrlPunctuation(url: string): { trimmedUrl: string; trailingPunctuation: string } {
  let trimmedEnd = url.length;
  for (let index = url.length - 1; index >= 0; index -= 1) {
    const character = url[index] as typeof TRAILING_URL_PUNCTUATION[number];
    if (!TRAILING_URL_PUNCTUATION.includes(character)) {
      break;
    }
    trimmedEnd = index;
  }

  return {
    trimmedUrl: url.slice(0, trimmedEnd),
    trailingPunctuation: url.slice(trimmedEnd),
  };
}

export function splitTextIntoLinkParts(text: string): Array<{ type: 'text' | 'link'; text: string }> {
  const parts: Array<{ type: 'text' | 'link'; text: string }> = [];
  let lastIndex = 0;
  let urlStart = findNextUrlStart(text, 0);

  while (urlStart >= 0) {
    const urlEnd = findUrlEnd(text, urlStart);
    const matchedText = text.slice(urlStart, urlEnd);
    const { trimmedUrl, trailingPunctuation } = trimTrailingUrlPunctuation(matchedText);

    if (urlStart > lastIndex) {
      parts.push({ type: 'text', text: text.slice(lastIndex, urlStart) });
    }

    parts.push({ type: 'link', text: trimmedUrl });
    if (trailingPunctuation) {
      parts.push({ type: 'text', text: trailingPunctuation });
    }

    lastIndex = urlEnd;
    urlStart = findNextUrlStart(text, urlEnd);
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return parts;
}

function renderTextWithClickableLinks(text: string): Array<string | ReactElement> {
  return splitTextIntoLinkParts(text).map((part, index) => {
    if (part.type === 'text') {
      return part.text;
    }

    const url = part.text;
    return (
      <a
        key={`${url}-${index}`}
        href={url}
        className="underline underline-offset-4 hover:opacity-70"
        onClick={(event) => {
          event.preventDefault();
          if (typeof window !== 'undefined' && (window as any).windowingAPI) {
            (window as any).windowingAPI.openBrowser(url);
            return;
          }
          window.open(url, '_blank', 'noopener,noreferrer');
        }}
      >
        {url}
      </a>
    );
  });
}

function extractRawErrorMessage(rawError: string | object | null): string | null {
  return extractNestedErrorMessage(rawError);
}

function extractHostnameFromUrl(rawUrl: string | null | undefined): string | null {
  const trimmedUrl = rawUrl?.trim();
  if (!trimmedUrl) return null;
  try {
    const hostname = new URL(trimmedUrl).hostname.trim().toLowerCase();
    if (!hostname) return null;
    if (hostname.startsWith('api.')) return hostname.slice(4);
    if (hostname.startsWith('www.')) return hostname.slice(4);
    return hostname;
  } catch {
    return null;
  }
}

function isLocalOrSelfHostedEndpointBaseUrl(rawUrl: string | null | undefined): boolean {
  const trimmedUrl = rawUrl?.trim();
  if (!trimmedUrl) return false;
  try {
    return new URL(trimmedUrl).protocol === 'http:';
  } catch {
    return false;
  }
}

function buildUnsupportedResponsesEndpointMessage(requestEndpointBaseUrl?: string | null): string {
  const hostname = extractHostnameFromUrl(requestEndpointBaseUrl);
  if (hostname) {
    return tr('threadError.unsupportedResponsesEndpoint.messageWithHost', { hostname });
  }

  return tr('threadError.unsupportedResponsesEndpoint.messageGeneric');
}

function responsesContractIncompatibleError(
  responsesContractError: string,
  requestEndpointBaseUrl?: string | null,
): ParsedThreadError {
  const hostname = extractHostnameFromUrl(requestEndpointBaseUrl);

  if (isLocalOrSelfHostedEndpointBaseUrl(requestEndpointBaseUrl)) {
    return {
      type: 'responses_contract_incompatible',
      title: tr('threadError.responsesContract.localTitle'),
      message: tr('threadError.responsesContract.localMessage', { hostname: hostname ? ` at ${hostname}` : '' }),
      suggestion: tr('threadError.responsesContract.localSuggestion'),
    };
  }

  if (hostname) {
    return {
      type: 'responses_contract_incompatible',
      title: tr('threadError.responsesContract.customTitle'),
      message: tr('threadError.responsesContract.customMessage', { hostname }),
      suggestion: tr('threadError.responsesContract.customSuggestion'),
    };
  }

  return {
    type: 'responses_contract_incompatible',
    title: tr('threadError.responsesContract.genericTitle'),
    message: responsesContractError,
    suggestion: tr('threadError.responsesContract.genericSuggestion'),
  };
}

function isLocalModelMissingError(errorStr: string): boolean {
  const mentionsModelMissing = errorStr.includes('model') && (errorStr.includes('not found') || errorStr.includes('does not exist'));
  if (!mentionsModelMissing) return false;
  // NOTE(victor): Codex binary sends bare "model 'X' not found" without 'ollama'
  // context string. The "model" + "not found" pattern is specific enough -- cloud
  // providers use different phrasing and are caught by earlier structured checks.
  return true;
}

function isLocalModelNoToolsError(errorStr: string): boolean {
  return errorStr.includes('does not support tools');
}

function isLocalContextTooSmallError(errorStr: string): boolean {
  return (errorStr.includes('n_keep') && errorStr.includes('n_ctx'))
    || errorStr.includes('load the model with a larger context length');
}

function isLocalProvider(provider?: string): boolean {
  return provider === 'local' || provider === 'ollama' || provider === 'lmstudio';
}

function localProviderDisplayName(provider?: string): string {
  switch (provider) {
    case 'lmstudio': return 'LM Studio';
    case 'ollama': return 'Ollama';
    case 'local': return tr('threadError.provider.localProvider');
    default: return tr('threadError.provider.localProvider');
  }
}

function isGenericContextOverflowError(errorStr: string): boolean {
  return errorStr.includes('conversation too long')
    || errorStr.includes('too long')
    || errorStr.includes('too large')
    || errorStr.includes('max_input')
    || errorStr.includes('token limit')
    || errorStr.includes('context window exceeded')
    || errorStr.includes('context length')
    || errorStr.includes('maximum context');
}

function localContextTooSmallSuggestion(provider?: string): string {
  const providerName = localProviderDisplayName(provider);
  return tr('threadError.localContextTooSmall.suggestion', { provider: providerName });
}

function localContextTooSmallMessage(rawError: string | object | null, provider?: string): string {
  const rawMessage = extractRawErrorMessage(rawError)?.trim();
  if (rawMessage && !/^context window exceeded\./i.test(rawMessage) && !/^conversation too long\./i.test(rawMessage)) {
    return rawMessage;
  }

  const providerName = localProviderDisplayName(provider);
  return tr('threadError.localContextTooSmall.message', { provider: providerName });
}

// NOTE(victor): The codex binary loses the actual LM Studio/Ollama error body
// (e.g. "n_keep >= n_ctx") and surfaces only "stream disconnected before
// completion".  On a local provider this almost always means the prompt
// overflowed the model's configured context window.
function isLikelyLocalContextOverflow(errorStr: string, provider?: string): boolean {
  return isLocalProvider(provider)
    && errorStr.includes('stream disconnected')
    && errorStr.includes('before response');
}

function isProviderStreamDisconnected(errorStr: string, provider?: string): boolean {
  return Boolean(provider)
    && !isLocalProvider(provider)
    && (
      errorStr.includes('response stream disconnected')
      || (
        errorStr.includes('stream disconnected before completion')
        && errorStr.includes('internal stream ended unexpectedly')
      )
    );
}

function isLmStudioNotRunningError(errorStr: string, provider?: string): boolean {
  const mentionsLocalLmStudioResponsesEndpoint = (errorStr.includes('localhost:1234') || errorStr.includes('127.0.0.1:1234'))
    && (errorStr.includes('/v1/responses') || errorStr.includes('/responses'));
  return (provider === 'local' || mentionsLocalLmStudioResponsesEndpoint)
    && errorStr.includes('error sending request for url')
    && mentionsLocalLmStudioResponsesEndpoint;
}

function isOllamaNotRunningError(errorStr: string, provider?: string): boolean {
  const mentionsLocalOllamaResponsesEndpoint = (errorStr.includes('localhost:11434') || errorStr.includes('127.0.0.1:11434'))
    && (errorStr.includes('/v1/responses') || errorStr.includes('/responses'));
  return (provider === 'local' || provider === 'ollama' || mentionsLocalOllamaResponsesEndpoint)
    && errorStr.includes('error sending request for url')
    && mentionsLocalOllamaResponsesEndpoint;
}

function isUsageLimitError(errorStr: string): boolean {
  return errorStr.includes('usage limit')
    || errorStr.includes('quota exceeded')
    || errorStr.includes('billing hard limit')
    || (errorStr.includes('limit has been reached') && errorStr.includes('usage'));
}

function extractDetailedUsageLimitMessage(rawError: string | object | null): string | null {
  const rawMessage = extractRawErrorMessage(rawError);
  if (!rawMessage) {
    return null;
  }
  const normalized = rawMessage.toLowerCase();
  if (!normalized.includes('usage limit')) {
    return null;
  }
  const hasWindow = normalized.includes('window:');
  const hasResetTimestamp = normalized.includes('resets at:');
  const hasRetryHint = normalized.includes('try again at');
  if (!hasWindow && !hasResetTimestamp && !hasRetryHint) {
    return null;
  }
  return rawMessage;
}

function extractTimingFromDetails(errorDetails?: string | null): string | null {
  if (!errorDetails) return null;
  try {
    const parsed = JSON.parse(errorDetails);
    if (!parsed || typeof parsed !== 'object') return null;
    const limits = parsed.rateLimitsByLimitId;
    if (!limits || typeof limits !== 'object') return null;
    const firstEntry = Object.values(limits)[0] as Record<string, unknown> | undefined;
    const primary = firstEntry?.primary as Record<string, unknown> | undefined;
    if (!primary) return null;

    const pieces: string[] = [];
    if (typeof primary.windowDurationMins === 'number' && Number.isFinite(primary.windowDurationMins)) {
      pieces.push(`Window: ${Math.floor(primary.windowDurationMins)} minutes.`);
    }
    if (typeof primary.resetsAt === 'number' && Number.isFinite(primary.resetsAt) && primary.resetsAt > 0) {
      const seconds = primary.resetsAt > 1_000_000_000_000 ? primary.resetsAt / 1_000 : primary.resetsAt;
      const date = new Date(Math.floor(seconds) * 1_000);
      if (!Number.isNaN(date.getTime())) {
        pieces.push(`Resets at: ${date.toISOString().replace('.000Z', 'Z')}.`);
      }
    }
    if (pieces.length === 0) return null;
    return `Usage limit exceeded. ${pieces.join(' ')}`;
  } catch {
    return null;
  }
}

function isPaymentRequiredError(errorStr: string): boolean {
  return (errorStr.includes('402') && errorStr.includes('payment required'))
    || errorStr.includes('insufficient tokens');
}

function isAccountInactiveBillingError(errorStr: string): boolean {
  return errorStr.includes('account is not active') && errorStr.includes('billing');
}

function isInterpreterHostedProvider(provider?: string): boolean {
  return provider === 'hosted' || provider === 'interpreter';
}

function isInterpreterHostedAccountInactiveMessage(errorStr: string): boolean {
  return errorStr === INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE.toLowerCase();
}

function isInterpreterHostedOverloadedMessage(errorStr: string): boolean {
  return errorStr === INTERPRETER_HOSTED_OVERLOADED_MESSAGE.toLowerCase();
}

function isUnsupportedResponsesEndpointError(errorStr: string): boolean {
  return errorStr.includes('does not support the openai responses api')
    || errorStr.includes('may not support the openai responses api')
    || (
      errorStr.includes('validation errors')
      && (
        errorStr.includes("'loc': ('body', 'input', 'str')")
        || errorStr.includes("'loc': ['body', 'input', 'str']")
        || errorStr.includes('"loc": ["body", "input", "str"]')
        || errorStr.includes('"loc":["body","input","str"]')
      )
      && (
        errorStr.includes('input should be a valid string')
        || errorStr.includes('input should be a valid dictionary')
        || errorStr.includes('input should be a valid object')
      )
    )
    || (
      errorStr.includes('unexpected status 404')
      && errorStr.includes('/responses')
      && errorStr.includes('not found')
    );
}

function isKnownFreshThreadRequiredError(errorStr: string): boolean {
  return errorStr.includes('array_above_max_length')
    || (errorStr.includes('invalid \'input[') && errorStr.includes('.content'))
    || (errorStr.includes('expected an array with maximum length 0') && errorStr.includes('got an array with length 1'));
}

function isContentFilterError(errorStr: string): boolean {
  return errorStr.includes('content filtering')
    || errorStr.includes('content filter')
    || errorStr.includes('output blocked')
    || errorStr.includes('blocked by content')
    || errorStr.includes('safety policy');
}

function hasExplicitUserCreditsExhaustedSignal(errorStr: string): boolean {
  return errorStr.includes('user_credits_exhausted')
    || errorStr.includes('[not_enough_tokens]')
    || errorStr.includes('insufficient interpreter token');
}

export type InterpreterPlanStatus = 'free' | 'paid' | 'unknown';

function resolveInterpreterPlanStatus(isPaidPlan?: boolean | null): InterpreterPlanStatus {
  if (isPaidPlan === true) return 'paid';
  if (isPaidPlan === false) return 'free';
  return 'unknown';
}

export function buildInterpreterCreditsExhaustedMessage(
  planStatus: InterpreterPlanStatus = 'unknown',
  usageRefreshDate?: string | null,
): string {
  switch (planStatus) {
    case 'free':
      return tr('threadError.interpreterCreditsExhausted.freeMessage');
    case 'paid':
      return usageRefreshDate
        ? tr('threadError.interpreterCreditsExhausted.paidMessageWithRefresh', { date: usageRefreshDate })
        : tr('threadError.interpreterCreditsExhausted.paidMessage');
    default:
      return tr('threadError.interpreterCreditsExhausted.unknownMessage');
  }
}

export function buildInterpreterCreditsExhaustedSuggestion(
  _planStatus: InterpreterPlanStatus = 'unknown',
): string {
  return tr('threadError.interpreterCreditsExhausted.suggestion');
}

function interpreterCreditsExhaustedError(isPaidPlan?: boolean | null): ParsedThreadError {
  const planStatus = resolveInterpreterPlanStatus(isPaidPlan);
  return {
    type: 'interpreter_credits_exhausted',
    title: tr('threadError.interpreterCreditsExhausted.title'),
    message: buildInterpreterCreditsExhaustedMessage(planStatus),
    suggestion: buildInterpreterCreditsExhaustedSuggestion(planStatus),
  };
}

function formatInterpreterUsageRefreshDate(rawDate: string | null | undefined): string | null {
  if (!rawDate) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(i18n.language || 'en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function providerPaymentRequiredError(provider?: string): ParsedThreadError {
  if (!provider) {
    return {
      type: 'provider_error',
      title: tr('threadError.providerPayment.genericTitle'),
      message: tr('threadError.providerPayment.genericMessage'),
      suggestion: tr('threadError.providerPayment.genericSuggestion'),
    };
  }

  const name = providerDisplayName(provider);
  return {
    type: 'provider_error',
    title: tr('threadError.providerPayment.providerTitle', { provider: name }),
    message: tr('threadError.providerPayment.providerMessage', { provider: name }),
    suggestion: tr('threadError.providerPayment.providerSuggestion', { provider: name }),
  };
}

function providerAccountInactiveBillingError(provider?: string): ParsedThreadError | null {
  if (provider !== 'hosted' && provider !== 'interpreter') {
    return null;
  }

  return {
    type: 'service_unavailable',
    title: tr('threadError.hostedUnavailable.title'),
    message: tr('threadError.hostedUnavailable.accountInactiveMessage'),
    suggestion: tr('threadError.hostedUnavailable.suggestion'),
  };
}

function interpreterHostedHighDemandError(): ParsedThreadError {
  return {
    type: 'service_unavailable',
    title: tr('threadError.hostedUnavailable.title'),
    message: tr('threadError.hostedUnavailable.overloadedMessage'),
    suggestion: tr('threadError.hostedUnavailable.suggestion'),
  };
}

function providerUsageLimitError(provider?: string, detailedMessage?: string | null): ParsedThreadError {
  const displayMessage = provider === 'openai-oauth'
    && detailedMessage
    && isChatGptUsageLimitSentence(detailedMessage)
    ? formatChatGptUsageLimitMessage(detailedMessage)
    : detailedMessage;

  if (!provider) {
    return {
      type: 'provider_usage_limit',
      title: tr('threadError.providerUsageLimit.genericTitle'),
      message: displayMessage ?? tr('threadError.providerUsageLimit.genericMessage'),
      suggestion: tr('threadError.providerUsageLimit.genericSuggestion'),
    };
  }

  const name = providerDisplayName(provider);
  return {
    type: 'provider_usage_limit',
    title: tr('threadError.providerUsageLimit.providerTitle', { provider: name }),
    message: displayMessage ?? tr('threadError.providerUsageLimit.providerMessage', { provider: name }),
    suggestion: providerUsageLimitSuggestion(provider, name),
  };
}

function providerUsageLimitSuggestion(provider: string, name: string): string {
  if (provider === 'hosted' || provider === 'interpreter') {
    return tr('threadError.providerUsageLimit.hostedSuggestion', { provider: name });
  }
  return tr('threadError.providerUsageLimit.providerSuggestion', { provider: name });
}

function providerContentFilterError(provider?: string): Pick<ParsedThreadError, 'type' | 'title'> {
  if (!provider) {
    return {
      type: 'content_filter',
      title: tr('threadError.contentFilter.genericTitle'),
    };
  }

  const name = providerDisplayName(provider);
  return {
    type: 'content_filter',
    title: tr('threadError.contentFilter.providerTitle', { provider: name }),
  };
}

function providerAuthTitle(provider?: string): string {
  if (!provider) {
    return tr('threadError.auth.genericTitle');
  }
  return tr('threadError.auth.providerTitle', { provider: providerDisplayName(provider) });
}

function providerAuthSuggestion(provider?: string): string {
  switch (provider) {
    case 'openai-oauth':
      return tr('threadError.auth.chatGptSuggestion');
    case 'claude-oauth':
      return tr('threadError.auth.claudeSuggestion');
    case 'hosted':
      return tr('threadError.auth.hostedSuggestion');
    default:
      return tr('threadError.auth.genericSuggestion');
  }
}

function providerNotConnectedTitle(provider?: string): string {
  if (!provider) {
    return tr('threadError.providerNotConnected.genericTitle');
  }
  return tr('threadError.providerNotConnected.providerTitle', { provider: providerDisplayName(provider) });
}

function providerRateLimitTitle(provider?: string): string {
  if (!provider) {
    return tr('threadError.rateLimit.genericTitle');
  }
  return tr('threadError.rateLimit.providerTitle', { provider: providerDisplayName(provider) });
}

type LocalRuntime = 'ollama' | 'lmstudio';
type ServiceUnavailableRuntime = LocalRuntime | 'local' | 'hosted';

function serviceUnavailableError(runtime: ServiceUnavailableRuntime): ParsedThreadError {
  switch (runtime) {
    case 'ollama':
      return {
        type: 'service_unavailable',
        title: tr('threadError.serviceUnavailable.ollamaTitle'),
        message: tr('threadError.serviceUnavailable.ollamaMessage'),
        suggestion: tr('threadError.serviceUnavailable.ollamaSuggestion'),
      };
    case 'lmstudio':
      return {
        type: 'service_unavailable',
        title: tr('threadError.serviceUnavailable.lmStudioTitle'),
        message: tr('threadError.serviceUnavailable.lmStudioMessage'),
        suggestion: tr('threadError.serviceUnavailable.lmStudioSuggestion'),
      };
    case 'local':
      return {
        type: 'service_unavailable',
        title: tr('threadError.serviceUnavailable.localTitle'),
        message: tr('threadError.serviceUnavailable.localMessage'),
        suggestion: tr('threadError.serviceUnavailable.localSuggestion'),
      };
    case 'hosted':
      return {
        type: 'service_unavailable',
        title: tr('threadError.serviceUnavailable.hostedTitle'),
        message: tr('threadError.serviceUnavailable.hostedMessage'),
        suggestion: tr('threadError.serviceUnavailable.hostedSuggestion'),
      };
  }
}

function isLocalRuntime(provider?: string): provider is LocalRuntime {
  return provider === 'ollama' || provider === 'lmstudio';
}

function detectLocalRuntimeFromSignals(signals: string): LocalRuntime | null {
  if (signals.includes(':11434')) {
    return 'ollama';
  }
  if (signals.includes(':1234')) {
    return 'lmstudio';
  }
  return null;
}

function resolveServiceUnavailableRuntime(
  provider: string | undefined,
  detectedRuntime: LocalRuntime | null,
): ServiceUnavailableRuntime {
  if (isLocalRuntime(provider)) return provider;
  if (provider === 'local') return detectedRuntime ?? 'local';
  return detectedRuntime ?? 'hosted';
}

function providerServiceUnavailableError(
  provider: string | undefined,
  errorStr: string,
  requestEndpointBaseUrl?: string | null,
): ParsedThreadError {
  const localSignals = `${errorStr} ${requestEndpointBaseUrl ?? ''}`.toLowerCase();
  const detectedRuntime = detectLocalRuntimeFromSignals(localSignals);
  const runtime = resolveServiceUnavailableRuntime(provider, detectedRuntime);
  return serviceUnavailableError(runtime);
}

function providerDisplayName(provider?: string): string {
  switch (provider) {
    case 'openai-oauth': return 'ChatGPT';
    case 'claude-oauth': return 'Claude';
    case 'hosted': return 'Interpreter';
    case 'interpreter': return 'Interpreter';
    case 'groq': return 'Groq';
    case 'lmstudio': return 'LM Studio';
    case 'ollama': return 'Ollama';
    case 'openrouter': return 'OpenRouter';
    case 'local': return tr('threadError.provider.localModel');
    case 'api': return tr('threadError.provider.apiProvider');
    case 'agent': return tr('threadError.provider.agent');
    case 'terminal': return tr('threadError.provider.terminalModel');
    default: return provider ?? tr('threadError.provider.generic');
  }
}

function providerModelNoToolsMessage(provider?: string): string {
  switch (provider) {
    case 'hosted':
    case 'interpreter':
      return tr('threadError.modelNoTools.interpreterMessage');
    case 'openrouter':
      return tr('threadError.modelNoTools.openRouterMessage');
    default: {
      const name = providerDisplayName(provider);
      return tr('threadError.modelNoTools.providerMessage', { provider: name });
    }
  }
}

function providerModelNoImagesMessage(provider?: string): string {
  switch (provider) {
    case 'hosted':
    case 'interpreter':
      return tr('threadError.modelNoImages.interpreterMessage');
    case 'openrouter':
      return tr('threadError.modelNoImages.openRouterMessage');
    default: {
      const name = providerDisplayName(provider);
      return tr('threadError.modelNoImages.providerMessage', { provider: name });
    }
  }
}

function invalidModelSuggestion(provider?: string): string {
  switch (provider) {
    case 'hosted':
      return tr('threadError.invalidModel.hostedSuggestion');
    case 'openrouter':
      return tr('threadError.invalidModel.openRouterSuggestion');
    case 'api':
      return tr('threadError.invalidModel.apiSuggestion');
    case 'ollama':
      return tr('threadError.invalidModel.ollamaSuggestion');
    case 'lmstudio':
      return tr('threadError.invalidModel.lmStudioSuggestion');
    default: {
      const name = providerDisplayName(provider);
      return tr('threadError.invalidModel.providerSuggestion', { provider: name });
    }
  }
}

export type ThreadErrorType =
  | 'acp_not_available'
  | 'auth'
  | 'chatgpt_session_expired'
  | 'claude_code_not_installed'
  | 'content_filter'
  | 'context_overflow'
  | 'encrypted_content_invalid'
  | 'fresh_thread_required'
  | 'interpreter_credits_exhausted'
  | 'invalid_model'
  | 'lmstudio_backend_error'
  | 'lmstudio_no_models'
  | 'lmstudio_not_running'
  | 'local_context_too_small'
  | 'local_model_no_tools'
  | 'local_runtime_outdated'
  | 'network'
  | 'ollama_model_missing'
  | 'ollama_not_running'
  | 'provider_stream_disconnected'
  | 'provider_error'
  | 'provider_usage_limit'
  | 'model_no_images'
  | 'model_no_tools'
  | 'responses_contract_incompatible'
  | 'rate_limit'
  | 'server'
  | 'service_unavailable'
  | 'session_expired'
  | 'unsupported_responses_endpoint'
  | 'unknown';

export interface ParsedThreadError {
  type: ThreadErrorType;
  title: string;
  message: string;
  suggestion: string;
}

export function parseError(
  rawError: string | object | null,
  provider?: string,
  errorDetails?: string | null,
  isPaidPlan?: boolean | null,
  requestEndpointBaseUrl?: string | null,
): ParsedThreadError {
  const rawErrorStr = typeof rawError === 'string' ? rawError.toLowerCase() : JSON.stringify(rawError).toLowerCase();
  const rawErrorMessage = extractRawErrorMessage(rawError);
  const responsesContractError = getResponsesToolCallingContractError(
    rawErrorMessage,
    errorDetails,
  ) ?? (
    rawErrorMessage === OPENAI_CUSTOM_TOOL_MODEL_MESSAGE ||
    rawErrorMessage === TOOL_USE_ROUTE_UNAVAILABLE_MESSAGE
      ? rawErrorMessage
      : null
  );
  const unsupportedImageInputError = getUnsupportedImageInputError(
    rawErrorMessage,
    errorDetails,
  ) ?? (
    rawErrorMessage === IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE
      ? rawErrorMessage
      : null
  );
  const hasExplicitUserCreditsSignal = hasExplicitUserCreditsExhaustedSignal(rawErrorStr);
  const usageLimitTimingMessage = extractTimingFromDetails(errorDetails) ?? extractDetailedUsageLimitMessage(rawError);
  if (rawError && typeof rawError === 'object') {
    const obj = rawError as Record<string, any>;
    const status = obj.status ?? obj.statusCode ?? obj.code;
    const errorType = obj.type ?? obj.error_type;

    if (typeof status === 'number') {
      if (status === 402) {
        if (!hasExplicitUserCreditsSignal) {
          return providerPaymentRequiredError(provider);
        }
        return interpreterCreditsExhaustedError(isPaidPlan);
      }
      if (status === 429) return { type: 'rate_limit', title: providerRateLimitTitle(provider), message: tr('threadError.rateLimit.message'), suggestion: tr('threadError.rateLimit.suggestion') };
      if (status === 401 || status === 403) return { type: 'auth', title: providerAuthTitle(provider), message: tr('threadError.auth.message'), suggestion: providerAuthSuggestion(provider) };
      if (status === 503) return providerServiceUnavailableError(provider, rawErrorStr, requestEndpointBaseUrl);
      if (status >= 500 && status < 600) return { type: 'server', title: tr('threadError.server.title'), message: tr('threadError.server.message'), suggestion: tr('threadError.server.suggestion') };
    }
    if (typeof errorType === 'string') {
      const et = errorType.toLowerCase();
      if (et === 'user_credits_exhausted' || (et === 'payment_required' && hasExplicitUserCreditsSignal)) {
        return interpreterCreditsExhaustedError(isPaidPlan);
      }
      if (et === 'payment_required') {
        return providerPaymentRequiredError(provider);
      }
      if (et === 'rate_limit_error' || et === 'rate_limit') return { type: 'rate_limit', title: providerRateLimitTitle(provider), message: tr('threadError.rateLimit.message'), suggestion: tr('threadError.rateLimit.suggestion') };
      if (et === 'authentication_error' || et === 'unauthorized') return { type: 'auth', title: providerAuthTitle(provider), message: tr('threadError.auth.message'), suggestion: providerAuthSuggestion(provider) };
      if (et === 'server_error' || et === 'internal_server_error') return { type: 'server', title: tr('threadError.server.title'), message: tr('threadError.server.message'), suggestion: tr('threadError.server.suggestion') };
    }
  }

  const errorStr = rawErrorStr;

  if (typeof rawError === 'string' && isLocalRuntimeUpdateMessage(rawError)) {
    const runtimeName = rawError.includes('LM Studio') ? 'LM Studio' : 'Ollama';
    return {
      type: 'local_runtime_outdated',
      title: tr('threadError.localRuntimeOutdated.title', { runtime: runtimeName }),
      message: rawError,
      suggestion: tr('threadError.localRuntimeOutdated.suggestion', { runtime: runtimeName }),
    };
  }
  if (errorStr.includes('encrypted content is invalid') || errorStr.includes('invalid_encrypted_content') || errorStr.includes('organization mismatch')) {
    const name = providerDisplayName(provider);
    return {
      type: 'encrypted_content_invalid',
      title: tr('threadError.encryptedContentInvalid.title'),
      message: tr('threadError.encryptedContentInvalid.message', { provider: name }),
      suggestion: tr('threadError.encryptedContentInvalid.suggestion'),
    };
  }
  if (errorStr.includes('failed to load') && (errorStr.includes('llm_engine') || errorStr.includes('dlopen') || errorStr.includes('library not loaded'))) {
    return {
      type: 'lmstudio_backend_error',
      title: tr('threadError.lmStudioBackend.title'),
      message: tr('threadError.lmStudioBackend.message'),
      suggestion: tr('threadError.lmStudioBackend.suggestion'),
    };
  }
  if (errorStr.includes('no models loaded') || (errorStr.includes('no models') && errorStr.includes('lms load'))) {
    return {
      type: 'lmstudio_no_models',
      title: tr('threadError.lmStudioNoModels.title'),
      message: tr('threadError.lmStudioNoModels.message'),
      suggestion: tr('threadError.lmStudioNoModels.suggestion'),
    };
  }
  if (errorStr.includes('claude') && (errorStr.includes('not installed') || errorStr.includes('spawn') || errorStr.includes('enoent'))) {
    return { type: 'claude_code_not_installed', title: tr('threadError.claudeCodeNotInstalled.title'), message: tr('threadError.claudeCodeNotInstalled.message'), suggestion: tr('threadError.claudeCodeNotInstalled.suggestion') };
  }
  if (errorStr.includes('acp') && (errorStr.includes('spawn') || errorStr.includes('enoent'))) {
    return { type: 'acp_not_available', title: tr('threadError.acpNotAvailable.title'), message: tr('threadError.acpNotAvailable.message'), suggestion: tr('threadError.acpNotAvailable.suggestion') };
  }
  if (isLmStudioNotRunningError(errorStr, provider)) {
    return {
      type: 'lmstudio_not_running',
      title: tr('threadError.lmStudioNotRunning.title'),
      message: tr('threadError.lmStudioNotRunning.message'),
      suggestion: tr('threadError.lmStudioNotRunning.suggestion'),
    };
  }
  if (isOllamaNotRunningError(errorStr, provider) || (errorStr.includes('econnrefused') && errorStr.includes('11434')) || (errorStr.includes('ollama') && errorStr.includes('not running'))) {
    return {
      type: 'ollama_not_running',
      title: tr('threadError.ollamaNotRunning.title'),
      message: tr('threadError.ollamaNotRunning.message'),
      suggestion: tr('threadError.ollamaNotRunning.suggestion'),
    };
  }
  if (isLocalModelNoToolsError(errorStr)) {
    return {
      type: 'local_model_no_tools',
      title: tr('threadError.modelNoTools.title'),
      message: extractRawErrorMessage(rawError) ?? tr('threadError.localModelNoTools.message'),
      suggestion: tr('threadError.localModelNoTools.suggestion'),
    };
  }
  if (
    errorStr.includes('no endpoints found for')
    || errorStr.includes('does not exist or you do not have access')
  ) {
    const name = providerDisplayName(provider);
    return {
      type: 'invalid_model',
      title: tr('threadError.invalidModel.title', { provider: name }),
      message: extractRawErrorMessage(rawError) ?? tr('threadError.invalidModel.message', { provider: name }),
      suggestion: invalidModelSuggestion(provider),
    };
  }
  if (responsesContractError === TOOL_USE_ROUTE_UNAVAILABLE_MESSAGE) {
    return {
      type: 'model_no_tools',
      title: tr('threadError.modelNoTools.title'),
      message: providerModelNoToolsMessage(provider),
      suggestion: tr('threadError.modelCapabilitySuggestion'),
    };
  }
  if (unsupportedImageInputError) {
    return {
      type: 'model_no_images',
      title: tr('threadError.modelNoImages.title'),
      message: providerModelNoImagesMessage(provider),
      suggestion: tr('threadError.modelCapabilitySuggestion'),
    };
  }
  if (responsesContractError && requestEndpointBaseUrl && isUnsupportedResponsesEndpointError(errorStr)) {
    return {
      type: 'unsupported_responses_endpoint',
      title: tr('threadError.unsupportedResponsesEndpoint.title'),
      message: buildUnsupportedResponsesEndpointMessage(requestEndpointBaseUrl),
      suggestion: tr('threadError.unsupportedResponsesEndpoint.suggestion'),
    };
  }
  if (responsesContractError) {
    return responsesContractIncompatibleError(responsesContractError, requestEndpointBaseUrl);
  }
  if (isLocalModelMissingError(errorStr)) {
    return {
      type: 'ollama_model_missing',
      title: tr('threadError.modelMissing.title'),
      message: extractRawErrorMessage(rawError) ?? tr('threadError.modelMissing.message'),
      suggestion: tr('threadError.modelMissing.suggestion'),
    };
  }
  if (errorStr.includes('not connected') && (
    errorStr.includes('openai') ||
    errorStr.includes('claude') ||
    errorStr.includes('oauth') ||
    errorStr.includes('provider')
  )) {
    return {
      type: 'auth',
      title: providerNotConnectedTitle(provider),
      message: typeof rawError === 'string' ? rawError : tr('threadError.providerNotConnected.message'),
      suggestion: tr('threadError.providerNotConnected.suggestion'),
    };
  }
  if (errorStr.includes('session expired') || errorStr.includes('session is invalid') || errorStr.includes('session is no longer valid')
    || (errorStr.includes('session') && (errorStr.includes('does not exist') || errorStr.includes('expired') || errorStr.includes('invalid')))
    || (errorStr.includes('jwt') && (errorStr.includes('expired') || errorStr.includes('invalid') || errorStr.includes('does not exist')))) {
    return { type: 'session_expired', title: tr('threadError.sessionExpired.title'), message: tr('threadError.sessionExpired.message'), suggestion: tr('threadError.sessionExpired.suggestion') };
  }
  if ((errorStr.includes('refresh token') && (
    errorStr.includes('revoked') || errorStr.includes('invalidated') || errorStr.includes('reused')
    || errorStr.includes('already been used') || errorStr.includes('already used')
  )) || errorStr.includes('could not be refreshed')) {
    const name = providerDisplayName(provider);
    return { type: 'chatgpt_session_expired', title: tr('threadError.chatGptSessionExpired.title', { provider: name }), message: tr('threadError.chatGptSessionExpired.message', { provider: name }), suggestion: tr('threadError.chatGptSessionExpired.suggestion') };
  }
  if (errorStr.includes('codex app-server exited') && (
    errorStr.includes('unauthorized') || errorStr.includes('token has been invalidated')
    || errorStr.includes('refresh_token_invalidated') || errorStr.includes('refresh_token_reused')
    || errorStr.includes('signing in again')
    || (errorStr.includes('403 forbidden') && errorStr.includes('backend-api/codex/responses'))
  )) {
    const name = providerDisplayName(provider);
    return { type: 'chatgpt_session_expired', title: tr('threadError.chatGptSessionExpired.title', { provider: name }), message: tr('threadError.chatGptSessionExpired.message', { provider: name }), suggestion: tr('threadError.chatGptSessionExpired.suggestion') };
  }
  if (errorStr.includes('unauthorized') || errorStr.includes('authentication') || errorStr.includes('sign in')) {
    return { type: 'auth', title: providerAuthTitle(provider), message: tr('threadError.auth.message'), suggestion: providerAuthSuggestion(provider) };
  }
  if (hasExplicitUserCreditsSignal) {
    return interpreterCreditsExhaustedError(isPaidPlan);
  }
  if (
    isAccountInactiveBillingError(errorStr) ||
    isInterpreterHostedAccountInactiveMessage(errorStr)
  ) {
    const accountInactiveBillingError = providerAccountInactiveBillingError(provider);
    if (accountInactiveBillingError) {
      return accountInactiveBillingError;
    }
  }
  if (
    isInterpreterHostedOverloadedMessage(errorStr) ||
    (isInterpreterHostedProvider(provider) && isHostedHighDemandMessage(errorStr))
  ) {
    return interpreterHostedHighDemandError();
  }
  if (isPaymentRequiredError(errorStr)) {
    return providerPaymentRequiredError(provider);
  }
  if (isUnsupportedResponsesEndpointError(errorStr)) {
    return {
      type: 'unsupported_responses_endpoint',
      title: tr('threadError.unsupportedResponsesEndpoint.title'),
      message: buildUnsupportedResponsesEndpointMessage(requestEndpointBaseUrl),
      suggestion: tr('threadError.unsupportedResponsesEndpoint.suggestion'),
    };
  }
  if (isKnownFreshThreadRequiredError(errorStr)) {
    return {
      type: 'fresh_thread_required',
      title: tr('threadError.freshThreadRequired.title'),
      message: tr('threadError.freshThreadRequired.message'),
      suggestion: tr('threadError.freshThreadRequired.suggestion'),
    };
  }
  if (isUsageLimitError(errorStr)) {
    return providerUsageLimitError(provider, usageLimitTimingMessage);
  }
  if (isProviderStreamDisconnected(errorStr, provider)) {
    return {
      type: 'provider_stream_disconnected',
      title: tr('threadError.providerStreamDisconnected.title'),
      message: tr('threadError.providerStreamDisconnected.message'),
      suggestion: tr('threadError.providerStreamDisconnected.suggestion'),
    };
  }
  if (isContentFilterError(errorStr)) {
    const contentFilterError = providerContentFilterError(provider);
    return {
      ...contentFilterError,
      message: typeof rawError === 'string' ? rawError : tr('threadError.contentFilter.message'),
      suggestion: tr('threadError.contentFilter.suggestion'),
    };
  }
  if (errorStr.includes('rate limit') || /\b429\b/.test(errorStr)) {
    return { type: 'rate_limit', title: providerRateLimitTitle(provider), message: tr('threadError.rateLimit.message'), suggestion: tr('threadError.rateLimit.suggestion') };
  }
  if (errorStr.includes('network') || errorStr.includes('failed to fetch') || errorStr.includes('fetch failed') || errorStr.includes('fetch error') || errorStr.includes('timeout')) {
    return { type: 'network', title: tr('threadError.network.title'), message: tr('threadError.network.message'), suggestion: tr('threadError.network.suggestion') };
  }
  if (/\b503\b/.test(errorStr) || errorStr.includes('service unavailable') || errorStr.includes('temporarily unavailable')) {
    return providerServiceUnavailableError(provider, errorStr, requestEndpointBaseUrl);
  }
  if ((/\b5\d{2}\b/.test(errorStr) && /\b(status|http|server|error|code|unavailable|service)\b/.test(errorStr)) || errorStr.includes('server error') || errorStr.includes('internal server error') || errorStr.includes('internal error')) {
    return { type: 'server', title: tr('threadError.server.title'), message: tr('threadError.server.message'), suggestion: tr('threadError.server.suggestion') };
  }
  if (
    isLocalContextTooSmallError(errorStr)
    || isLikelyLocalContextOverflow(errorStr, provider)
    || (isLocalProvider(provider) && isGenericContextOverflowError(errorStr))
  ) {
    return {
      type: 'local_context_too_small',
      title: tr('threadError.localContextTooSmall.title'),
      message: localContextTooSmallMessage(rawError, provider),
      suggestion: localContextTooSmallSuggestion(provider),
    };
  }
  if (isGenericContextOverflowError(errorStr)) {
    return {
      type: 'context_overflow',
      title: tr('threadError.contextOverflow.title'),
      message: typeof rawError === 'string' ? rawError : tr('threadError.contextOverflow.message'),
      suggestion: tr('threadError.contextOverflow.suggestion'),
    };
  }
  if (errorStr.includes('provider returned error') || errorStr.includes('provider_name')) {
    return {
      type: 'provider_error',
      title: tr('threadError.providerError.title'),
      message: extractRawErrorMessage(rawError) ?? tr('threadError.providerError.message'),
      suggestion: tr('threadError.providerError.suggestion'),
    };
  }
  if (errorStr.includes('anthropic') || errorStr.includes('openai') || errorStr.includes('groq')) {
    if (!errorStr.includes('not connected') && !errorStr.includes('sign in') && !errorStr.includes('unauthorized')) {
      return {
        type: 'provider_error',
        title: tr('threadError.providerError.title'),
        message: typeof rawError === 'string' ? rawError : tr('threadError.providerError.message'),
        suggestion: tr('threadError.providerError.suggestion'),
      };
    }
  }
  if (errorStr.includes('not a valid model') || errorStr.includes('invalid model')) {
    const name = providerDisplayName(provider);
    return {
      type: 'invalid_model',
      title: tr('threadError.invalidModel.title', { provider: name }),
      message: extractRawErrorMessage(rawError) ?? tr('threadError.invalidModel.message', { provider: name }),
      suggestion: invalidModelSuggestion(provider),
    };
  }
  return {
    type: 'unknown',
    title: tr('threadError.unknown.title'),
    message: extractRawErrorMessage(rawError) ?? tr('threadError.unknown.message'),
    suggestion: tr('threadError.unknown.suggestion'),
  };
}

interface ErrorAction {
  label: string;
  onClick: () => void;
  tooltip?: string;
  variant?: NonNullable<ComponentProps<typeof Button>['variant']>;
}

interface ThreadErrorDisplayProps {
  title: string;
  message: string;
  suggestion?: string;
  actions?: ErrorAction[];
  showReportBug?: boolean;
  profileSwitchWarning?: boolean;
}

export const ThreadErrorDisplay: FC<ThreadErrorDisplayProps> = ({
  title,
  message,
  suggestion,
  actions,
  showReportBug = true,
  profileSwitchWarning = false,
}) => {
  return (
    <div
      className="mx-auto w-full max-w-[var(--thread-max-width)]"
      style={{ padding: 'var(--unit-padding-medium) 0' }}
      data-testid={ERROR_MESSAGE_ID}
    >
      <div
        className="px-0 py-3.5"
        style={{
          borderTop: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)',
          borderBottom: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)',
        }}
      >
        <p className="cursor-text select-text text-ui-sm font-medium text-[var(--oa-text-strong)]">
          {title}
        </p>
        <p
          className="mt-2 cursor-text select-text break-words whitespace-pre-wrap text-ui-sm leading-6 text-[var(--oa-text)]"
          style={{ overflowWrap: 'anywhere' }}
        >
          {renderTextWithClickableLinks(message)}
        </p>
        {suggestion && (
          <p
            className="mt-2 cursor-text select-text break-words whitespace-pre-wrap text-ui-sm leading-6 text-[var(--oa-text-muted)]"
            style={{ overflowWrap: 'anywhere' }}
        >
          {renderTextWithClickableLinks(suggestion)}
          </p>
        )}
        {profileSwitchWarning && (
          <p
            className="mt-2 cursor-text select-text break-words whitespace-pre-wrap text-ui-sm leading-6 text-[var(--oa-text-muted)]"
            style={{ overflowWrap: 'anywhere' }}
          >
            {tr('threadError.profileSwitchWarning')}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {showReportBug && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => openFeedbackPopover()}
                  variant="default"
                  size="sm"
                  title={tr('threadError.action.reportBugTooltip')}
                  data-help-title={tr('threadError.action.reportBug')}
                  data-help-description={tr('threadError.action.reportBugTooltip')}
                >
                  {tr('threadError.action.reportBug')}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {tr('threadError.action.reportBugTooltip')}
              </TooltipContent>
            </Tooltip>
          )}
          {actions?.map((action) => (
            <Tooltip key={action.label}>
              <TooltipTrigger asChild>
                <Button
                  onClick={action.onClick}
                  variant={action.variant ?? 'secondary'}
                  size="sm"
                  title={action.tooltip ?? action.label}
                  data-help-title={action.label}
                  data-help-description={action.tooltip ?? action.label}
                >
                  {action.label}
                </Button>
              </TooltipTrigger>
              {action.tooltip && (
                <TooltipContent side="top">
                  {action.tooltip}
                </TooltipContent>
              )}
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );
};

interface ThreadErrorWithLayoutProps {
  rawError: string | object | null;
  errorDetails?: string | null;
  requestEndpointBaseUrl?: string | null;
  openSettings?: (workspace?: undefined, tab?: string) => void;
  onStartNewChatWithHistory?: () => void;
  onRetry?: () => void;
  showProfileSwitchWarning?: boolean;
  providerLabel?: string;
}

const PROFILE_SWITCH_WARNING_TYPES = new Set<ThreadErrorType>([
  'fresh_thread_required',
]);

export function shouldShowProfileSwitchWarning(
  showProfileSwitchWarning: boolean,
  errorType: ThreadErrorType,
): boolean {
  return showProfileSwitchWarning && PROFILE_SWITCH_WARNING_TYPES.has(errorType);
}

export const ThreadErrorWithLayout: FC<ThreadErrorWithLayoutProps> = ({
  rawError,
  errorDetails,
  requestEndpointBaseUrl,
  openSettings,
  onStartNewChatWithHistory,
  onRetry,
  showProfileSwitchWarning = false,
  providerLabel,
}) => {
  const { isPaid, loading: paidPlanLoading, subscription } = usePaidPlanStatus();
  const parsedError = useMemo(
    () => (
      rawError
        ? parseError(
          rawError,
          providerLabel,
          errorDetails,
          paidPlanLoading ? null : isPaid,
          requestEndpointBaseUrl,
        )
        : null
    ),
    [rawError, providerLabel, errorDetails, paidPlanLoading, isPaid, requestEndpointBaseUrl],
  );
  const usageRefreshDate = useMemo(
    () => (isPaid ? formatInterpreterUsageRefreshDate(subscription?.current_period_end) : null),
    [isPaid, subscription?.current_period_end],
  );

  if (!parsedError) return null;
  const resolvedError = parsedError.type === 'interpreter_credits_exhausted' && isPaid
    ? {
      ...parsedError,
      message: buildInterpreterCreditsExhaustedMessage('paid', usageRefreshDate),
    }
    : parsedError;
  const { type, title, message, suggestion } = resolvedError;
  const profileSwitchWarning = shouldShowProfileSwitchWarning(showProfileSwitchWarning, type);

  const actions: ErrorAction[] = [];

  if (onRetry) {
    actions.push({
      label: tr('threadError.action.retry'),
      onClick: onRetry,
      tooltip: tr('threadError.action.retryTooltip'),
      variant: 'default',
    });
  }
  if (onStartNewChatWithHistory) {
    actions.push({
      label: tr('threadError.action.newChatWithHistory'),
      onClick: onStartNewChatWithHistory,
      tooltip: tr('threadError.action.newChatWithHistoryTooltip'),
      variant: 'secondary',
    });
  }

  switch (type) {
    case 'ollama_not_running':
      actions.push({ label: tr('threadError.action.installOllama'), onClick: () => window.open('https://ollama.com', '_blank') });
      if (openSettings) actions.push({ label: tr('threadError.action.openSettings'), onClick: () => openSettings() });
      break;
    case 'local_runtime_outdated':
      if (openSettings) actions.push({ label: tr('threadError.action.openProfiles'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'ollama_model_missing':
    case 'local_model_no_tools':
    case 'model_no_images':
    case 'model_no_tools':
    case 'lmstudio_backend_error':
    case 'responses_contract_incompatible':
      if (openSettings) actions.push({ label: tr('threadError.action.openProfiles'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'lmstudio_no_models':
    case 'lmstudio_not_running':
      if (openSettings) actions.push({ label: tr('threadError.action.openSettings'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'claude_code_not_installed':
      if (openSettings) actions.push({ label: tr('threadError.action.setupClaudeCode'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'acp_not_available':
      if (openSettings) actions.push({ label: tr('threadError.action.setupProvider'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'session_expired':
      if (openSettings) actions.push({ label: tr('threadError.action.signOutAndSignIn'), onClick: () => openSettings(undefined, 'account') });
      break;
    case 'auth':
      if (openSettings) actions.push({ label: tr('threadError.action.signIn'), onClick: () => openSettings(undefined, 'account') });
      if (openSettings) actions.push({ label: tr('threadError.action.setupProvider'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'interpreter_credits_exhausted':
      if (openSettings) actions.push({ label: tr('threadError.action.upgradePlan'), onClick: () => openSettings(undefined, 'account') });
      if (openSettings) actions.push({ label: tr('threadError.action.useCustomProvider'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'provider_stream_disconnected':
      if (openSettings) actions.push({ label: tr('threadError.action.manageModel'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'provider_usage_limit':
    case 'chatgpt_session_expired':
      if (openSettings) actions.push({ label: tr('threadError.action.setupProvider'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'unsupported_responses_endpoint':
      if (openSettings) actions.push({ label: tr('threadError.action.openProfiles'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'local_context_too_small':
      if (openSettings) actions.push({ label: tr('threadError.action.modelSettings'), onClick: () => openSettings(undefined, 'providers') });
      if (openSettings) actions.push({ label: tr('threadError.action.toolsSettings'), onClick: () => openSettings(undefined, 'tools') });
      break;
    case 'invalid_model':
      if (openSettings) actions.push({ label: tr('threadError.action.manageModel'), onClick: () => openSettings(undefined, 'providers') });
      break;
    case 'service_unavailable':
    case 'context_overflow':
    case 'fresh_thread_required':
    case 'provider_error':
    case 'content_filter':
      break;
  }

  return (
    <ThreadErrorDisplay
      title={title}
      message={message}
      suggestion={suggestion}
      actions={actions}
      showReportBug={type !== 'session_expired' && type !== 'chatgpt_session_expired' && type !== 'interpreter_credits_exhausted' && type !== 'local_runtime_outdated'}
      profileSwitchWarning={profileSwitchWarning}
    />
  );
};
