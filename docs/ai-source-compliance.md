# Public corresponding-source release procedure

## Decision and limits

This fork selects public source compliance, not a commercial UAParser license.
[NOTICE.md](../NOTICE.md) records the combined-work AGPL v3 approach and preserves
the upstream MIT grant in [LICENSE](../LICENSE). This is implementation guidance,
not legal clearance. It does not declare that every dependency or independent
service has the same license, or that publishing one repository automatically
satisfies all obligations. Have qualified counsel review combined-work scope,
third-party notices and the actual source deliverable before release.

Evidence reviewed:

- Upstream Umami's actual [LICENSE](https://github.com/umami-software/umami/blob/master/LICENSE)
  and this checkout's `LICENSE`: MIT, Copyright (c) 2022 Umami Software, Inc.
- `pnpm-lock.yaml` resolves `ua-parser-js` 2.0.10. The [npm metadata](https://registry.npmjs.org/ua-parser-js/2.0.10)
  declares `AGPL-3.0-or-later`. The [published tarball](https://registry.npmjs.org/ua-parser-js/-/ua-parser-js-2.0.10.tgz)
  has SHA-512 integrity
  `sha512-t+3Ktbq0Ies2vaSezfOaWiolH4OigQIO1dk+1xDpOydB1COVPocVYOrEV5rqZ0kFY9XYG1v9LutCyMgYBpABcw==`,
  matching the lockfile. Its `src/main/ua-parser.js` copyright is
  © 2012-2026 Faisal Salman <f@faisalman.com>; its `LICENSE.md` is reproduced in
  `LICENSES/ua-parser-js-LICENSE.md`. `src/lib/detect.ts` imports UAParser directly.
- Primary [GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html), particularly
  sections [5](https://www.gnu.org/licenses/agpl-3.0.html#section5),
  [6](https://www.gnu.org/licenses/agpl-3.0.html#section6), and
  [13](https://www.gnu.org/licenses/agpl-3.0.html#section13).
  The complete GNU text is in `LICENSES/AGPL-3.0-only.txt`.

Section 5 requires conspicuous modification notices with relevant dates, notice
of AGPL licensing, licensing the covered work as a whole under the AGPL, and
appropriate legal notices in interactive interfaces (subject to its original
interface exception). Mere aggregation does not extend coverage to independent
works. MIT's compatibility permits a covered combination under AGPL without
revoking the original MIT grant. This fork elects that combined-work approach;
it does not claim an unmodified AGPL library is exempt just because it is a
package dependency.

Section 6 governs conveying non-source/object code and the corresponding-source
methods. For downloaded images/binaries, use section 6(d): provide equivalent
access to the corresponding source at no additional charge, with clear source
directions beside the binary/image download. Merely pointing at upstream or
providing only the fork's diff is insufficient. Other delivery methods have
other conditions; do not substitute an informal written offer for the method
actually required (6(b)'s written offer has specific duration and recipient
requirements). Provide Installation Information where section 6's User Product
conditions apply; do not assume those conditions always or never apply.

Section 13 requires a modified version to prominently offer all remote network
users an opportunity to receive that version's Corresponding Source from a
network server at no charge through a standard/customary copying method. Its
specific wording concerns modified versions; combined-work/derivative scope is
not resolved by the fact that UAParser itself was not edited. We implement the
public-source offer for the covered combined application. A dashboard link alone
is not a substitute for complete source or other applicable section 5/6 notices;
review shared/public interfaces too. Independent services are not automatically
covered just because they communicate over a network.

## Build-time exact-version source binding

`SourceCodeLink` uses the public `NEXT_PUBLIC_SOURCE_URL` at Next.js build
time. Development without that variable links to the public repository. Production
without a valid binding fails clearly during next.config.ts loading, before UI
rendering. The config accepts only this repository's `/tree/<40-hex-commit>` or
`/tree/source-release-<reviewed-tag>` URLs, rejecting moving branch names,
credentials, query strings and private hosts. The component consumes the checked
build binding without a runtime throw.
A URL validator cannot prove a tag is immutable or that it matches an image;
the release operator must perform the mapping below. Never reuse or move a
release tag. Runtime environment changes do not update an already built client.

1. Finish review, tests, notices, non-secret templates and history/secret review.
   Publish only authorized reviewed source. Do not publish production credentials,
   databases, session data, model keys, private endpoints, hostnames or local host
   metadata. Do not rewrite/force-push history as a compliance shortcut.
2. MAIN commits the final reviewed source, then creates a unique release tag
   pointing at that commit. Do not insert the final SHA into a tracked file and
   create a self-referential commit loop. The tag and build environment are the
   binding; no fixed version is hardcoded in the component.
3. Publish that commit/tag to
   `https://github.com/giovannirandykusuma/umami` and confirm anonymous access to
   `/tree/<release-tag>` and the source archive. The tag must contain the UI and
   notices used in the image, not just an earlier pre-notice commit.
4. Build from a clean checkout of that exact tag, with
   `NEXT_PUBLIC_SOURCE_URL=https://github.com/giovannirandykusuma/umami/tree/<release-tag>`.
   For containers, forward it explicitly as a builder-stage `ARG`/`ENV` before
   `pnpm build:docker`; setting it only in the running container is ineffective.
   Dockerfile/build pipeline wiring is a release prerequisite, not supplied by
   the component itself.
5. Publish a release record mapping **tag → full commit SHA → final image digest**,
   source archive checksum, build command/tool versions and this public variable.
   Put the same source link beside the image download and keep it accessible for
   the applicable license period. Rebuild after any source change; do not relabel
   an older image as the reviewed release. Tag existence and mapping must be
   checked by MAIN; this document does not assert an existing deployment matches.
6. Verify anonymously that the running dashboard's visible, keyboard-accessible
   **Source code** link resolves to that exact tag and the source can be downloaded
   without authentication, payment or extra restrictions. Check notices, warranty
   disclaimer and license availability in the shipped interface/release as well.

## What must accompany each release

Corresponding Source (section 1) includes the preferred form for modification and
all source needed to generate, install, run and modify the covered object code,
including scripts controlling those activities and relevant interface definitions.
Include application and workspace package source, native AI runtime integration,
Prisma schemas/migrations, tracker/recorder source, generated-input definitions,
`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, the AI runtime install
manifest **and package-lock**, build configs, Dockerfile and `scripts/`.
Include all applicable copyright/license notices; this UAParser notice is not
an exhaustive third-party inventory. Review the bundled native runtime's own
licenses and source availability as part of the exact image's deliverable.
Do not assume a minified client bundle, generated client, dependency names, or
mutable upstream URL alone is complete corresponding source. Provide matching
dependency sources when required; preserve exact versions and verify archived
source availability. System Library/general-purpose unmodified tool exclusions
have limits defined by section 1, not a blanket exclusion for every npm package.

Supply a public non-secret configuration template with placeholders, required
variable names/defaults and instructions for creating fresh local credentials.
Use the existing tracked `docker-compose.yml`, Dockerfile, `prisma/`, `db/` and
scripts as build/install inputs; check their reproducibility at the release SHA.
Do not copy a live `.env` or production compose overrides into the public archive.
An illustrative local-only starting template (not a production configuration):

```dotenv
DATABASE_URL=postgresql://umami:local-example-only@localhost:5432/umami
NEXT_PUBLIC_SOURCE_URL=https://github.com/giovannirandykusuma/umami/tree/<release-tag>
# Generate fresh local session/auth secrets as required by the release's configuration docs.
# AI provider credentials are supplied by the recipient, never by the source archive.
```

For a source build, provision an empty local PostgreSQL database, use the Node
version pinned in Dockerfile and pnpm 12.3.4, then run from the release checkout:

```sh
npx pnpm@12.3.4 install --frozen-lockfile
# Supply local DATABASE_URL and the exact public NEXT_PUBLIC_SOURCE_URL.
npx pnpm@12.3.4 build
npx pnpm@12.3.4 db:migrate
npx pnpm@12.3.4 start
```

The Dockerfile additionally installs the pinned native AI runtime from
`scripts/ai/install/package-lock.json`; preserve that installation path and its
build instructions for AI-enabled images. Follow the tracked AI setup docs for
optional local provider configuration. Source availability must not require
access to the operator's private provider/account or production database.
Document any required generated assets, external downloads and installation
steps in the public release, and ensure matching source remains obtainable.
No production or model calls are needed to validate this notice/link change.

## Release evidence checklist (MAIN)

- Final source/history secret review and dependency/source-scope review complete.
- Complete corresponding source archived; non-secret build/install templates and
  both lockfile families present; local install/build proof recorded.
- Source link mounted prominently in the actual dashboard shell on desktop/mobile;
  legal-notice access and other remote-user entry points reviewed.
- Build-time variable forwarded by actual image builder; missing value fails release
  validation; final notices included in binary distribution/source directions.
- Fresh judge acceptance, exact public tag/SHA mapping, final rebuild/image digest,
  anonymous source download and deployed-link checks recorded.

This lane's unit tests exercise URL validation, visibility, accessible name and
keyboard focus. They are not proof of publication, image rebuilding, deployment,
full corresponding-source completeness, or legal sufficiency.
