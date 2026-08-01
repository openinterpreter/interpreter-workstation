---
name: "media-creation"
description: "Use for AI image, video, audio, or 3D generation/editing. Prefer configured media tools when present, estimate cost before running a paid model, and keep provider credentials in the user's environment or provider configuration."
---


# Media Creation

## When to use
- Generate or edit images.
- Generate or edit videos.
- Generate audio or speech.
- Generate or transform 3D assets.

## Workflow
1. Prefer the direct Media AI tools when the distribution exposes them: `search_media_models`, `estimate_media_cost`, and `run_media_model`. If they are absent, use a provider the user has configured or explain what configuration is required.
2. Choose the endpoint and schema.
   - For image generation, default to GPT Image 2 unless the user needs cheaper drafts, a specialized style model, or a non-OpenAI model: `openai/gpt-image-2`.
   - For image editing, default to GPT Image 2 unless a specialist model is clearly better: `openai/gpt-image-2/edit`.
   - Use `search_media_models` when the endpoint or required fields are uncertain.
3. Estimate before spending.
   - Call `estimate_media_cost` for the chosen endpoint and output count before `run_media_model`.
   - Tell the user the expected provider cost and any distribution-specific balance charge when both are available.
4. Check balance when cost can climb.
   - For video, 3D, multi-output, high-quality image batches, or budget-sensitive work, inspect the configured provider's limits or balance when that capability is exposed.
   - Mention when retries could compound the cost quickly.
5. Run through the configured tool or provider.
   - Never embed provider credentials in prompts, source files, or generated artifacts.
   - A distribution-provided `run_media_model` may upload local inputs and charge a hosted balance; describe that behavior before using it.
6. Do not add a hard approval gate on your own.
   - Follow the approval policy of the active runtime and provider.
   - Make the price clear before spending and ask when the active policy requires confirmation.
7. Save outputs into the workspace unless the user explicitly wants remote-only results.
8. If these instructions are already loaded in context, do not spend a shell turn re-reading this `SKILL.md` from disk.

## GPT Image 2
- Use `openai/gpt-image-2` for text-to-image work that benefits from high quality, fine typography, product scenes, UI mockups, signage, posters, or detailed realistic images.
- Use `openai/gpt-image-2/edit` for edits such as replacing objects, changing clothing, cleaning backgrounds, relighting, compositing references, or preserving identity/layout while changing a specific element.
- fal describes GPT Image 2 as OpenAI's latest image model, with text-to-image support for detailed images and fine typography, and edit support for fine-grained changes to images.
- GPT Image 2 supports streaming, commercial use, flexible resolutions up to 4K, and multiple output qualities.
- Text-to-image core input:

```json
{
  "prompt": "Describe the scene, subject, important details, use case, and constraints.",
  "image_size": "landscape_4_3",
  "quality": "high",
  "num_images": 1,
  "output_format": "png"
}
```

- Edit core input:

```json
{
  "prompt": "Change: exactly what changes. Preserve: identity, pose, lighting, framing, background, geometry, text, and layout. Constraints: no extra objects, no redesign, no watermark.",
  "image_urls": ["./source.png"],
  "image_size": "auto",
  "quality": "high",
  "num_images": 1,
  "output_format": "png"
}
```

- For masks, add `mask_url` when the edit should be constrained to a region.
- For multiple references, label the roles in the prompt, for example: "Image 1 is the base scene to preserve. Image 2 is the jacket reference."
- For text inside images, specify exact copy, placement, typography, and constraints such as "Render the text verbatim", "No extra words", and "No duplicate text."
- For edits, keep the prompt narrow: one sentence for what changes, one for what stays locked, and one for physical realism.

## Current model examples
- Image examples on fal pages as of April 24, 2026:
- GPT Image 2 text-to-image: `openai/gpt-image-2`; good default for premium image generation, typography, and realistic detailed scenes.
- GPT Image 2 edit: `openai/gpt-image-2/edit`; good default for high-quality image edits with clear preserve/change constraints.
- FLUX Kontext Pro: about `$0.04/image`
- Nano Banana 2: about `$0.08/image` at 1K
- Nano Banana Pro: about `$0.15/image`
- Video examples on fal pages as of April 21, 2026:
- Hailuo 02 Standard: about `$0.045/second`
- Kling 2.5 Turbo Pro: about `$0.07/second`
- Seedance 2.0 Fast: about `$0.2419/second`
- Veo 3.1: from about `$0.10-$0.20/second` on fast/standard 720p/1080p tiers, with higher-cost variants for audio or 4K
- 3D examples on fal pages as of April 21, 2026:
- SAM 3D Objects: about `$0.02/generation`
- Hunyuan3D v2: about `$0.16/generation`
- Tripo3D v2.5 image-to-3d: about `$0.20-$0.40/generation`
- Hunyuan 3D v3.1 Rapid / Pro: about `$0.225` / `$0.375` plus add-ons

## Decision rules
- If the user names a model, still estimate the cost before running it.
- If the user does not name a model, search for candidates and pick one based on quality, latency, editability, and price.
- For image generation or image editing where quality matters more than the cheapest possible draft, start with GPT Image 2.
- For quick ideation, bias toward cheaper image or fast video models.
- For text-heavy graphics, precise editing, or high prompt adherence, favor reasoning-heavy image models after warning about higher cost.
- For long clips, high resolution, audio, or multiple variations, assume the estimate can climb quickly and say so explicitly.

## CLI fallback
If the direct Media AI tools are not exposed but the Interpreter CLI is available:

```bash
interpreter-app tools builtin-media-ai search_media_models --json '{"query":"GPT Image 2 image editing","limit":5}'
interpreter-app tools builtin-media-ai estimate_media_cost --json '{"endpoint_id":"openai/gpt-image-2/edit","num_outputs":1}'
interpreter-app tools builtin-interpreter interpreter_usage_get --json '{}'
interpreter-app tools builtin-media-ai run_media_model --json-file media-run.json
```
