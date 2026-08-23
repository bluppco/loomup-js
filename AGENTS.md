# SDK Repository Guidance

## Ownership

- This repository is the source of truth for Loomup JavaScript/TypeScript client packages, framework integrations, `@loomup/cli`, package documentation, and package tests.
- Swift, Kotlin, Flutter, Dart, and their conformance suites are outside this repository's scope. Do not add native SDK source or native build jobs here.
- The Rust backend and control plane live in the sibling `../server` checkout and in `bluppco/loomup`. Do not add backend implementation or deployment code here.
- All `@loomup/*` npm packages publish only from `.github/workflows/release.yml` in this repository through the `npm-production` environment and npm trusted publishing/OIDC.
- Keep JavaScript package versions in lockstep. A release tag must be `v<version>` and match every package manifest.

## Contracts

- SDK behavior must target versioned public Loomup HTTP, WebSocket, schema, and sync contracts. Do not import files directly from the server checkout.
- The Studio browser runtime is authored in `packages/client/browser/`. The server may vendor a pinned release artifact, but must not become its source of truth.

## Verification

- Run JavaScript package tests serially in dependency order with `npm test`.
- Serialize resource-intensive build and test commands within this repository. Check for an existing matching process before starting another.
