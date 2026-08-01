# Enterprise deployment

Interpreter Workstation is intended to be deployable as an organization's
primary AI work surface, using the same application source as the community
edition.

## Deployment model

Organizations build a distribution overlay that selects hosted endpoints,
account behavior, update infrastructure, optional integrations, and branding.
Employees can also use direct provider credentials or approved local models when
policy permits. A private release repository should stay thin and consume this
repository at an audited commit.

## Current controls

- per-agent filesystem scopes bounded by global policy
- explicit approval for consequential local tool actions
- account-optional community operation
- configurable OIX providers, models, and harnesses through the shared
  app-server contract
- configurable telemetry with an off-by-default community baseline
- pinned browser-extension and computer-use dependencies
- local execution and workspace isolation boundaries

## Production checklist

Before a broad employee rollout, an operator should define and verify:

1. approved providers, model endpoints, and data-retention terms
2. managed filesystem, shell, browser, and computer-use policy
3. identity, device enrollment, session revocation, and secure credential storage
4. signed updates, rollout rings, rollback, and minimum-version enforcement
5. extension allowlists and pinned dependency provenance
6. audit export, support diagnostics, and privacy-preserving retention
7. proxy, certificate, offline, and restricted-network behavior
8. platform packaging and endpoint-management deployment on macOS, Windows, and
   Linux
9. red-team coverage for prompt injection, confused-deputy behavior, data
   exfiltration, and cross-agent scope escape
10. incident response, vulnerability intake, and dependency-update ownership

This document distinguishes source readiness from enterprise general
availability. The community source and distribution boundary can be published
before every managed-enterprise control is complete, but deployments should not
claim a control until it has been tested end to end.

