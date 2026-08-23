# Loomup JavaScript SDKs

Public JavaScript and TypeScript packages for [Loomup](https://tryloomup.com),
the backend that starts as one SQLite file and scales without application
rewrites.

| Package | Purpose |
| --- | --- |
| [`@loomup/client`](packages/client) | TypeScript client for auth, resources, realtime, storage, and sync |
| [`@loomup/astro`](packages/astro) | Astro integration, cookie-backed SSR client, islands client, and middleware |
| [`@loomup/cli`](packages/cli) | Declarative schema and generated-client CLI |
| [`@loomup/offline`](packages/offline) | Browser SQLite and offline resource client |
| [`@loomup/react`](packages/react) | React provider, hooks, and sync helpers |
| [`@loomup/vue`](packages/vue) | Vue plugin and composables |
| [`@loomup/next`](packages/next) | Next.js sessions, router, and middleware helpers |
| [`@loomup/nuxt`](packages/nuxt) | Nuxt module, server client, and composables |
| [`@loomup/react-native`](packages/react-native) | React Native client, storage adapters, and hooks |
| [`@loomup/tanstack-query`](packages/tanstack-query) | TanStack Query keys, options, and realtime cache helpers |

## Development

Requires Node.js 18 or newer.

```bash
npm ci
npm test
```

The packages are tested serially because the integrations consume local
`@loomup/client` and `@loomup/react` workspaces.

## Releases

All packages share one version. A `vX.Y.Z` tag must match every
package manifest. The release workflow tests and packs the packages, installs
the tarballs in a clean project, and then publishes in dependency order:

```text
@loomup/client -> offline, react, vue, next, nuxt, tanstack-query, astro
@loomup/react  -> react-native
@loomup/cli    -> standalone
```

Releases use npm trusted publishing through GitHub Actions OIDC. The trusted
publisher is restricted to `bluppco/loomup-js`, `release.yml`, and the
`npm-production` environment. GitHub does not retain an npm publish token
after a package's initial bootstrap release.

## License

MIT
