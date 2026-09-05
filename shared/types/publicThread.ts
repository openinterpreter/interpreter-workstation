export type PublicThreadStatus = 'connecting' | 'working' | 'idle' | 'paused' | 'error';

export type PublicThreadGoal = {
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  updatedAt: number;
};

export type PublicThreadMessagePart =
  | { kind: 'text'; content: string }
  | {
      kind: 'tool';
      id: string;
      label: string;
      state: 'loading' | 'complete' | 'error';
      output?: string;
    };

export type PublicThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: PublicThreadMessagePart[];
  createdAt?: number;
};

export type PublicThreadSnapshot = {
  schemaVersion: 1;
  threadId: string;
  title: string;
  status: PublicThreadStatus;
  goal: PublicThreadGoal | null;
  messages: PublicThreadMessage[];
  page: {
    nextCursor: string | null;
    hasMore: boolean;
  };
  eventCursor: string | null;
  updatedAt: number;
};

export type PublicThreadEvent = {
  cursor: string;
  snapshot: PublicThreadSnapshot;
};
