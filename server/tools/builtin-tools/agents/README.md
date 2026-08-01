# DOCX Tooling Note

The old DOCX-specific subagent surface has been removed.

Use the regular builtin DOCX tools instead:

- `create_docx`
- `read_docx`
- `read_word`
- `replace_text_in_docx`
- `add_docx_relationship`
- `add_docx_image`

Generic Codex headless-agent helpers still live in this folder because other app flows use them, but DOCX editing is no longer implemented as a model-facing subagent tool.
