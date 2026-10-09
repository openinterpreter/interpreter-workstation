import { useCallback, useEffect, useRef, useState } from 'react';
import { simpleLive } from '@/ipc';

type SimpleLiveState = 'idle' | 'connecting' | 'active' | 'error';

type UseSimpleLiveOptions = {
  onDelegate: (text: string, delegationId: string) => void;
};

const MAX_RECENT_TRANSCRIPT_CHARACTERS = 4_000;

export function appendBoundedTranscript(current: string, delta: string): string {
  const next = `${current}${delta}`;
  return next.length <= MAX_RECENT_TRANSCRIPT_CHARACTERS
    ? next
    : next.slice(-MAX_RECENT_TRANSCRIPT_CHARACTERS);
}

export function delegatedRequestText(
  delegation: { text?: unknown; message?: unknown; input?: unknown } | undefined,
  currentInput: string,
): string {
  for (const value of [delegation?.text, delegation?.message, delegation?.input]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return currentInput.trim();
}

export function useSimpleLive({ onDelegate }: UseSimpleLiveOptions) {
  const [state, setState] = useState<SimpleLiveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const inputTranscriptRef = useRef('');
  // The durable agent is one ordered conversation, so its assistant replies
  // resolve delegated requests in the same order they were submitted.
  const delegationIdsRef = useRef<string[]>([]);

  const cleanup = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (channelRef.current) channelRef.current.onclose = null;
    channelRef.current?.close();
    peerRef.current?.close();
    mediaRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
    audioRef.current?.remove();
    channelRef.current = null;
    peerRef.current = null;
    mediaRef.current = null;
    audioRef.current = null;
    audioContextRef.current = null;
    inputTranscriptRef.current = '';
    delegationIdsRef.current = [];
    setLevel(0);
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setState('idle');
  }, [cleanup]);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => void simpleLive.status().then((status) => {
      if (!cancelled) setConfigured(status.configured);
    }).catch(() => {
      if (!cancelled) setConfigured(false);
    });
    refresh();
    window.addEventListener('simple-live:configuration-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('simple-live:configuration-changed', refresh);
    };
  }, []);

  const start = useCallback(async () => {
    if (state === 'connecting' || state === 'active') return;
    setError(null);
    setState('connecting');
    try {
      const status = await simpleLive.status();
      setConfigured(status.configured);
      if (!status.configured) {
        throw new Error('GPT Live needs an OpenAI API key. Add an OpenAI model in Settings first.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRef.current = stream;
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('aria-hidden', 'true');
      audio.style.display = 'none';
      document.body.appendChild(audio);
      audioRef.current = audio;
      peer.ontrack = (event) => { audio.srcObject = event.streams[0] ?? null; };

      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        analyser.getByteFrequencyData(samples);
        const average = samples.reduce((sum, value) => sum + value, 0) / Math.max(samples.length, 1);
        setLevel(Math.min(1, average / 90));
        frameRef.current = requestAnimationFrame(draw);
      };
      draw();

      const channel = peer.createDataChannel('oai-events');
      channelRef.current = channel;
      channel.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as {
            type?: string;
            delta?: string;
            delegation?: {
              id?: string;
              target?: string;
              text?: unknown;
              message?: unknown;
              input?: unknown;
            };
            error?: { message?: string };
          };
          if (payload.type === 'session.started') setState('active');
          if (payload.type === 'session.input_transcript.delta' && payload.delta) {
            inputTranscriptRef.current = appendBoundedTranscript(inputTranscriptRef.current, payload.delta);
          }
          if (payload.type === 'session.delegation.created'
            && payload.delegation?.target === 'client'
            && payload.delegation.id) {
            const requestText = delegatedRequestText(payload.delegation, inputTranscriptRef.current);
            inputTranscriptRef.current = '';
            if (requestText) {
              delegationIdsRef.current.push(payload.delegation.id);
              onDelegate(requestText, payload.delegation.id);
            }
          }
          if (payload.type === 'error') {
            setError(payload.error?.message ?? 'GPT Live reported an error.');
          }
        } catch {
          // Ignore malformed transport events; the live session remains usable.
        }
      };
      channel.onopen = () => setState('active');
      channel.onclose = () => setState('idle');

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const { answerSdp } = await simpleLive.createSession({ offerSdp: offer.sdp ?? '' });
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (cause) {
      cleanup();
      setState('error');
      setError(cause instanceof Error ? cause.message : 'GPT Live could not start.');
    }
  }, [cleanup, onDelegate, state]);

  const sendResult = useCallback((content: string) => {
    const channel = channelRef.current;
    const delegationId = delegationIdsRef.current[0];
    if (!delegationId || channel?.readyState !== 'open' || !content.trim()) return;
    const result = content.slice(0, 1_800);
    channel.send(JSON.stringify({
      type: 'session.commentary.append',
      event_id: `simple_result_${Date.now()}_${delegationId}`,
      delegation_id: delegationId,
      content: result,
    }));
    delegationIdsRef.current.shift();
  }, []);

  return { state, error, level, configured, start, stop, sendResult };
}
