# Headless ordinary tool approvals

An operator of a dedicated headless Workstation can set
`headlessToolApprovalMode: "ordinary-auto"` in the host's protected
configuration **together with** `codexApprovalPolicy: "never"`. The setting is
operator-owned; agents cannot change it through `interpreter_settings_set`.
It affects subsequent calls after the host has loaded that configuration; it
does not retroactively answer already-pending approval cards. A restart or
update needs an independent queue/approval/wake custody plan.

The ordinary mode lets the native Computer Use driver list apps, inspect, and
control the desktop without an invisible approval prompt when the relevant
inspect/control setting says `ask`. An explicit `deny` remains a denial. The
browser relay's `ask` permission receives a temporary, current-tab/action
grant, not a stored site-wide grant; its `deny` remains a denial. Native and
direct MCP paths may answer only bound first-party Sites metadata reads
(`sites.get_site`, `sites.list_sites`); the direct path additionally requires
an authenticated caller/thread binding. Create, publish, upload, arbitrary
MCP servers and provider gateways do not receive an implicit grant.

Native Codex command/file permissions still follow their own sandbox and
approval policy. If a request nevertheless reaches an exceptional approval
path in unattended mode, it is declined rather than queued indefinitely.
Filesystem deletion, writes outside the configured workspace, unknown MCP
elicitation and explicit provider/irreversible-action gates remain denied or
subject to their separate authorized path. Errors are terminal and visible to
the agent; an authentication or unsupported-driver failure is not turned into
permission. This mode neither provides an identity nor repairs a failed
provider-command wake source.

For acceptance on each installed worker, verify the effective loaded host
revision and both configuration values; inspect pending cards and native
queue/wake custody; submit a new harmless browser inspect and navigation and
one bounded native Computer Use action on an authorized tab; confirm terminal
results without a pending approval or lock; then independently verify that a
configured deny and a nonordinary provider/create call still fail closed. Do
not replay an ambiguous wake or discard an old approval to test this mode.
