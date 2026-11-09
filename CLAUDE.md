# CLAUDE.md

- Tests: `pnpm test` (build → eslint → prettier → cspell → ava). Sheets API v4 and OAuth2 are mocked at the HTTP level
  with nock (`src/_mock/google-sheets-api.ts`). The real-API test runs only with `TABLES_LIVE_TEST=1` and credentials.
- TypeScript stays at 6.0.x until typescript-eslint supports 7.
- `pnpm.overrides` raises `glob` (via ava / nyc) to ^14.0.2 and `minimatch` (via eslint 10) to ^11.0.1 because the
  latest ava / nyc / eslint still pin vulnerable majors (GHSA, moderate). Both are devDependencies only and never reach
  users of the library. Remove the overrides once upstream moves on.
- 2.0.0 is breaking: Node.js 22+ (google-auth-library 11) and zod 4 schemas.
