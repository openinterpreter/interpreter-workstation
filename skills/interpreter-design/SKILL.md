---
name: interpreter-design
description: Design or revise Interpreter UI for non-developers with an ultra-minimal, utilitarian style inspired by the OpenAI website and ChatGPT, not the developer platform. Use when simplifying settings, onboarding, chat, forms, empty states, or helper copy; when removing extra containers, labels, or visual noise; when replacing technical wording with plain language; when clarifying hierarchy and making the main user action obvious; when making every visible label and status understandable to an average HR admin or other non-technical user; when hiding implementation details such as logs, IDs, endpoints, paths, or protocol names; or when a screen must respect the app's existing CSS variables and light/dark theme behavior.
---

# Interpreter Design

Design for non-developers. Keep the UI quiet, direct, and easy to scan.

## Workflow

1. Read `references/openai-style-guide.md`.
2. Skim `references/openai-screen-index.md`.
3. Open the bundled screenshots in `assets/openai/` if visual calibration is useful.
4. Before changing layout, write this brief to yourself:
   - The user is here to do:
   - The main action is:
   - The user can ignore:
5. Start from the least UI that still explains the task and lets the person act.
6. Run the final reduction pass before finishing.

## Rules

- Every visible label, status, and explanation must make sense to an average HR admin on first read.
- Design around the user's task, not the system's internals.
- Decide what the user most likely needs to do next before choosing a layout.
- Keep the primary action obvious. Keep secondary actions quiet.
- If there is one clear next step, give it clear visual priority.
- If two controls do different jobs, do not style them as equally important by accident.
- Do not place a low-priority note opposite a high-priority action in the same row.
- For install, onboarding, and help surfaces, assume one centered instruction block is enough until proven otherwise.
- Use sentence case. Do not use all-caps titles, eyebrow labels, or loud helper text.
- Prefer spacing, alignment, and thin dividers over cards, nested panels, or heavy borders.
- Use as few containers as possible. Add a box only when it clearly improves comprehension.
- Write short labels and short helper text. Cut filler, hype, and repeated explanation.
- Minimal does not mean cramped. Leave enough room for the main action and the main explanation to breathe.
- Remove developer language unless the feature is explicitly for developers.
- Do not expose technical implementation detail in the visible UI. Hide logs, file paths, IDs, endpoints, protocol names, process states, and similar internals.
- If the product needs internal diagnostics, keep them out of the main interface for non-developers.
- Do not design like the OpenAI developer platform. Use the OpenAI website and ChatGPT product surfaces only.
- Respect the app's existing CSS variables, tokens, and theme system. Do not hardcode a separate light or dark palette when app vars already cover it.
- Make light mode and dark mode both work by leaning on existing variables, not one-off overrides.

## Layout

- Start with one clean column unless the task truly needs more.
- Use side-by-side layouts only when both sides are comparable in importance and type.
- Do not use a hero layout for a settings surface unless the task truly needs one.
- If one heading, one action line, and one quiet fallback line are enough, stop there.
- Keep headings short.
- Avoid narrow columns packed with long text.
- If a row feels pinched, stack it or widen it.
- Group related controls by proximity first, separators second, containers last.
- Let whitespace do most of the structure work.
- Keep explanations close to the control they clarify.
- Avoid dashboard density, enterprise framing, and control-panel chrome.

## Hierarchy

- The screen should answer, in order:
  1. What is this?
  2. What should I do?
  3. What else might I need to know?
- Put the likely next action where the eye lands first.
- Keep status and diagnostics below the action unless they are required to choose the action.
- Notes, caveats, and "this is optional" copy are footnotes. They should not compete with controls.
- Metrics should support a decision, not exist as decoration.
- If a section has a single important action, make the section feel built around that action.
- If the page feels visually balanced but the next step is still unclear, the hierarchy is wrong.
- If the next step is clear but the layout feels cramped, lopsided, or top-heavy, the balance is wrong.

## Balance

- Aim for calm visual balance, not perfect symmetry.
- Do not let one side of a row carry all the weight while the other side carries a footnote or tiny fragment.
- Keep text blocks, actions, and status areas proportionate.
- If a button looks crowded by nearby copy, give it room or change the layout.
- If the top of the screen feels squeezed, reduce copy, widen the content, or stack the elements.
- A simple screen should feel settled and spacious, not compressed.
- Ask: "Does this feel calm and balanced at a glance?"

## Copy

- Use plain words a non-developer understands on first read.
- Write as if the reader works in HR, recruiting, operations, or support, not engineering.
- Explain only what helps the person decide or act.
- Replace technical terms with direct labels.
- Do not make the person learn system architecture to use the feature.
- If a line does not help someone complete the task, delete it.

## Action audit

- List the actions the user can take on this screen.
- Mark one as primary, if one truly is primary.
- Mark the rest as secondary, supportive, or removable.
- Check that the visual weight matches that ranking.
- If you cannot name the primary action, the screen is probably trying to do too much.

## Final pass

- Remove one more container.
- Try replacing the whole screen with one centered instruction block. If the task still works, keep the simpler version.
- Shorten every heading.
- Cut any line that repeats nearby context.
- Replace technical terms with plain language.
- Remove any visible information an average HR admin would not immediately understand.
- Remove any logs, IDs, endpoints, file paths, protocol names, or implementation detail from the main UI.
- Check that the first thing the user sees is the thing they most likely need to do.
- Check that helper text, notes, and statuses do not compete with the main action.
- Ask: "What is this person here to do, and did I make that easy?"
- Ask: "Does the composition feel balanced, calm, and easy to scan?"
- Check that the screen still reads clearly in both light and dark mode using existing app vars.
- Ask: "Would a non-developer understand this immediately?" If not, simplify again.

## References

- Use `references/openai-style-guide.md` for the distilled rules.
- Use `references/openai-screen-index.md` for the bundled OpenAI screenshots and what to learn from each.
