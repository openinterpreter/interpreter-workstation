<!-- release-notes-for: 0.2.246 -->
## What's new

- Several inputs arriving close together for one conversation (from an automation, a connected channel, or another program) are now passed to the agent in one go and in order, instead of one at a time with a wait between them.
- A program that sends a message to an existing conversation is no longer refused while the agent is busy: the message is saved first, then steers the running turn or starts one, and is kept across a restart. Sending the same message ID again never delivers it twice.
- An automation command may hand over up to 16 inputs per run, one JSON object per line.
- Saving or changing an automation, and receiving an input, no longer wait on reading a long conversation's whole history.
- When several senders add to the same turn, each is told the outcome.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
