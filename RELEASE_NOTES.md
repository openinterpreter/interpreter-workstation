<!-- release-notes-for: 0.2.245 -->
## What's new

- A Goal that is resumed now continues even when its thread was not loaded; the resume result says whether a live thread owns the Goal.
- In an agent's shell, the `interpreter` command now runs the same bundled runtime the app is using, with its sign-in, instead of another installation found on your PATH.
- A Goal resumes by itself after a temporary model-capacity error, and the agent that assigned the work is told when a Goal stops or resumes.
- A Goal whose objective was changed can be read again by a supervising agent.
- Applications opened through computer use no longer inherit the app's internal environment settings.
- When the interface is opened somewhere that does not provide update notes or skills, Simple mode no longer shows "Could not load the update note" and the composer no longer reports a skills error; it simply shows no note and no skills.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
