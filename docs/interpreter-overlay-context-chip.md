# Interpreter Overlay Context Chip

## In Scope Now

Implement the overlay input so the current screen context appears as a removable chip before the prompt text:

- If the user had an active selection before opening the overlay, show a chip labeled `[selection]`.
- Hovering that chip should reveal the selected content, with as much fidelity as we can capture from the source selection.
- If there is no active selection, show a chip labeled `[screen contents]`.
- If the user draws a scope/region in the overlay, switch the chip to `[screen region]`.
- The prompt placeholder should sit to the right of that chip instead of taking the whole empty field.
- The context chip must remain a normal removable chip so the user can delete it.
- Deleting the chip should allow submitting a plain overlay request with no screen context attached.

## Deferred For Later

These are intentionally not part of this implementation pass:

- Show an always-on overlay notification pill whenever an overlay agent is working in the background.
- Place that pill below a selected region while attached, then move it to the upper-left when the agent detaches.
- Show a transition message like `Moved to the background...` when that move happens.
- Keep the background pill updated with a one-line live summary of what the agent is doing.
- Reuse the same visual language as the existing in-overlay working pills.
- Clicking the background pill should dismiss the pill and reveal the Interpreter tab/window for that agent.
