# CLAUDE.md

- Tests: `pnpm test` (build → eslint → prettier → cspell → ava). Sheets API v4 and OAuth2 are mocked at the HTTP level
  with nock (`src/_mock/google-sheets-api.ts`). The real-API test runs only with `TABLES_LIVE_TEST=1` and credentials.
- TypeScript stays at 6.0.x until typescript-eslint supports 7.
- `pnpm.overrides` raises `glob` (via ava / nyc) to ^14.0.2 and `minimatch` (via eslint 10) to ^11.0.1 because the
  latest ava / nyc / eslint still pin vulnerable majors (GHSA, moderate). Both are devDependencies only and never reach
  users of the library. Remove the overrides once upstream moves on.
- 2.0.0 is breaking: Node.js 22+ (google-auth-library 11) and zod 4 schemas.

## Publishing to npm

Pushing a `v*` tag runs `.github/workflows/publish.yml`, which tests, builds and **publishes to npm directly**
(no staged approval). It authenticates with npm Trusted Publishing (GitHub Actions OIDC); no `NPM_TOKEN` secret is used,
and provenance is attached automatically.

```bash
# after bumping "version" in package.json and pushing the commit
git tag vX.Y.Z && git push origin vX.Y.Z
```

- The job fails if the tag and the version in package.json differ, and does nothing if that version is already on npm.
- A prerelease (`1.2.0-beta.0`) is published under its identifier as the dist-tag (`beta`), not `latest`.
- Do not `npm publish` from a local machine (no tokens are kept).
- To re-run without moving the tag, start "Publish to npm" with workflow_dispatch (it publishes the version in package.json on the chosen branch).
- A PR that changes `publish.yml` runs the build and `npm pack --dry-run` without publishing.
- Prerequisite: on npmjs.com, `google-spreadsheet-tables` lists GitHub Actions / `ideamans/node-google-spreadsheet-tables` / `publish.yml` with the **publish** permission as its
  Trusted Publisher. With only the stage-publish permission, `npm publish` fails with `E403 OIDC permission denied`.
