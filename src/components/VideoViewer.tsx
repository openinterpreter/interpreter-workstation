import { useState, useEffect, useRef } from 'react';
import { VIDEO_VIEWER_ID } from '../../shared/element-ids';
import { getFileUrl } from '@/ipc';
import { readFile, writeFile } from '../api';
import { isWorkstationReadOnly } from '../remote/workstationConnection';
import { VoiceCaptureSession, transcribeVoiceWav } from '../../agent/utils/voiceCapture';
import { addVideoReviewNote, formatVideoTime, parseVideoReviewNotes, type VideoReviewNotes } from '../lib/videoReviewNotes';
import { openFeedbackPopover } from '../utils/feedback';
import { useFileRefresh } from '../hooks/useFileRefresh';

interface VideoViewerProps {
  filePath: string;
}

export function VideoViewer({ filePath }: VideoViewerProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);
  const [review, setReview] = useState<VideoReviewNotes>({ version: 1, notes: [] });
  const [reviewReady, setReviewReady] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureRef = useRef<VoiceCaptureSession | null>(null);
  const reviewRef = useRef(review);
  const activePathRef = useRef(filePath);
  const savingRef = useRef(false);
  const pendingVoiceRef = useRef(false);
  const voiceGenerationRef = useRef(0);
  const [processingVoice, setProcessingVoice] = useState(false);

  if (activePathRef.current !== filePath) {
    activePathRef.current = filePath;
    voiceGenerationRef.current++;
  }

  useEffect(() => { reviewRef.current = review; }, [review]);

  useFileRefresh(filePath, () => setReloadTrigger(t => t + 1));

  useEffect(() => {
    setError(false);
    void getFileUrl(filePath).then(setVideoUrl).catch(() => setError(true));
  }, [filePath, reloadTrigger]);

  useEffect(() => {
    voiceGenerationRef.current++;
    captureRef.current?.stop();
    captureRef.current = null;
    setListening(false);
    setReviewReady(false);
    setReviewError(null);
    setReview({ version: 1, notes: [] });
    let mounted = true;
    void readFile(`${filePath}.review.json`).then(result => {
      if (mounted) setReview(parseVideoReviewNotes(result.content));
    }).catch((reason: unknown) => {
      if (!mounted) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      // A missing sidecar is normal. All other read/parse failures forbid an
      // overwrite so existing review comments cannot be silently lost.
      if (!/\b(ENOENT|not found|404)\b/i.test(message)) setReviewError(message);
    }).finally(() => { if (mounted) setReviewReady(true); });
    return () => { mounted = false; captureRef.current?.stop(); captureRef.current = null; };
  }, [filePath]);

  async function saveNote(text: string, atSeconds: number): Promise<void> {
    if (!reviewReady || reviewError || isWorkstationReadOnly()) {
      throw new Error('Review is not writable.');
    }
    if (savingRef.current) throw new Error('Wait for the preceding note to finish saving.');
    savingRef.current = true;
    setSaving(true);
    try {
      const next = addVideoReviewNote(reviewRef.current, {
        id: crypto.randomUUID(), atSeconds, text,
      });
      if (activePathRef.current !== filePath) throw new Error('Video changed before note was saved.');
      const result = await writeFile(`${filePath}.review.json`, `${JSON.stringify(next, null, 2)}\n`);
      if ('success' in result && result.success === false) throw new Error(result.error ?? 'Could not save review note');
      if (activePathRef.current !== filePath) throw new Error('Video changed during note save.');
      reviewRef.current = next;
      setReview(next);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function startVoiceNote(): Promise<void> {
    if (captureRef.current || pendingVoiceRef.current) return;
    setReviewError(null);
    const sourcePath = filePath;
    const generation = voiceGenerationRef.current;
    let speechTime = 0;
    let resumeAfterSpeech = false;
    let speechVideo: HTMLVideoElement | null = null;
    const session = new VoiceCaptureSession({
      onSpeechStart: () => {
        if (captureRef.current !== session || generation !== voiceGenerationRef.current ||
            activePathRef.current !== sourcePath) return;
        const video = videoRef.current;
        speechVideo = video;
        speechTime = video?.currentTime ?? 0;
        resumeAfterSpeech = !!video && !video.paused;
        video?.pause();
      },
      onUtterance: async wav => {
        if (captureRef.current !== session || pendingVoiceRef.current) return;
        session.stop();
        captureRef.current = null;
        setListening(false);
        pendingVoiceRef.current = true;
        setProcessingVoice(true);
        try {
          const text = await transcribeVoiceWav(wav);
          if (!text) throw new Error('No speech was transcribed; the video was not changed.');
          if (generation !== voiceGenerationRef.current || activePathRef.current !== sourcePath) return;
          await saveNote(text, speechTime);
          if (generation === voiceGenerationRef.current && activePathRef.current === sourcePath &&
              speechVideo === videoRef.current && resumeAfterSpeech) await speechVideo?.play();
        } catch (reason) {
          if (generation === voiceGenerationRef.current && activePathRef.current === sourcePath) {
            setReviewError(reason instanceof Error ? reason.message : 'Voice note failed');
          }
        } finally {
          pendingVoiceRef.current = false;
          setProcessingVoice(false);
        }
      },
      onError: reason => {
        if (captureRef.current !== session) return;
        session.stop();
        captureRef.current = null;
        setListening(false);
        setReviewError(reason instanceof Error ? reason.message : 'Microphone unavailable');
      },
    });
    captureRef.current = session;
    try { await session.start(); if (captureRef.current === session) setListening(true); }
    catch (reason) {
      session.stop(); captureRef.current = null;
      setReviewError(reason instanceof Error ? reason.message : 'Microphone unavailable');
    }
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Video viewer */}
      <div
        className="voice-focus-content-surface flex-1 flex items-center justify-center bg-background p-4 overflow-auto"
        data-testid={VIDEO_VIEWER_ID}
      >
        {error ? (
          <div className="text-center space-y-3">
            <div className="text-muted-foreground">Unable to load this file</div>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setReloadTrigger(t => t + 1)}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                Try again
              </button>
              <button
                onClick={() => openFeedbackPopover()}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                Report bug
              </button>
            </div>
          </div>
        ) : videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            playsInline
            className="max-w-full max-h-full"
            onError={() => setError(true)}
          >
            Your browser does not support the video tag.
          </video>
        ) : (
          <div className="text-muted-foreground">Loading...</div>
        )}
      </div>
      <section aria-label="Video review" className="border-t border-border p-3 max-h-[38svh] overflow-y-auto text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <strong>Review at the playhead</strong>
          <button type="button" className="rounded border px-3 py-2" disabled={!reviewReady || !!reviewError || processingVoice || isWorkstationReadOnly()}
            onClick={() => listening ? (captureRef.current?.stop(), captureRef.current = null, setListening(false)) : void startVoiceNote()}>
            {listening ? 'Cancel voice note' : 'Speak a note'}
          </button>
        </div>
        <form className="flex gap-2 mt-2" onSubmit={event => {
          event.preventDefault();
          const at = videoRef.current?.currentTime ?? 0;
          void saveNote(draft, at).then(() => setDraft('')).catch(reason => setReviewError(String(reason)));
        }}>
          <input aria-label="Review note" className="min-w-0 flex-1 rounded border bg-background px-2" value={draft}
            onChange={event => setDraft(event.target.value)} placeholder="Note at current video time" maxLength={4000} />
          <button type="submit" className="rounded border px-3 py-2" disabled={!draft.trim() || !reviewReady || saving || !!reviewError || isWorkstationReadOnly()}>Save note</button>
        </form>
        {reviewError && <p role="alert" className="mt-2 text-destructive">{reviewError}</p>}
        <ol className="mt-2 space-y-1" aria-label="Timestamped review notes">
          {review.notes.map(note => <li key={note.id} className="flex gap-2">
            <button type="button" className="underline" onClick={() => { if (videoRef.current) videoRef.current.currentTime = note.atSeconds; }}>
              {formatVideoTime(note.atSeconds)}
            </button><span>{note.text}</span>
          </li>)}
        </ol>
      </section>
    </div>
  );
}
