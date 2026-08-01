# builtin-transcribe quick reference

- Server: `builtin-transcribe`
- Tools: `list_transcription_models`, `download_model`, `transcribe_audio`
- Models: `tiny.en`, `tiny`, `small.en`, `small`, `medium.en`, `medium`, `large-v3`
- Default model: `tiny.en`
- English-only models are smaller/faster for English recordings. Multilingual models support non-English audio.
- Downloads are app-side into Interpreter user data, not agent-side shell installs.
- `transcribe_audio` does not auto-download. If the requested model is missing, ask the user before calling `download_model`.
- Supported audio formats come from whisperfile/whisper.cpp. WAV, MP3, Ogg Vorbis, and FLAC are expected to work locally.
- Diarization and known-speaker references are not supported by this local tool.
