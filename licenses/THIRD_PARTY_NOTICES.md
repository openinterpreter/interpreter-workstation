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

## node-forge 1.4.0 — BSD-3-Clause selected

Interpreter Workstation uses node-forge under the BSD-3-Clause option of its
`BSD-3-Clause OR GPL-2.0` license expression.

Copyright (c) 2010, Digital Bazaar, Inc.  
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of Digital Bazaar, Inc. nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

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
