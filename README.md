# Loomup JavaScript SDKs

Public JavaScript and TypeScript packages for [Loomup](https://tryloomup.com),
the backend that starts as one SQLite file and scales without application
rewrites.

| Package | Purpose |
| --- | --- |
| [`@loomup/client`](packages/client) | TypeScript client for auth, resources, realtime, storage, and sync |
| [`@loomup/astro`](packages/astro) | Astro integration, cookie-backed SSR client, islands client, and middleware |
| [`@loomup/cli`](packages/cli) | Declarative schema and generated-client CLI |

## Development

Requires Node.js 18 or newer.

```bash
npm ci
npm test
```

The packages are tested serially because `@loomup/astro` consumes the local
`@loomup/client` workspace.

## Releases

All three packages currently share one version. A `vX.Y.Z` tag must match every
package manifest. The release workflow tests and packs the packages, installs
the tarballs in a clean project, and then publishes in dependency order:

```text
@loomup/client -> @loomup/astro -> @loomup/cli
```

The first release can use a short-lived granular `NPM_TOKEN`. Later releases
use npm trusted publishing through GitHub Actions OIDC.

## License

MIT
