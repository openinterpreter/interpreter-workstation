/**
 * Activity store
 *
 * Lightweight, append/merge JSON file tracking user behavior signals used to
 * power the new-tab suggestion grid. Private, offline, local-only.
 *
 * We track:
 *   - File opens (count + lastOpened) — drives "recent" and "frequent" files
 *   - Skill usage (count + lastUsed + name) — drives "frequent skills"
 *   - Card clicks (count + lastClicked) — drives self-learning suggestion ranking
 *
 * Events are merged into aggregate counters rather than kept as an append-only
 * log. This keeps the file tiny (no log compaction) and reads cheap.
 */

import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = pathJoin(homedir(), '.interpreter');
const ACTIVITY_FILE = pathJoin(CONFIG_DIR, 'activity.json');
const MAX_TRACKED_FILES = 400;
const MAX_TRACKED_SKILLS = 200;
const MAX_TRACKED_CARDS = 200;

export interface FileActivity {
  path: string;
  name: string;
  count: number;
  lastOpened: number;
}

export interface SkillActivity {
  skillId: string;
  name: string;
  count: number;
  lastUsed: number;
}

export interface CardActivity {
  cardId: string;
  count: number;
  lastClicked: number;
}

export interface ActionActivity {
  /** Coarse action id — e.g. "sent-prompt", "created-note", "opened-pdf",
   *  "ran-skill:wiki-maintainer", "started-chat", "used-tool:web_search". */
  actionId: string;
  count: number;
  lastDone: number;
}

interface ActivityData {
  files: Record<string, FileActivity>;
  skills: Record<string, SkillActivity>;
  cards: Record<string, CardActivity>;
  actions: Record<string, ActionActivity>;
}

const MAX_TRACKED_ACTIONS = 400;
const EMPTY_ACTIVITY: ActivityData = { files: {}, skills: {}, cards: {}, actions: {} };

let cachedActivity: ActivityData | null = null;
let pendingWrite: Promise<void> | null = null;

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

async function loadActivity(): Promise<ActivityData> {
  if (cachedActivity) return cachedActivity;
  try {
    const raw = await fsp.readFile(ACTIVITY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ActivityData>;
    cachedActivity = {
      files: parsed.files ?? {},
      skills: parsed.skills ?? {},
      cards: parsed.cards ?? {},
      actions: parsed.actions ?? {},
    };
  } catch {
    cachedActivity = { ...EMPTY_ACTIVITY, files: {}, skills: {}, cards: {}, actions: {} };
  }
  return cachedActivity;
}

async function saveActivity(): Promise<void> {
  if (!cachedActivity) return;
  ensureConfigDir();
  const data = JSON.stringify(cachedActivity);
  await fsp.writeFile(ACTIVITY_FILE, data, 'utf8');
}

function scheduleSave(): void {
  if (pendingWrite) return;
  pendingWrite = Promise.resolve().then(async () => {
    try {
      await saveActivity();
    } catch (error) {
      console.error('[activity] save failed', error);
    } finally {
      pendingWrite = null;
    }
  });
}

function trim<T extends { count: number }>(map: Record<string, T>, cap: number): void {
  const keys = Object.keys(map);
  if (keys.length <= cap) return;
  // Drop lowest-count entries.
  keys
    .sort((a, b) => map[a].count - map[b].count)
    .slice(0, keys.length - cap)
    .forEach((k) => delete map[k]);
}

function basenameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

export async function recordFileOpen(filePath: string): Promise<void> {
  if (!filePath) return;
  const activity = await loadActivity();
  const now = Date.now();
  const existing = activity.files[filePath];
  activity.files[filePath] = {
    path: filePath,
    name: existing?.name || basenameOf(filePath),
    count: (existing?.count ?? 0) + 1,
    lastOpened: now,
  };
  trim(activity.files, MAX_TRACKED_FILES);
  scheduleSave();
}

export async function recordSkillUsage(skillId: string, name: string): Promise<void> {
  if (!skillId) return;
  const activity = await loadActivity();
  const now = Date.now();
  const existing = activity.skills[skillId];
  activity.skills[skillId] = {
    skillId,
    name: name || existing?.name || skillId,
    count: (existing?.count ?? 0) + 1,
    lastUsed: now,
  };
  trim(activity.skills, MAX_TRACKED_SKILLS);
  scheduleSave();
}

export async function recordCardClick(cardId: string): Promise<void> {
  if (!cardId) return;
  const activity = await loadActivity();
  const now = Date.now();
  const existing = activity.cards[cardId];
  activity.cards[cardId] = {
    cardId,
    count: (existing?.count ?? 0) + 1,
    lastClicked: now,
  };
  trim(activity.cards, MAX_TRACKED_CARDS);
  scheduleSave();
}

/**
 * Recency-weighted ranking: newer entries beat older entries, but high-count
 * entries still win over one-off recent clicks. The half-life weighting gives
 * us a reasonable "frequency that decays" signal from deterministic inputs.
 */
function weightedScore(count: number, timestamp: number, now: number): number {
  const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
  const ageMs = Math.max(0, now - timestamp);
  const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
  return count * decay;
}

export async function getRecentFiles(limit = 10): Promise<FileActivity[]> {
  const activity = await loadActivity();
  return Object.values(activity.files)
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .slice(0, limit);
}

export async function getFrequentFiles(limit = 10): Promise<FileActivity[]> {
  const activity = await loadActivity();
  const now = Date.now();
  return Object.values(activity.files)
    .map((entry) => ({ entry, score: weightedScore(entry.count, entry.lastOpened, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export async function getFrequentSkills(limit = 10): Promise<SkillActivity[]> {
  const activity = await loadActivity();
  const now = Date.now();
  return Object.values(activity.skills)
    .map((entry) => ({ entry, score: weightedScore(entry.count, entry.lastUsed, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export async function getCardClicks(): Promise<Record<string, CardActivity>> {
  const activity = await loadActivity();
  return activity.cards;
}

export async function recordAction(actionId: string): Promise<void> {
  if (!actionId) return;
  const activity = await loadActivity();
  const now = Date.now();
  const existing = activity.actions[actionId];
  activity.actions[actionId] = {
    actionId,
    count: (existing?.count ?? 0) + 1,
    lastDone: now,
  };
  trim(activity.actions, MAX_TRACKED_ACTIONS);
  scheduleSave();
}

export async function getFrequentActions(limit = 20): Promise<ActionActivity[]> {
  const activity = await loadActivity();
  const now = Date.now();
  return Object.values(activity.actions)
    .map((entry) => ({ entry, score: weightedScore(entry.count, entry.lastDone, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export async function getActionCounts(): Promise<Record<string, ActionActivity>> {
  const activity = await loadActivity();
  return activity.actions;
}
