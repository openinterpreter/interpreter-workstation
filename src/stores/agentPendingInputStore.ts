import type { MessageSendSource } from "../../shared/types/messageSendSource";
import type { WorkstationContext } from "../../shared/types/workstation";
import {
  extractSkillMentionsFromText,
  injectSkillMentionsIntoText,
} from "../../shared/utils/skillMentions";

type Listener = () => void;

export type AgentPendingInputStage =
  | "afterNextTool"
  | "endOfTurn"
  | "interrupting";

export type AgentPendingInputAfterNextToolState =
  | "local"
  | "submitting"
  | "submitted"
  | null;

/**
 * Pending agent-tab sends only capture text plus workstation context. They do
 * not carry image payloads, so overlay-originated image attachments must use a
 * direct send path instead of queue/after-next-tool/interrupt flows.
 */
export type AgentPendingInput = {
  id: string;
  agentId: string;
  draftText: string;
  previewText: string;
  messageText: string;
  afterNextToolState: AgentPendingInputAfterNextToolState;
  submittedText: string | null;
  workspacePath?: string | null;
  contextSnapshot: WorkstationContext | null;
  messageSource?: MessageSendSource | null;
  stage: AgentPendingInputStage;
  createdAt: number;
};

let pendingInputsByAgent = new Map<string, AgentPendingInput[]>();
const listeners = new Set<Listener>();
const EMPTY_AGENT_PENDING_INPUTS: AgentPendingInput[] = [];

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setAgentPendingInputs(
  agentId: string,
  nextInputs: AgentPendingInput[],
): void {
  const previousInputs = pendingInputsByAgent.get(agentId) ?? EMPTY_AGENT_PENDING_INPUTS;
  const changed =
    previousInputs.length !== nextInputs.length
    || previousInputs.some((input, index) => input !== nextInputs[index]);

  if (!changed) {
    return;
  }

  const nextMap = new Map(pendingInputsByAgent);
  if (nextInputs.length === 0) {
    nextMap.delete(agentId);
  } else {
    nextMap.set(agentId, nextInputs);
  }
  pendingInputsByAgent = nextMap;
  notify();
}

export function subscribeAgentPendingInputs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentPendingInputs(
  agentId?: string | null,
): AgentPendingInput[] {
  if (!agentId) {
    return EMPTY_AGENT_PENDING_INPUTS;
  }
  return pendingInputsByAgent.get(agentId) ?? EMPTY_AGENT_PENDING_INPUTS;
}

export function addAgentPendingInput(input: AgentPendingInput): void {
  setAgentPendingInputs(input.agentId, [
    ...getAgentPendingInputs(input.agentId),
    input,
  ]);
}

export function clearAgentPendingInputs(agentId?: string | null): void {
  if (!agentId || !pendingInputsByAgent.has(agentId)) {
    return;
  }
  setAgentPendingInputs(agentId, EMPTY_AGENT_PENDING_INPUTS);
}

export function updateAgentPendingInput(
  agentId: string,
  inputId: string,
  updater: (input: AgentPendingInput) => AgentPendingInput,
): AgentPendingInput | null {
  const inputs = getAgentPendingInputs(agentId);
  let updatedInput: AgentPendingInput | null = null;
  const nextInputs = inputs.map((input) => {
    if (input.id !== inputId) {
      return input;
    }
    updatedInput = updater(input);
    return updatedInput;
  });

  if (!updatedInput) {
    return null;
  }

  setAgentPendingInputs(agentId, nextInputs);
  return updatedInput;
}

export function updateAgentPendingInputs(
  agentId: string,
  updater: (inputs: AgentPendingInput[]) => AgentPendingInput[],
): AgentPendingInput[] {
  const nextInputs = updater(getAgentPendingInputs(agentId));
  setAgentPendingInputs(agentId, nextInputs);
  return nextInputs;
}

export function removeAgentPendingInput(
  agentId: string,
  inputId: string,
): AgentPendingInput | null {
  const inputs = getAgentPendingInputs(agentId);
  const removedInput = inputs.find((input) => input.id === inputId) ?? null;
  if (!removedInput) {
    return null;
  }

  setAgentPendingInputs(
    agentId,
    inputs.filter((input) => input.id !== inputId),
  );
  return removedInput;
}

export function getLatestPendingInputContextSnapshot(
  agentId: string,
): WorkstationContext | null {
  const inputs = getAgentPendingInputs(agentId);
  for (let index = inputs.length - 1; index >= 0; index -= 1) {
    const input = inputs[index];
    if (input?.contextSnapshot) {
      return input.contextSnapshot;
    }
  }
  return null;
}

export function findAgentPendingInputBySubmittedText(
  agentId: string,
  submittedText: string,
  stages?: AgentPendingInputStage[],
): AgentPendingInput | null {
  const allowedStages = stages ? new Set(stages) : null;
  const normalizedSubmittedText = normalizeAgentPendingInputSubmittedText(submittedText);
  return getAgentPendingInputs(agentId).find((input) => (
    input.submittedText !== null
    && normalizeAgentPendingInputSubmittedText(input.submittedText) === normalizedSubmittedText
    && (!allowedStages || allowedStages.has(input.stage))
  )) ?? null;
}

export function getNextDispatchableAgentPendingInput(
  agentId: string,
): AgentPendingInput | null {
  const inputs = getAgentPendingInputs(agentId);
  return inputs.find((input) => input.stage === "interrupting")
    ?? inputs.find((input) => input.stage === "endOfTurn")
    ?? null;
}

export function isAgentPendingInputSteerLocked(
  input: AgentPendingInput,
): boolean {
  return input.stage === "afterNextTool"
    && (input.afterNextToolState === "submitting" || input.afterNextToolState === "submitted");
}

export function resetAgentPendingInputStoreForTests(): void {
  pendingInputsByAgent = new Map();
  listeners.clear();
}

export function normalizeAgentPendingInputSubmittedText(
  submittedText: string,
): string {
  const extracted = extractSkillMentionsFromText(submittedText);
  return injectSkillMentionsIntoText(
    extracted.text,
    extracted.skills,
  ).trim();
}
