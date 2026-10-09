# Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. For changes to registry behavior or product scope, open an issue describing the use case and proposed behavior before building a large change. Use [SECURITY.md](./SECURITY.md) for suspected vulnerabilities.

## Local setup

Install Node.js 22 or later and the Bun version declared in `package.json`, then run:

```sh
bun install --frozen-lockfile
bun run audit
bun run check
bun run test
```

Tests use local Cloudflare bindings and do not need deployment credentials. Use synthetic packages and credentials in examples and fixtures.

## Making a change

Read the [specification](./docs/specification.md) and [architecture](./docs/architecture.md) for the behavior the implementation must preserve. Keep changes focused and update the relevant documentation when behavior changes. Add regression coverage for bug fixes and boundary cases, especially parsing, authorization, concurrent publishing, and deployment recovery.

Run `bun run format` and `bun run check` before submitting. Choose further verification based on the affected behavior:

| Command                 | Coverage                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `bun run test`          | Unit tests and Worker integration tests with local D1/R2                                    |
| `bun run test:e2e`      | Real npm/Bun publish, npm dist-tags, and cold-cache installs with npm/pnpm/Yarn Classic/Bun |
| `bun run test:package`  | Packed package installed in a temporary project, CLI help, and Wrangler deployment dry-run  |
| `bun run test:coverage` | Unit and Worker coverage reports                                                            |

The client and packaging checks require network access to install dependencies; they do not deploy to Cloudflare. CI runs check, test, E2E, and package verification. Local tests do not establish real-account permissions or production capacity.

## Database and packaging changes

Add a new numbered SQL migration for schema changes. Never rewrite a released migration, and keep the previously deployed Worker working after migration if deploying its replacement fails. Cover migration copying and retry behavior when changing the CLI.

The npm artifact must include its runtime, type declarations, migrations, and linked user documentation. Run the package check when changing build outputs or published files. Keep environment-specific paths, credentials, and private registry URLs out of artifacts and lockfiles.

## Pull requests

Explain the problem, the resulting behavior, and how you verified it. Call out compatibility or migration implications. Include sanitized reproduction steps for bugs; do not attach private packages, deployment credentials, or token values.

## Releases

Pull request titles use Conventional Commits and are checked by `semantic-pr.yml`. Use squash merges so the checked title becomes the commit subject on `main`. `fix:` produces a patch release, `feat:` a minor release, and `!` or a `BREAKING CHANGE:` footer a major release. Documentation and maintenance commits do not normally trigger a release.

On each push to `main`, `release.yml` calls `test.yml` for the dependency audit, checks, unit/Worker tests, client compatibility, and package verification. After verification, a read-only job builds `dist/` and uploads it as an immutable artifact for that workflow run. A separate release job downloads those assets, installs locked dependencies with lifecycle scripts disabled, and disables npm lifecycle scripts while semantic-release determines the next version, publishes to npm, and creates a Git tag and GitHub Release. The release job does not rebuild the package. It does not commit version updates or a changelog back to the repository. Release notes live in GitHub Releases.

The npm package uses Trusted Publishing. In the npm settings for `@ponharu/pkgflare`, authorize GitHub owner `ponharu`, repository `pkgflare`, and workflow filename `release.yml`, with direct publishing allowed. The calling workflow is `release.yml`; `test.yml` is only the reusable verification workflow. No GitHub Environment is configured. Complete package ownership and trusted-publisher setup on npm before relying on automatic publication; see [npm's setup instructions](https://docs.npmjs.com/trusted-publishers/).

The release job uses GitHub-hosted runners, Node.js 24, and the locked semantic-release npm plugin with OIDC support. `id-token: write` supplies npm authentication, while `GITHUB_TOKEN` creates tags and GitHub Releases. No long-lived npm publish token is required. Restrict traditional token publishing in npm with **Require two-factor authentication and disallow tokens**. Issue/PR release comments and labels are disabled. Release tooling still executes with publication authority; isolating the build reduces exposure but does not establish that a dependency or artifact is trustworthy.

## Dependency security

`bun run audit` checks the complete locked dependency graph, including build and release tools. The required verification workflow runs it on pull requests and before releases; `dependency-audit.yml` also runs daily and can be dispatched manually to detect advisories published after a merge. Failed scheduled workflows use GitHub Actions notification settings; maintainers should subscribe to those failures.

Runtime dependencies use exact versions. Root `overrides` keep older development-tool dependencies on patched versions, but overrides are not inherited by consumers of the published package. A fresh consumer install must also be checked when changing runtime dependency versions. Renovate keeps routine updates behind the release-age gate and creates security-update PRs without that delay or dependency-dashboard approval. Security updates still require successful checks and a manual merge.

Audit exceptions must identify one advisory, explain its reachable inputs, and expire. `scripts/audit-dependencies.ts` temporarily excludes **GHSA-vfj7-8cjw-p6xm** until **2026-11-09** because no patched `braces` release exists and its callers in semantic-release and its commit analyzer only compile trusted release configuration patterns. It is a release-tool dependency, not part of the Worker bundle or production CLI dependency graph. The raw `bun audit` command continues to report it. On expiry, verification and releases fail until the dependency is fixed, removed, or the exception is reassessed. Other advisories, including new advisories for the same package, remain blocking.
