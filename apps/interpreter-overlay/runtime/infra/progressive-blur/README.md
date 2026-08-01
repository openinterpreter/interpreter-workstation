# Progressive Blur Helper

`progressive-blur.swift` is the native macOS helper used by the overlay blur system.

## Normal mode

The normal overlay path launches the helper without the tuner UI. It should only receive the runtime height ratio and the standard stdin commands (`show`, `hide`, `exit`).

## Tuner mode

Tuner mode is preview-only. It is enabled explicitly with `--tuning-ui` and is not part of the normal overlay flow.

Example:

```bash
swiftc -O apps/interpreter-overlay/runtime/infra/progressive-blur/progressive-blur.swift -o /tmp/progressive-blur-test
/tmp/progressive-blur-test --tuning-ui
```

Optional height ratio override:

```bash
/tmp/progressive-blur-test 0.42 --tuning-ui
```

The tuner exposes only global generator params. Individual layers are derived from those shared values so the stack stays balanced.

`Copy Params` copies the current preset JSON to the pasteboard.

## Notes

- The archived older helper is kept in `progressive-blur_archived.swift`.
- Material cycling mode was removed.
