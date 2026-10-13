## Summary

<!-- Explain the ModelBridge change and link related issues. -->

## Review

<!-- Record findings and resolve blocking issues before merging. -->

- [ ] Architecture and source-qualified routing reviewed
- [ ] Credential, source-sharing and failure behavior reviewed
- [ ] No legacy shells/imports, installer identities or release workflows restored

## Validation

- [ ] `bun run lint:all`
- [ ] `bun run typecheck:all`
- [ ] `bun run test`
- [ ] `bun run build`
- [ ] At least 80% line coverage for changed production logic
- [ ] Isolated native profile restart test, when desktop/state behavior changes

## Screenshots

<!-- Include screenshots for UI changes. -->

## Product and release impact

<!-- State limitations, follow-ups and any separately approved release scope. -->
