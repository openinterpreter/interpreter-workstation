---
name: "transcribe"
description: "Transcribe audio files locally with Interpreter's builtin-transcribe tool server. Use when a user asks to transcribe speech from recordings without cloud transcription or API keys."
---


# Local Audio Transcribe

Transcribe audio locally through Interpreter's app-side `builtin-transcribe`
tool server. Do not install Python packages and do not ask for an OpenAI API
key. The agent asks Interpreter to download/run local Whisper models; the app
server owns the user-data install location and filesystem permissions.

## Workflow
1. Collect the audio/video file path and ask whether the user wants a fast,
   small model or a larger, higher-quality model when that tradeoff matters.
2. Run `interpreter-app tools builtin-transcribe list_transcription_models --json '{}'`
   to check installed models and compare size/language/quality.
3. If the chosen model is not installed, ask the user before downloading it.
   Then run `interpreter-app tools builtin-transcribe download_model --json '{"model":"tiny.en"}'`
   or the selected model ID. Interpreter downloads into app user data and shows
   a download toast.
4. Run `interpreter-app tools builtin-transcribe transcribe_audio --json '{"audioPath":"path/to/audio.mp3","model":"tiny.en","outputPath":"output/transcribe/transcript.txt"}'`.
5. Validate the transcript and save outputs under `output/transcribe/` when
   working in this repo unless the user requested another path.

## Decision rules
- Default to `tiny.en` for quick English transcription.
- Use `tiny` for quick multilingual transcription.
- Use `small.en` or `small` when accuracy matters and a larger download is acceptable.
- Use `medium.en`, `medium`, or `large-v3` only when the user accepts much larger downloads and slower local runtime.
- If `transcribe_audio` says the model is missing, do not work around it in shell. Ask the user whether to download a model, then call `download_model`.
- Speaker diarization and known-speaker labeling are not supported by the local builtin-transcribe tool.
- For video files, first extract audio with a normal local media workflow, then pass the audio file to `transcribe_audio`.

## Output conventions
- Use `output/transcribe/<job-id>/` for evaluation runs.
- Use `outputPath` for transcript files to avoid overwriting.

## Tool quick start

```
interpreter-app tools builtin-transcribe list_transcription_models --json '{}'
```

```
interpreter-app tools builtin-transcribe download_model --json '{"model":"tiny.en"}'
```

```
interpreter-app tools builtin-transcribe transcribe_audio --json '{"audioPath":"interview.mp3","model":"tiny.en","outputPath":"output/transcribe/interview.txt"}'
```

## Reference map
- `references/api.md`: local model IDs and supported audio format notes.
