# Third-party notices

Continuum's own code and documentation use the [MIT License](./LICENSE). This does not replace the licenses of its dependencies, native libraries, external tools, models or media.

## JavaScript dependencies

The [locked dependency inventory](./docs/dependency-licenses.md) lists every package, version, license expression and exact npm source archive from `package-lock.json`, including development and optional platform packages. Regenerate it after changing the lockfile with `npm run licenses:update`. Upstream npm packages retain their own license and copyright files.

React, React DOM, React Flow, Zustand, Yjs, lib0, y-protocols, y-indexeddb, ws and undici are among the MIT-licensed dependencies. idb and several D3 packages use ISC; d3-ease uses BSD-3-Clause. Refer to the inventory for the complete list rather than treating every dependency as MIT.

`npm run build` also emits `dist/third-party-licenses.md`, containing copyright and license texts for dependencies included in the actual frontend bundle. Preserve this file when distributing the built application. The source repository does not include `node_modules`, compiled dependency binaries or browser executables.

## Icons

Interface icons use [Lucide](https://github.com/lucide-icons/lucide). Lucide's license includes ISC terms and MIT terms for icons derived from Feather. Both notices are reproduced below from the locked `lucide-react` package. The project brand SVG is maintained separately in `public/continuum-logo.svg` and `src/components/shell/ContinuumLogo.tsx`.

## Sharp and native media libraries

[Sharp](https://github.com/lovell/sharp) is Apache-2.0 licensed. Its platform packages contain [libvips and other native dependencies](https://github.com/lovell/sharp-libvips), with LGPL-3.0-or-later and other licenses; the combined expressions in the inventory must not be simplified to MIT or Apache-2.0.

The platform package README and `versions.json` identify the bundled libraries and versions. Upstream build/source information is maintained in [sharp-libvips](https://github.com/lovell/sharp-libvips) and [libvips](https://github.com/libvips/libvips). See [Sharp's installation and licensing documentation](https://sharp.pixelplumbing.com/install/#licensing).

This repository distributes application source, not a repackaged native binary bundle. If distributing an installer, container or packaged backend containing these binaries, retain their notices, provide the corresponding source and build information as required by their licenses, and preserve users' rights to replace or modify LGPL components. A frontend license bundle alone does not cover the native backend components.

Build tools include MPL-2.0-licensed Lightning CSS and Apache-2.0-licensed tools. They are separate upstream packages; their source and notices remain available from the locked archives. Modifying or redistributing their files requires following their own terms.

## Optional tools and external services

Remote sharing can download [Cloudflare cloudflared](https://github.com/cloudflare/cloudflared), a separately distributed Apache-2.0-licensed tool. It is not checked into this repository. Its upstream licenses and notices apply if it is included in a separate distribution.

Provider/model names identify compatible services and do not imply sponsorship or endorsement. Continuum does not distribute model weights, service subscriptions or API credentials. Uploads and generated media are user data, outside this repository's MIT grant; users must have the relevant rights to their inputs and outputs under the applicable provider terms.

## Repository assets and compatibility

Unused scaffold illustrations, framework logo files and the unused social-logo sprite are excluded from the current source tree. Test image/video fixtures are synthetic test-pattern media. No reference ZIP, extracted third-party Skill source, commercial sample media, downloaded font or user canvas data is included in the current tree.

Some internal `libtv.*` storage keys, clipboard identifiers and media-host checks remain for compatibility with existing local documents and imports. Renaming those protocols would break existing data. They are not presented as the product's brand and grant no rights to third-party services or marks. Historical commits retain their earlier names and assets; this preparation does not rewrite Git history.

## Lucide / Feather license text

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
