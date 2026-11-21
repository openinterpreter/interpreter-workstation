<!-- release-notes-for: 0.2.247 -->
## What's new

- When another agent hands a Goal to a conversation, that agent is now told when the Goal stops, completes or resumes, even if other senders message the conversation afterwards. Previously the most recent sender was told instead, and a sender without its own conversation could make the notice undeliverable.
- A Goal whose assigning agent cannot be determined is listed as unrouted instead of being reported to someone else.
- A Goal blocked by temporary model capacity is reported once straight away as waiting for the automatic retry, and again when it resumes or the retry gives up.
- Goal notices include the Goal's id and revisions when the runtime provides them.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
