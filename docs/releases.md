# Official releases

Interpreter Workstation has one public source tree and one public production
release implementation. The official product is a configured and signed build
of this repository, not a private fork.

## What counts as an official build

An official Interpreter Workstation release must satisfy every condition below:

- source is the exact protected `main` commit named by the GitHub release;
- the checked-in `distribution/product.official.json` profile is used;
- every submodule and the bundled OIX release are pinned and recorded;
- macOS applications are Developer ID signed, notarized, and stapled;
- Windows applications and installers carry a valid Authenticode signature;
- Linux packages come from the same workflow run and source commit;
- `SHA256SUMS`, `RELEASE-MANIFEST.json`, and `SBOM.spdx.json` are published;
- GitHub records both build-provenance and SBOM attestations for the artifacts;
- binaries reach the public release bucket and the GitHub release becomes
  public before auto-update manifests are published, so clients never discover
  a partial or hidden release.

A local package, a pull-request artifact, or an internal candidate is useful
for review but is not an official build.

## Release authority

The `Official release` workflow is manual, accepts only the protected `main`
branch, and hard-gates the initiating GitHub actor to the dedicated
`interpreterwork` automation identity. Signing and storage
credentials live only in the `production-release` GitHub Environment. The
environment requires explicit approval from the project owner before jobs can
use those credentials or publish a release.

The workflow deliberately separates source verification, platform packaging,
and final publication. GitHub Actions logs may identify certificates, files,
and public service coordinates; they must never print private keys, passwords,
client secrets, or storage write credentials.

Storage credentials are scoped to the upload steps, and the workflow publishes
the auto-update manifests only after the immutable payloads and GitHub release
are public. Those manifests are the final commit point for installed clients.

## Release procedure

1. Merge a version bump and all intended release changes to protected `main`.
2. Confirm all required CI and DCO checks pass on that commit.
3. Dispatch `Official release` from `main` with the confirmation value
   `release`.
4. Review and approve the pending `production-release` deployment.
5. Let every platform build and signature check finish.
6. Review and approve final publication if GitHub requests a second deployment
   approval.
7. Verify the public GitHub release, Supabase update manifests, and one clean
   installation/update on each supported operating-system family.

The workflow refuses an existing version tag. Advance `publicVersion` rather
than replacing a published binary or mutating a release in place.

## Verifying a download

Download the relevant binary and `SHA256SUMS` from the GitHub release, then
verify its digest with the platform's SHA-256 tool. GitHub CLI can validate the
signed provenance record:

```bash
gh attestation verify ./Interpreter-<platform>-<arch>-<version>.<ext> \
  --repo openinterpreter/interpreter-workstation
```

`RELEASE-MANIFEST.json` ties the files to the source commit, OIX release,
submodule commits, and workflow run. `SBOM.spdx.json` provides the release
software bill of materials. Platform-native signature inspection remains an
independent verification boundary and should also be used for managed
deployment.

## Reproducibility boundary

The repository makes the source inputs and build recipe public and pins runtime
inputs. Apple notarization timestamps, Authenticode timestamps, Electron
packaging metadata, and platform toolchains can keep independently rebuilt
archives from being byte-for-byte identical. The supported reproducibility
claim is therefore traceable inputs plus verifiable CI provenance, not a false
promise that every archive is bit-identical on arbitrary machines.
