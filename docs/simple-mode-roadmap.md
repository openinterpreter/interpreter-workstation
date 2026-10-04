# Simple mode follow-on roadmap

The desktop Simple-mode core is implemented in this sprint. This roadmap is
limited to work that Killian explicitly deferred; it is not a place to move
unfinished desktop requirements.

## Deferred product work

1. Apply the separate addendum after the core desktop experience is accepted.
2. Build the iPhone/mobile application and decide its native interaction model.
3. Build native mobile QR scanning on top of the implemented private pairing
   protocol, and add managed Tailscale enrollment/provisioning where needed.
4. Extend enterprise policy for remote/mobile and optional channel controls.
5. Add email or text ingress only when the required channel APIs exist.

## Release follow-through

- Repeat funded GPT Live audio and real WhatsApp phone-link acceptance on every
  release that changes those transports.
- Expand the visual catalog as Workstation gains new canonical file surfaces;
  generated interfaces should continue importing the host component rather
  than copying it.
- Keep the app-owned interface-design skill and Motion runtime versioned with
  Workstation releases while preserving user project source.
