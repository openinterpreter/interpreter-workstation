# React Compiler

React Compiler is enabled in `vite.config.ts` to let React apply build-time memoization to eligible components and hooks. The goal is to reduce repeated render work without adding more hand-written `useMemo`, `useCallback`, or `React.memo` around normal render code.

Live references:

- React Compiler overview: https://react.dev/learn/react-compiler
- Installation and build-tool setup: https://react.dev/learn/react-compiler/installation
- `panicThreshold` behavior: https://react.dev/reference/react-compiler/panicThreshold
- Compiler directives, including `"use no memo"`: https://react.dev/reference/react-compiler/directives

CI runs `pnpm run check:react-compiler`, which sets `REACT_COMPILER_PANIC_THRESHOLD=all_errors` before `pnpm run build:renderer`. Local production builds keep React's recommended production behavior by defaulting `panicThreshold` to `none`.

Measured on 2026-06-01 with `pnpm run build:renderer` after the React 19/compiler migration:

- React 18 baseline: Vite built in `39.72s`; main renderer chunk `6,243.34 kB` gzip `1,968.44 kB`; secondary renderer chunk `1,123.34 kB` gzip `341.42 kB`; overlay chunk `75.51 kB` gzip `22.53 kB`.
- React 19 plus React Compiler strict gate, `REACT_COMPILER_PANIC_THRESHOLD=all_errors`: Vite built in `42.19s`; main renderer chunk `6,328.31 kB` gzip `2,003.98 kB`; secondary renderer chunk `1,123.70 kB` gzip `341.56 kB`; overlay chunk `93.07 kB` gzip `29.82 kB`.
- React 19 plus React Compiler normal production build: Vite built in `42.55s` with the same measured chunk sizes as the strict gate.

The build-time measurement is intentionally lightweight: it proves the compiler gate is live and keeps bundle/runtime cost visible, but it is not a claim of user-perceived speedup by itself. Runtime render improvements should be cited with a focused interaction benchmark before using them to justify broader memoization policy changes.

Use `"use no memo"` only as an explicit compiler boundary for imperative runtime surfaces where optimization must not rewrite control flow around external state, IPC listeners, native bridge setup, terminal or speech playback control, rich document editors, media frame buffering, document canvas rendering, message sending, onboarding setup flows, or other side-effect-heavy integration code. Ordinary render components should be made compiler-safe instead of opted out.
