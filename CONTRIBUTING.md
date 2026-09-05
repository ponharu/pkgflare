# Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. For changes to registry behavior or product scope, open an issue describing the use case and proposed behavior before building a large change. Use [SECURITY.md](./SECURITY.md) for suspected vulnerabilities.

## Local setup

Install Node.js 22 or later and the Bun version declared in `package.json`, then run:

```sh
bun install --frozen-lockfile
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

On each push to `main`, `release.yml` calls `test.yml` for checks, unit/Worker tests, client compatibility, and package verification. Only after they pass does semantic-release determine the next version, publish to npm, and create a Git tag and GitHub Release. It does not commit version updates or a changelog back to the repository. Release notes live in GitHub Releases.

The npm package uses Trusted Publishing. In the npm settings for `@ponharu/pkgflare`, authorize GitHub owner `ponharu`, repository `pkgflare`, and workflow filename `release.yml`, with direct publishing allowed. The calling workflow is `release.yml`; `test.yml` is only the reusable verification workflow. No GitHub Environment is configured. Complete package ownership and trusted-publisher setup on npm before relying on automatic publication; see [npm's setup instructions](https://docs.npmjs.com/trusted-publishers/).

The release job uses GitHub-hosted runners, Node.js 24, and the locked semantic-release npm plugin with OIDC support. `id-token: write` supplies npm authentication, while `GITHUB_TOKEN` creates tags and GitHub Releases. No long-lived npm publish token is required. Issue/PR release comments and labels are disabled.
