## Summary

<!-- What does this change do, and why? Link the issue: "Closes #123". -->

## Track and phase

<!-- e.g. Product Phase 3 · Compute Phase B · Database D2 · Docs · Tooling -->

## Changes

-

## Checks

- [ ] `pnpm verify` passes (typecheck, lint, unit tests)
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes, or this change does not affect pages or components
- [ ] New behaviour has tests, including refusal and failure paths
- [ ] Documentation and README updated where behaviour, commands or status changed

## Safety

- [ ] No secrets, connection strings or real student data in code, tests, logs or screenshots
- [ ] Layer rules respected (no ESLint boundary overrides added)
- [ ] Schema changes come with a generated migration; no applied migration was edited
- [ ] Nothing automated writes the database environment marker, and the guard is not weakened
- [ ] Compute tasks keep strict schemas, read-only `load`, and aggregate, non-identifying output
