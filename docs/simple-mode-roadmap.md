# Simple mode roadmap

Simple and Advanced are two experiences in the same Workstation application.
The local project format, interface runtime, and conversation bridge remain
usable without a hosted account.

## Future capabilities

- Future native phone clients should use a versioned, project-scoped remote
  session contract while supplying their own native composer and pairing UI.
- Managed device enrollment and enterprise policy can later provide private
  remote access without changing the local project format.
- Further messaging channels should use the existing durable conversation and
  explicit per-channel authorization rather than creating separate agents.
- Investigate a safe, supported macOS Messages self-text integration. The
  intended behavior is that a message to yourself wakes the explicitly bound
  durable thread; no Messages bridge or entitlement is shipped yet.

## Ongoing verification

- Exercise real audio input and output when GPT Live changes, and verify a
  real phone link when the optional messaging bridge changes.
- Keep generated interfaces on the maintained host file viewers and versioned
  app-owned interface-design and Motion resources; preserve user project source.
