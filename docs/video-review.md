# Timestamped video review

The file editor opens an explicitly selected video through Workstation's existing
file URL boundary. Playback uses the browser's inline `<video>` controls on
small screens. Notes are saved beside the selected file as
`<video path>.review.json`; the MP4 is never rewritten, uploaded or embedded in
the notes. Each note stores the exact `video.currentTime` (fractional seconds),
an ID and a transcript. Clicking a timestamp seeks within the original video.
Malformed existing sidecars fail closed instead of being overwritten.

The voice-note action reuses the existing `VoiceCaptureSession` and selected
Workstation backend's `/api/agent/voice/transcribe` route: detected speech pauses the playing video,
captures its playhead once, transcribes that utterance, writes the sidecar,
then resumes playback only if the video was playing before speech. The explicit
Speak action captures microphone audio and sends that audio to the selected
Workstation backend for transcription, **not** the video. Recording and
transcription require microphone permission and an available speech runtime;
a remote read-only renderer cannot save notes. The viewer introduces no
provider credential or video-upload path.

Acceptance still requires an exact licensed source file available to the
reviewer's own project, a real phone-sized browser playback check, microphone
and transcription availability, timestamp/seek accuracy, reload persistence,
and a guarded installed release. Component tests with mocked audio/network do
not prove those conditions or a physical-phone recording. A project-specific
distribution or customer delivery must remain separate from this generic
Workstation capability.
