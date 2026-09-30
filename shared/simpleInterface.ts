/** A deliberately declarative, inert interface format. Workspace files never execute JS. */
export type SimpleBlock =
  | { type: 'heading'; id: string; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; id: string; text: string }
  | { type: 'card' | 'row'; id: string; children: SimpleBlock[] }
  | { type: 'image'; id: string; asset: string; alt: string; caption?: string }
  | { type: 'button'; id: string; label: string; message: string }
  | { type: 'input'; id: string; label: string; placeholder?: string; buttonLabel?: string; message: string }
  | { type: 'divider'; id: string };

export interface SimplePage {
  version: 1;
  title: string;
  blocks: SimpleBlock[];
}

export interface SimpleInterfaceSnapshot {
  page: SimplePage;
  revision: string;
  data: Record<string, string>;
  inputs: Record<string, string>;
  diagnostic: string | null;
}

export interface SimpleActionEvent {
  id: string;
  at: string;
  revision: string;
  actionId: string;
  message: string;
  value?: string;
  status: 'pending' | 'dispatched' | 'failed';
}
