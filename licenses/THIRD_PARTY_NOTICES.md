# Interpreter Workstation third-party notices

This file records explicit license choices and manual resolutions that are not
fully represented by npm package metadata. It accompanies, and does not replace,
the complete production dependency inventory generated from `pnpm-lock.yaml`.

## JSZip 3.10.1 — MIT selected

Interpreter Workstation uses JSZip under the MIT option of its
`MIT OR GPL-3.0-or-later` license expression.

Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger,
António Afonso

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## shadcn UI CSS variants — MIT

The retained UI variants in `src/styles/shadcn-compat.css` and
`shadcn-preset/preset-app/app/shadcn-compat.css` are adapted from shadcn's
MIT-licensed CSS. Copyright (c) 2023 shadcn. The full MIT permission and
disclaimer immediately above apply to these adapted styles as well.

## buffers 0.1.1 — MIT manual resolution

The npm tarball for `buffers@0.1.1` predates npm's license metadata field and is
reported as `Unknown` by `pnpm licenses list`. Debian's reviewed source record
identifies the upstream package as MIT and links the upstream commit that added
that declaration:

- https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/
- https://github.com/substack/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87

Copyright (c) 2015 James Halliday

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## sharp-libvips 1.2.4, 1.3.2, and 1.3.3 shared libraries

Platform packages matching `@img/sharp-libvips-*` contain precompiled shared
libraries. Their npm metadata reports `LGPL-3.0-or-later`, and their component
versions are recorded in each package's `versions.json`.

- Browser-extension relay runtime source: https://github.com/lovell/sharp-libvips/tree/v1.2.4
- Browser-extension relay source archive: https://github.com/lovell/sharp-libvips/archive/refs/tags/v1.2.4.tar.gz
- Exact packaging/build source: https://github.com/lovell/sharp-libvips/tree/v1.3.2
- Source archive: https://github.com/lovell/sharp-libvips/archive/refs/tags/v1.3.2.tar.gz
- Current packaging/build source: https://github.com/lovell/sharp-libvips/tree/v1.3.3
- Current source archive: https://github.com/lovell/sharp-libvips/archive/refs/tags/v1.3.3.tar.gz
- Preserved upstream component notices:
  `sharp-libvips-v1.2.4-THIRD-PARTY-NOTICES.md` and
  `sharp-libvips-v1.3.2-THIRD-PARTY-NOTICES.md`, and
  `sharp-libvips-v1.3.3-THIRD-PARTY-NOTICES.md`
- License texts: `LGPL-3.0.txt` and its incorporated `GPL-3.0.txt`

The frozen pnpm inventory conservatively reports the 1.3.3 packages even when a
target artifact does not contain them. The separately generated browser relay
runtime currently bundles a platform-specific 1.2.4 package outside the
application ASAR. Release checks inspect both dependency trees and require an
exact policy match. These libraries remain dynamically loaded, unmodified, and
replaceable. Workstation imposes no contractual restriction on reverse
engineering for debugging modifications to an LGPL-covered library.
