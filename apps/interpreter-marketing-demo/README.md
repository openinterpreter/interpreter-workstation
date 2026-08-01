# Interpreter Marketing Demo

This target builds the public browser demo as a static site.

It is the real Interpreter renderer running in a browser-safe demo mode, not a lookalike mock.

## Goals

- Reuse the real Interpreter renderer.
- Run entirely in marketing demo mode.
- Never require auth, SSE, or the app backend.
- Avoid touching the normal desktop build and release path.

## Architecture

There are two distinct layers:

1. `apps/interpreter-marketing-demo/`
   - builds the actual app surface as a static Vite app
   - runs the normal renderer entrypoint
   - forces `marketing demo` mode so the app never talks to the real backend

2. `website /demo`
   - provides the marketing page: headline, button, surrounding layout
   - embeds the hosted demo in an iframe
   - owns the outer "window" shell around the app preview

The important rule is:

- the hosted demo should behave like a fullscreen app inside its own rectangle
- the marketing page should own the decorative framing around it

That keeps the app layout honest. The app already assumes a full viewport. If we steal internal height or inset the app itself, the bottom of the UI gets clipped.

## Why The Shell Lives On The Marketing Page

The marketing page wants a lightweight fake OS/window treatment around the app.

The app itself should not be resized inward to create that shell. Instead:

- the iframe gets the full app viewport
- the outer website wrapper draws the light gray / dark shell behind it
- the demo app root stays transparent so the shell can show through where the app uses transparent surfaces

This avoids the failure mode we hit earlier where internal padding made the app look clipped at the bottom.

## Demo Data Model

The demo data lives in `src/demo/marketingDemo.ts`.

That file is the source of truth for:

- the seeded workspace tree
- seeded tabs and sidebar state
- seeded agent threads
- scripted suggestion-pill flows
- fake IPC responses for browser-safe features

The current workspace is a generalist robotics knowledge base centered on:

- `AGENTS.md`
- raw robotics/company notes
- compiled wiki pages
- an original, generated research-note PDF asset inspired by the `pi0` topic

The goal is to make the workspace feel plausible and internally consistent, not to advertise that it is a demo.

## Use Case Pages

The hosted demo now supports multiple seeded workspaces behind one renderer.

The website passes:

- `?useCase=<id>` to choose the seeded workspace, tabs, sidebar transcript, and scripted prompt set
- `?autoplayPrompt=<id>` to pick which suggestion-chip flow should play on load

That keeps the marketing pages aligned with the real app shell:

- the website owns the page copy and the outer wrapper
- the iframe still runs the real Interpreter renderer
- each use case is just a different seeded workspace plus a different scripted prompt

Current use cases:

- `research-synthesis`
- `w4-form-filler`
- `expense-report-automation`
- `nda-redlining`

## Adding A New Use Case

When you add a new niche landing page, keep the work in this order:

1. Add the new landing-page metadata in `website/src/lib/use-cases.ts`.
2. Add a matching seeded workspace override in `src/demo/marketingDemo.ts`.
3. Add any bundled assets the workspace needs under `apps/interpreter-marketing-demo/public/`.
4. Regenerate thumbnails with `pnpm exec tsx scripts/generate-marketing-demo-thumbnails.ts`.
5. Verify the standalone demo with `pnpm run marketing-demo:build`.
6. Verify the website wrapper with `pnpm -C website build`.

The important constraint is: do not build a separate mock for each page. Reuse the same renderer, the same layout, and the same suggestion-chip playback path, then swap only:

- seeded files
- scripted prompts
- sidebar seed transcript
- page copy

## IPC Strategy

The browser demo does not run the real backend.

Instead, `src/ipc.ts` switches selected namespaces to demo-safe implementations from `src/demo/marketingDemo.ts` when marketing demo mode is active.

Examples:

- workspace listing
- file reads
- file stats
- tab creation
- sidebar agent state
- theme/background/window state
- thumbnail responses

What stays disabled:

- auth
- SSE/event streams to the real backend
- tool execution
- arbitrary filesystem access
- real mutations outside the seeded in-memory workspace

## Thumbnails And File Icons

The web demo cannot rely on the desktop app's live OS thumbnail pipeline, because there is no privileged local filesystem backend behind the hosted demo.

