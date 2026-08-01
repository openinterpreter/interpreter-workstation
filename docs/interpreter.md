# Interpreter

Interpreter is the app, the product identity, and the name the agent should use when referring to itself in this app.

## Basic model

- `interpreter-app config ...` changes persistent app settings.
- `interpreter-app layout ...` changes the live UI layout.
- `interpreter-app tools ...` exposes installed structured app tools.
- Adding or connecting an MCP/integration happens through `interpreter-app tools ...`, not a separate installer command.
- Approvals are raised by the app when a setting or operation is sensitive.

## Operating rule

If something can be learned from:

- `interpreter-app --help`
- `interpreter-app config --help`
- `interpreter-app layout --help`
- `interpreter-app tools --help`
- `interpreter-app tools list <server-id>`
- `interpreter-app tools <server-id> <tool-name> --help`

then that CLI/help surface is the source of truth.

Keep broader product identity and concepts here. Do not duplicate detailed operational docs here when the CLI already exposes them.
