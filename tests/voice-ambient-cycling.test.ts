/**
 * Ambient voice mode integration tests.
 *
 * Tests two backend strategies:
 * 1. Non-macOS: Session cycling every 2s with 1.2s overlap in waiting mode.
 *    qwen_asr with -S 1 drops isolated words in silence, so cycling is required.
 *    Overlap prevents the trigger word from being split at cycle boundaries.
 *    No overlap in accumulating mode (avoids text duplication).
 *
 * 2. macOS: SFSpeechRecognizer only detects the wake word / end phrase while
 *    qwen owns the command transcript with preroll audio across the trigger.
 *
 * Audio fixtures:
 *   scenario1-fast.wav    — silence → fast "Interpreter turn on lights make it so"
 *   scenario2-spread.wav  — chatter → trigger → pause → command → pause → end phrase
 *   scenario3-silence-trigger.wav — chatter → trigger → command → end phrase
 *   scenario4-multi.wav   — two commands back-to-back
 *   stress-test.wav       — 125s realistic audio, 3 commands with long silences/paragraphs
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect, beforeAll } from 'bun:test';
import { buildTolerantPhrasePattern, mergeStreamingVoiceTranscript, normalizeVoiceText } from '../agent/utils/voiceTranscript';
import { resolveAmbientEndPhrase } from '../agent/utils/ambientVoice';

function stripLeadingPunctuation(text: string): string {
  return text.replace(/^[\s,.:;!?\-'"]+/, '').trim();
}

function findQwenBinary(): { binaryPath: string; modelDir: string } | null {
  const candidates = [
    process.env.QWEN_ASR_ASSET_DIR,
    path.join(process.env.HOME ?? '', 'Library/Application Support/Interpreter/qwen-asr'),
    path.join(process.env.HOME ?? '', 'Library/Application Support/Electron/qwen-asr'),
  ].filter(Boolean) as string[];
  const platformKey = `${process.platform}-${process.arch}`;
  for (const root of candidates) {
    const platformDir = path.join(root, platformKey);
    const binaryName = process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';
    const binaryPath = path.join(platformDir, binaryName);
    if (!existsSync(binaryPath)) continue;
    for (const modelName of ['qwen3-asr-0.6b', 'qwen-asr']) {
      const modelDir = path.join(platformDir, modelName);
      if (existsSync(modelDir)) return { binaryPath, modelDir };
    }
  }
  return null;
}

const qwenPaths = findQwenBinary();
const describeIfQwen = qwenPaths ? describe : describe.skip;

const CHUNK_SIZE = 2560; // 80ms at 16kHz 16-bit mono
const OVERLAP_CHUNKS = 15; // 1.2s overlap
const CYCLE_MS = 2000;

function loadAudioPcm(filename: string): Buffer {
  const audioPath = path.join(import.meta.dir, 'fixtures/audio/ambient', filename);
  if (!existsSync(audioPath)) throw new Error(`Audio fixture not found: ${audioPath}`);
  return readFileSync(audioPath).subarray(44); // skip WAV header
}

function splitIntoChunks(pcm: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += CHUNK_SIZE) {
    chunks.push(pcm.subarray(i, i + CHUNK_SIZE));
  }
  return chunks;
}

// ---- Cycling simulation (non-macOS path) ----

interface CyclingResult {
  sentTexts: string[];
  cycleTranscripts: string[];
}

async function runCyclingWithOverlap(audioFile: string): Promise<CyclingResult> {
  const { binaryPath, modelDir } = qwenPaths!;
  const pcm = loadAudioPcm(audioFile);
  const allChunks = splitIntoChunks(pcm);
  const triggerPattern = buildTolerantPhrasePattern('Interpreter');
  const endPattern = buildTolerantPhrasePattern('make it so');

  const cycleTranscripts: string[] = [];
  const ringBuffer: Buffer[] = [];
  const sentTexts: string[] = [];
  let chunkIndex = 0;
  let ambientState: 'waiting' | 'accumulating' = 'waiting';
  let accumulated = '';

  while (chunkIndex < allChunks.length) {
    // Start session
    const proc = spawn(binaryPath, ['-d', modelDir, '--stdin', '--stream'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Feed overlap in waiting mode only
    if (ambientState === 'waiting' && ringBuffer.length > 0) {
      for (const chunk of ringBuffer) {
        try { proc.stdin!.write(chunk); } catch { break; }
      }
    }

    // Feed new chunks for this cycle
    const cycleEnd = Math.min(chunkIndex + Math.ceil(CYCLE_MS / 80), allChunks.length);
    for (let i = chunkIndex; i < cycleEnd; i++) {
      try { proc.stdin!.write(allChunks[i]!); } catch { break; }
      ringBuffer.push(allChunks[i]!);
      if (ringBuffer.length > OVERLAP_CHUNKS) ringBuffer.shift();
    }
    chunkIndex = cycleEnd;

    // Finish session
    const rawTranscript = await new Promise<string>((resolve) => {
      let output = '';
      proc.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString().split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => !l.startsWith('[')).join(' ');
      });
      proc.on('close', () => resolve(output.trim()));
      proc.stdin!.end();
      setTimeout(() => { proc.kill('SIGKILL'); resolve(output.trim()); }, 8000);
    });

    const normalized = normalizeVoiceText(rawTranscript);
    cycleTranscripts.push(normalized);
    if (!normalized) continue;

    // Process transcript
    if (ambientState === 'waiting') {
      const triggerMatch = normalized.match(triggerPattern);
      if (triggerMatch) {
        ambientState = 'accumulating';
        const afterTrigger = stripLeadingPunctuation(normalized.slice(triggerMatch.index! + triggerMatch[0].length));
        if (afterTrigger) {
          accumulated = afterTrigger;
          const endAction = resolveAmbientEndPhrase(accumulated, endPattern, false);
          if (endAction.type === 'send') {
            sentTexts.push(endAction.finalText);
            accumulated = '';
            ambientState = 'waiting';
            continue;
          } else if (endAction.type === 'reset-empty') {
            accumulated = '';
            ambientState = 'waiting';
            continue;
          }
        }
      }
    }

    if (ambientState === 'accumulating') {
      const triggerMatch = normalized.match(triggerPattern);
      const cycleText = triggerMatch
        ? stripLeadingPunctuation(normalized.slice(triggerMatch.index! + triggerMatch[0].length))
        : normalized.trim();
      if (cycleText) {
        accumulated = accumulated
          ? mergeStreamingVoiceTranscript(accumulated, cycleText)
          : cycleText;
      }
      const endAction = resolveAmbientEndPhrase(accumulated, endPattern, false);
      if (endAction.type === 'send') {
        sentTexts.push(endAction.finalText);
        accumulated = '';
        ambientState = 'waiting';
      } else if (endAction.type === 'reset-empty') {
        accumulated = '';
        ambientState = 'waiting';
      }
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return { sentTexts, cycleTranscripts };
}

// ---- Pure logic tests ----

function simulateAmbientCycling(cycleTranscripts: string[]): { sentTexts: string[]; phase: string; accumulatedTranscript: string } {
  const triggerPattern = buildTolerantPhrasePattern('Interpreter');
  const endPattern = buildTolerantPhrasePattern('make it so');
  let ambientState: 'waiting' | 'accumulating' = 'waiting';
  let accumulatedTranscript = '';
  const sentTexts: string[] = [];

  for (const rawTranscript of cycleTranscripts) {
    const normalized = normalizeVoiceText(rawTranscript);
    if (!normalized) continue;

    if (ambientState === 'waiting') {
      const triggerMatch = normalized.match(triggerPattern);
      if (triggerMatch) {
        ambientState = 'accumulating';
        const afterTrigger = stripLeadingPunctuation(normalized.slice(triggerMatch.index! + triggerMatch[0].length));
        if (afterTrigger) {
          accumulatedTranscript = afterTrigger;
          const endAction = resolveAmbientEndPhrase(accumulatedTranscript, endPattern, false);
          if (endAction.type === 'send') {
            sentTexts.push(endAction.finalText);
            accumulatedTranscript = '';
            ambientState = 'waiting';
            continue;
          } else if (endAction.type === 'reset-empty') {
            accumulatedTranscript = '';
            ambientState = 'waiting';
            continue;
          }
        }
      }
    }

    if (ambientState === 'accumulating') {
      const triggerMatch = normalized.match(triggerPattern);
      const cycleText = triggerMatch
        ? stripLeadingPunctuation(normalized.slice(triggerMatch.index! + triggerMatch[0].length))
        : normalized.trim();
      if (cycleText) {
        accumulatedTranscript = accumulatedTranscript
          ? mergeStreamingVoiceTranscript(accumulatedTranscript, cycleText)
          : cycleText;
      }
      const endAction = resolveAmbientEndPhrase(accumulatedTranscript, endPattern, false);
      if (endAction.type === 'send') {
        sentTexts.push(endAction.finalText);
        accumulatedTranscript = '';
        ambientState = 'waiting';
      } else if (endAction.type === 'reset-empty') {
        accumulatedTranscript = '';
        ambientState = 'waiting';
      }
    }
  }

  return {
    phase: sentTexts.length > 0 && ambientState === 'waiting' ? 'sent' : ambientState,
    accumulatedTranscript,
    sentTexts,
  };
}

// ---- Pure logic tests ----

describe('ambient cycling logic (pure)', () => {
  test('detects trigger in single cycle transcript', () => {
    const result = simulateAmbientCycling(['Interpreter turn on the lights make it so']);
    expect(result.sentTexts).toEqual(['turn on the lights']);
  });

  test('accumulates across multiple cycles', () => {
    const result = simulateAmbientCycling([
      'blah blah',
      'Interpreter',
      'turn on the lights',
      'in the living room make it so',
    ]);
    expect(result.sentTexts.length).toBe(1);
    expect(result.sentTexts[0]!.toLowerCase()).toContain('light');
    expect(result.sentTexts[0]!.toLowerCase()).toContain('living room');
  });

  test('handles trigger word in overlap', () => {
    const result = simulateAmbientCycling([
      'hello Interpreter turn on',
      'Interpreter turn on the lights',
      'the lights make it so',
    ]);
    expect(result.sentTexts.length).toBe(1);
    expect(result.sentTexts[0]!.toLowerCase()).toContain('light');
  });

  test('two commands back-to-back', () => {
    const result = simulateAmbientCycling([
      'Interpreter turn on lights make it so',
      'Interpreter what time is it make it so',
    ]);
    expect(result.sentTexts.length).toBe(2);
    expect(result.sentTexts[0]!.toLowerCase()).toContain('light');
    expect(result.sentTexts[1]!.toLowerCase()).toContain('time');
  });

  test('ignores chatter before trigger', () => {
    const result = simulateAmbientCycling([
      'I was just thinking about dinner',
      'and how the weather is nice today',
      'anyway Interpreter turn on the lights make it so',
    ]);
    expect(result.sentTexts.length).toBe(1);
    expect(result.sentTexts[0]!.toLowerCase()).toContain('light');
    expect(result.sentTexts[0]!.toLowerCase()).not.toContain('dinner');
  });

  test('handles empty cycles gracefully', () => {
    const result = simulateAmbientCycling(['', '   ', 'Interpreter do something make it so', '']);
    expect(result.sentTexts.length).toBe(1);
  });

  test('tolerates punctuation in trigger and end phrase', () => {
    const result = simulateAmbientCycling(['Interpreter, turn on the lights. Make. It. So!']);
    expect(result.sentTexts.length).toBe(1);
  });

  test('end phrase with no command text resets', () => {
    const result = simulateAmbientCycling(['Interpreter make it so']);
    expect(result.sentTexts.length).toBe(0);
    expect(result.phase).toBe('waiting');
  });

  test('stays accumulating when no end phrase yet', () => {
    const result = simulateAmbientCycling([
      'Interpreter turn on the lights',
      'in the living room',
      'and also the kitchen',
    ]);
    expect(result.sentTexts.length).toBe(0);
    expect(result.phase).toBe('accumulating');
    expect(result.accumulatedTranscript.toLowerCase()).toContain('kitchen');
  });
});

// ---- Integration tests with real qwen_asr ----

describeIfQwen('ambient cycling with real qwen_asr', () => {
  test('scenario 1 (fast): all in one breath', async () => {
    const result = await runCyclingWithOverlap('scenario1-fast.wav');
    console.log('  Sent:', result.sentTexts);
    expect(result.sentTexts.length).toBeGreaterThanOrEqual(1);
    expect(result.sentTexts[0]!.toLowerCase()).toContain('light');
  }, 60000);

  test('scenario 2 (spread): chatter → trigger → pause → command → pause → end', async () => {
    const result = await runCyclingWithOverlap('scenario2-spread.wav');
    console.log('  Sent:', result.sentTexts);
    expect(result.sentTexts.length).toBeGreaterThanOrEqual(1);
    expect(result.sentTexts[0]!.toLowerCase()).toContain('light');
  }, 60000);

  test('scenario 3 (silence+trigger): isolated trigger word in silence', async () => {
    const result = await runCyclingWithOverlap('scenario3-silence-trigger.wav');
    console.log('  Sent:', result.sentTexts);
    expect(result.sentTexts.length).toBeGreaterThanOrEqual(1);
    expect(result.sentTexts[0]!.toLowerCase()).toContain('weather');
  }, 60000);

  test('scenario 4 (multi): two commands back-to-back', async () => {
    const result = await runCyclingWithOverlap('scenario4-multi.wav');
    console.log('  Sent:', result.sentTexts);
    expect(result.sentTexts.length).toBeGreaterThanOrEqual(2);
  }, 60000);

  test('stress test (125s): 3 commands with long silences and paragraphs', async () => {
    const result = await runCyclingWithOverlap('stress-test.wav');
    console.log('  Sent:', result.sentTexts);
    console.log('  Cycles:', result.cycleTranscripts.filter(t => t).length, 'non-empty out of', result.cycleTranscripts.length);
    // Cycling degrades qwen's transcription quality for short phrases in silence.
    // Some end phrases may be mangled (e.g. "Make. Did so." instead of "Make it so").
    // On macOS, SFSpeechRecognizer handles this perfectly. On other platforms,
    // this is a known limitation — we get at least 2/3 commands reliably.
    expect(result.sentTexts.length).toBeGreaterThanOrEqual(2);
    const allSent = result.sentTexts.join(' ').toLowerCase();
    expect(allSent).toContain('timer');
  }, 300000);
});