So the marketing demo ships prebuilt visual assets as static files:

- Quick Look preview thumbnails for seeded documents
- macOS file-type icons for explorer/file-row fallback states

Current flow:

1. The seeded workspace files come from `src/demo/marketingDemo.ts`.
2. `scripts/generate-marketing-demo-thumbnails.ts` materializes those files into a temporary workspace on macOS.
3. The script uses `qlmanage` to generate real Quick Look thumbnails.
4. The script also uses `scripts/export-file-icon.swift` to export macOS file-type icons for markdown, PDF, and generic fallback files.
5. The generated PNGs are written into:
   - `apps/interpreter-marketing-demo/public/thumbnails/`
   - `apps/interpreter-marketing-demo/public/file-icons/`
6. The demo workspace tree returns the same metadata shape the app expects:
   - `fileIcon`
   - `thumbnailWidth`
   - `thumbnailHeight`
7. The demo file-thumbnail IPC returns the shipped preview asset URLs for seeded files.

This keeps the browser demo static and backend-free while still feeding the renderer realistic macOS-like file visuals.

Regenerate them with:

```bash
pnpm exec tsx scripts/generate-marketing-demo-thumbnails.ts
```

Notes:

- this currently depends on macOS Quick Look (`qlmanage`)
- the script handles duplicate filenames like multiple `SKILL.md` files by assigning deterministic asset names based on workspace-relative paths

## Theme Sync

The marketing page passes `?theme=light` or `?theme=dark` to the demo URL.

The hosted demo reads that query param and mirrors it into the app's theme IPC so the iframe stays in sync with the website theme. If there is no explicit theme param, the standalone demo falls back to `prefers-color-scheme`.

## Fade-In

The iframe does not just appear immediately.

The app posts an `interpreter-marketing-demo-ready` message after the renderer is actually mounted, and the website waits for that message before fading the embed in. There is still a timeout fallback for safety, but the primary path is the ready event.

## Local Development

From the repo root:

```bash
pnpm run marketing-demo:dev
```

That starts the standalone app demo directly.

Preview the production build locally:

```bash
pnpm run marketing-demo:build
pnpm run marketing-demo:preview
```

The preview server prefers port `4174`, but it may move to the next available port if that one is busy.

If you want to inspect the full landing-page composition locally as well:

```bash
pnpm -C website build
node website/scripts/next-with-dist-dir.cjs start -H 127.0.0.1 -p 3310
```

Then open:

- app surface only: `http://127.0.0.1:4174/` or whatever preview port Vite chose
- website wrapper: `http://127.0.0.1:3310/demo`

## Process For Updating The Demo

When changing the marketing demo, keep this order:

1. Update the seeded workspace / agent scenarios in `src/demo/marketingDemo.ts`.
2. If seeded files changed, regenerate shipped thumbnails.
3. Verify the standalone app surface first.
4. Verify the website embed second.
5. Only after both look right, deploy the standalone demo and then, separately, the website.

That sequencing matters. The hosted app and the marketing wrapper are two separate products with different responsibilities.

## Vercel

Use a separate Vercel project for this demo.

- Root Directory: the repo root
- Build Command: `pnpm run marketing-demo:build`
- Output Directory: `apps/interpreter-marketing-demo/dist`

That keeps dependency installation on the normal repo root and avoids adding a second package graph just for the demo.

If you want to minimize what Vercel receives, do not connect the whole repository as a Git-based Vercel project. Instead, build the static demo first and deploy the generated `dist/` folder to a dedicated Vercel project. The GitHub Actions workflow in `../../.github/workflows/interpreter-marketing-demo-deploy.yml` does exactly that.

## Deployment Shape

Recommended public shape:

- hosted demo app: `interpreter-marketing-demo.vercel.app`
- marketing wrapper: `openinterpreter.com/demo`

That split keeps:

- the app surface reusable
- the marketing page simpler
- the public demo isolated from the main app backend

## Non-Goals

This target is not trying to be a fully functional web version of Interpreter.

It is intentionally:

- static
- seeded
- bounded
- safe to host publicly

It should feel real, but it should not require the desktop trust boundary.
