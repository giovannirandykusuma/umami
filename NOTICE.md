# License and source notice

This is a modified Umami distribution, not an MIT-only distribution of all its
components. The upstream Umami code retains the MIT grant and copyright notice
in [LICENSE](LICENSE): Copyright (c) 2022 Umami Software, Inc.
<hello@umami.is>. That grant has not been removed or replaced.

This fork's modifications (including the AI board integration and public-source
notice added in October 2026) are offered under GNU AGPL version 3. The covered
combined work is offered under GNU AGPL version 3, while upstream MIT portions
remain independently available under their original MIT terms. See the full
[GNU AGPL v3 text](LICENSES/AGPL-3.0-only.txt). There is no warranty, to the extent
permitted by applicable law; see the MIT disclaimer and AGPL sections 15–17.
Recipients may copy, modify and redistribute under the applicable license terms.

## UAParser.js

The lockfile resolves `ua-parser-js` **2.0.10**, imported by `src/lib/detect.ts`.
Its npm package declares **AGPL-3.0-or-later**; its source header states:

> UAParser.js v2.0.10
> Copyright © 2012-2026 Faisal Salman <f@faisalman.com>
> AGPLv3 License

The package's unmodified license is reproduced in
[LICENSES/ua-parser-js-LICENSE.md](LICENSES/ua-parser-js-LICENSE.md).
Upstream source: <https://github.com/faisalman/ua-parser-js>.
No commercial license purchase or alternative licensing permission is asserted.

## Obtain the corresponding source

Public source repository: <https://github.com/giovannirandykusuma/umami>.
The dashboard's **Source code** link must identify the exact release tag or commit
of the running version, not the repository's moving default branch. Source and
license notices are offered at no charge, without a login or NDA. The matching
release must include the complete corresponding source, build/install scripts,
lockfiles and non-secret configuration templates, not just a patch or this notice.
See [release and source instructions](docs/ai-source-compliance.md).

This documents the selected public-source compliance approach; it is not a legal
clearance, an exhaustive dependency audit, or a conclusion that every surrounding
service is covered. The scope of a combined/derivative work and adequacy of each
release's source require review, as explained in that document.
