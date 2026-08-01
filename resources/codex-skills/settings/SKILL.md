---
name: "settings"
description: "Use for Interpreter app settings and account usage. Prefer the direct workstation tools for reading settings, changing settings, and checking remaining Interpreter balance; use the Interpreter CLI only as a fallback."
---


# Settings

## When to use
- Read current Interpreter settings.
- Change Interpreter settings.
- Check how much Interpreter usage or balance the user has left.
- Compare planned Media AI spending against remaining balance.

## Workflow
1. Prefer the direct workstation tools when they are exposed in this runtime.
   - `builtin-interpreter__interpreter_settings_get` to inspect settings
   - `builtin-interpreter__interpreter_settings_set` to change settings
   - `builtin-interpreter__interpreter_usage_get` to inspect remaining credits and balance
   - Do not wrap those direct tools in `interpreter-app tools ...` shell commands when the direct tool is already exposed.
2. Use settings reads before settings writes unless the target value is already explicit in the user request.
3. Treat usage reads as the balance source of truth for user-facing cost comparisons.
   - `interpreter_usage_get` returns remaining credits, approximate dollar-equivalent balance, plan allowance, and percent remaining.
   - Use it with `estimate_media_cost` when a task is likely to spend Media AI credits.
4. Remember that some settings changes are approval-gated or restart-gated by the app.
   - If `interpreter_settings_set` says a change needs approval or restart, follow that result instead of trying to work around it.
5. Keep the user-facing explanation direct.
   - Example: "You have about `$Z` of Interpreter balance left, so this estimated media run should fit comfortably."
6. If these instructions are already loaded in context, do not spend a shell turn re-reading this `SKILL.md` from disk.

## CLI fallback
If the direct workstation tools are not exposed but the Interpreter CLI is available:

```bash
interpreter-app config get theme
interpreter-app config get agentAccess
interpreter-app config set theme dark
interpreter-app config set agentAccess.approvalPolicy on-request
interpreter-app tools builtin-interpreter interpreter_usage_get --json '{}'
```

## Decision rules
- Use `interpreter_settings_get` for persistent config, not for live layout state.
- Use `interpreter_get` / `interpreter_set` for live layout, panes, and tabs.
- Use `interpreter_usage_get` for account usage, not `interpreter_settings_get`.
