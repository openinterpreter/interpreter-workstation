# Simple mode: follow-up roadmap

This sprint establishes the default desktop Simple workspace, its primary
conversation, editable filesystem-backed interface, and reversible Advanced
mode. It intentionally does **not** implement these independent follow-ups:

- iPhone/Android apps, phone pairing, QR enrollment and notification delivery;
- Tailscale or other peer-to-peer transport, remote/mobile serving or enrollment;
- the separate September 30 simplification addendum;
- optional WhatsApp/voice/email/text channels and their enterprise policy,
  sender verification, consent, revocation and outbound-delivery controls;
- multiple named interface windows, global detached pill choreography,
  selected-region screenshot delivery, and rich editable document components.

The current Advanced overlay and its capture affordances remain available.
The Simple overlay should reuse the primary conversation for text and selected
context rather than creating another thread; unsupported attachments must
fail visibly until their permission and delivery contract is implemented.
No mobile or remotely reachable service is required for the local core.
