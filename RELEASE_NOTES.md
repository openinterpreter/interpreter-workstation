## What's new

- The direct DeepSeek API integration now honors an explicit Responses API selection while retaining Chat Completions as the default.
- The bundled Interpreter coding runtime is updated to 0.0.45, based on the latest stable Codex baseline.
- DeepSeek Flash now supports image input and a 1M context window, and model choices include DeepSeek V4 Flash and DeepSeek V4 Pro alongside GLM-5.3 and GLM-5.3-Flash, GPT-6 Astra, GPT-5.6 Sol, Terra, and Luna, Gemini 3.8 and 3.7 Flash, and current Z.AI/GLM options.
- Provider compatibility includes the Responses API, Chat Completions, ACP, and improved local-model diagnostics.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published for macOS, Windows, and Linux.
