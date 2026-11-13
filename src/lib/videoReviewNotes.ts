/** Notes are stored beside, never inside, the original video. */
export interface VideoReviewNote {
  id: string;
  atSeconds: number;
  text: string;
}

export interface VideoReviewNotes {
  version: 1;
  notes: VideoReviewNote[];
}

export function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid video time');
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 3600).toString().padStart(2, '0')}:${Math.floor(whole / 60 % 60).toString().padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`;
}

export function addVideoReviewNote(current: VideoReviewNotes, note: VideoReviewNote): VideoReviewNotes {
  if (!Number.isFinite(note.atSeconds) || note.atSeconds < 0 ||
      !note.text.trim() || note.text.length > 4000 || !note.id ||
      current.notes.some(existing => existing.id === note.id)) {
    throw new Error('Invalid video review note');
  }
  return { version: 1, notes: [...current.notes, { ...note, text: note.text.trim() }] };
}

export function parseVideoReviewNotes(value: string): VideoReviewNotes {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) ||
      parsed.version !== 1 || !('notes' in parsed) || !Array.isArray(parsed.notes) ||
      parsed.notes.length > 1000) throw new Error('Unsupported video review notes');
  let result: VideoReviewNotes = { version: 1, notes: [] };
  for (const entry of parsed.notes) {
    if (!entry || typeof entry !== 'object' ||
        typeof entry.id !== 'string' || typeof entry.atSeconds !== 'number' ||
        typeof entry.text !== 'string') throw new Error('Invalid video review note');
    result = addVideoReviewNote(result, entry as VideoReviewNote);
  }
  return result;
}
