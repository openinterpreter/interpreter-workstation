export const SIMPLE_INTERFACE_DESIGN_SKILL = `---
name: simple-interface-design
description: Design and maintain the active Interpreter Simple-mode React interface.
---

# Simple interface design

Read this file before changing visible interface code. This file is owned by
Interpreter and may be refreshed when the application updates.

## Mental model

The project is a normal React application, edited live by the same durable
agent the user is speaking with. It is not a JSON renderer and it is not a
collection of native declarative screens. Use React state, events, composition,
and normal application logic. Keep the experience direct: the interface is the
work, while Interpreter supplies the single composer, conversation drawer,
settings, model controls, voice, and channel routing around it.

## Design posture: a live answer, not a web page

The interface is already inside Interpreter. Do not add a marketing-page hero,
navigation bar, explanatory subtitle, dashboard chrome, or a large title merely
to name the thing the user asked for. Put the requested object, file, image,
canvas, control, or result at the visual center and remove everything that does
not help the user inspect or manipulate it.

Prefer a single-screen composition that fits above the Interpreter composer.
Use the full viewport when the content benefits from it, but keep the active
work centered with calm negative space. Scroll only when the actual material
requires it. A useful default is one primary object plus one compact supporting
control group—not a stack of cards. Never generate placeholder metrics,
eyebrows, feature grids, or decorative prose.

Keep the visual language close to Motion Primitives: restrained neutral
surfaces, precise typography, quiet hairlines, rounded controls, and motion that
preserves continuity. Avoid gradients, colorful dashboard palettes, oversized
headings, and indiscriminate entrance animation. The interface should feel as
minimal as the request permits, not as elaborate as React permits.

## Maintained imports

Import layout, host capabilities, and durable state from
\`@interpreter/interface\`:

\`Page\`, \`Stack\`, \`Row\`, \`Grid\`, \`Section\`, \`Card\`, \`Heading\`,
\`Text\`, \`Badge\`, \`Button\`, \`TextInput\`, \`Image\`, \`ImageGrid\`, \`Markdown\`,
\`FileViewer\`, \`FolderViewer\`, \`DropZone\`, \`useFilesDropped\`,
\`usePersistentState\`, \`readState\`, \`writeState\`, \`runAgent\`, and
\`sendMessage\`.

Import animation and interaction primitives from \`@interpreter/motion\`.
This is Interpreter's app-shipped adaptation of Motion Primitives by Julian
Ibelik. Prefer \`AnimatedGroup\`, \`TextEffect\`, \`TextShimmer\`, \`InView\`,
and \`TransitionPanel\` over improvised entrance animation. Motion should
explain change, preserve spatial continuity, and never animate every element
by default.

## Files and selection

Use \`FileViewer path="notes.md"\` to display or edit a file with Workstation's
canonical viewer/editor for its type. Use \`FolderViewer path="."\` for the
canonical searchable file tree. Paths are resolved inside this project unless
the user explicitly dropped an external file or folder into the interface.
Text selected in an interface or hosted file viewer is automatically placed in
the primary agent's normal selection context.

These are not imitations. The host mounts Workstation's real editor and file
tree into the rectangles reserved by \`FileViewer\` and \`FolderViewer\`. A
Markdown file shown with \`FileViewer\` is the same editable Markdown surface as
Advanced mode and saves through the same file path. Use the viewer rather than
recreating Markdown editing, code editing, PDF display, document preview,
spreadsheet viewing, image viewing, or folder search in project React.

Choose the component from the object, not from habit:

- a known file path: \`FileViewer\`;
- a folder or search/browse task: \`FolderViewer\`;
- prose generated only for this interface: \`Markdown\`;
- a media collection: \`ImageGrid\` for the maintained responsive grid,
  lightbox, keyboard dismissal, and optional show-in-folder action;
- a file the user drops: place it into the visible composition using its drop
  point and intent, then use the canonical viewer when it should be editable.

## Durable state and live editing

Use \`usePersistentState\` for meaningful application state. Give every input,
textarea, and select a stable \`name\` or \`data-interpreter-state-key\` so the
host can preserve in-progress control values, focus, and scroll across live
code updates. Never clear user input merely because the agent edited the
interface. Update the existing composition in place; do not replace useful
state or structure with a generic starter.

## Layout and drag and drop

Use a small responsive grid with clear empty space. \`Grid min={240}\` adapts
without viewport-specific branches. A normal starter interface should wrap its
working canvas in \`DropZone\` and make dropped files land where the user would
expect: images on a canvas, documents in a collection, or files in an open
workspace. The bridge plumbing is intentionally invisible. Design the React
interaction, not a special upload protocol.

Start with the smallest composition that can do the job. Keep critical controls
visible without scrolling at common desktop sizes. Do not wrap every region in
a card, and do not add section titles when spatial arrangement already explains
the interface. If content grows, preserve the primary object and let only the
supporting region scroll where possible.

## Interface-run agents

For visible research or search work, call \`runAgent({ message, onEvent })\`.
Render its streaming events in the relevant part of the interface so the user
can see the work. When the focused subagent finishes, communicate the useful
result to the primary durable thread with the ordinary primitive:

\`await sendMessage('Research finished: ...')\`

There is no separate task inbox or polling protocol. An interface action is
either local React behavior, a focused agent run, or a normal message to the
same durable conversation.

## Channel behavior

The visible desktop interface may send ordinary messages to its primary
conversation. A request received through WhatsApp must be answered through
WhatsApp because that person cannot see this interface. GPT Live belongs to
the voice channel. Never claim a desktop-only visual is a reply to a remote
user.

## Quality bar

- Preserve the user's content and state.
- Use one obvious visual hierarchy and restrained surfaces.
- Make empty, loading, streaming, success, and failure states intentional.
- Keep keyboard and screen-reader behavior correct.
- Compile after every coherent change. If compilation fails, fix it; the host
  will keep the last known-good interface visible in the meantime.
- Inspect the rendered result at realistic window sizes before calling it done.
- Exercise every visible control and at least one failure or empty state.
- If a file is displayed, prove that the canonical Workstation surface is
  actually mounted; for editable types such as Markdown, make an edit and prove
  it reaches disk.
- Use the app's visual inspection/computer-use capability after compiling. Do
  not declare a design complete from source alone.
`;

export const SIMPLE_INTERFACE_MANAGED_AGENTS = `# Interpreter interface project

This folder is one standalone Simple-mode React interface project. It is not a
route inside another interface. Work under \`src/\`; keep static assets under
\`public/\`. Interpreter owns hidden \`.interpreter/\` metadata and runtime files.

Before designing or editing the visible interface, read the app-maintained
skill at \`.interpreter/skills/interface-design/SKILL.md\` completely. It defines
the supported component library, Motion Primitives, durable state rules, file
viewers, drag and drop, selection, agent runs, and channel behavior.

Update the current interface in place. Preserve useful structure and state.
Do not create another composer, chat, settings shell, model picker, or floating
assistant inside the project; Interpreter already supplies those surfaces.
Work inside this project unless the user explicitly requests otherwise.

This is the visible project for one long-lived primary Interpreter conversation.
Messages can arrive from the composer, this interface, the desktop overlay, GPT Live,
or WhatsApp. Preserve that ingress metadata and reply through the originating remote
channel when the sender cannot see the desktop. For substantial independent work,
delegate to background agents when available so the primary conversation remains ready
for the user's next steering message. Do not create a replacement primary conversation.
`;
