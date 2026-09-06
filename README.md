# pkgflare

Deploy a scoped private npm registry to your own Cloudflare account.

`pkgflare` packages a Cloudflare Worker, D1 migrations, R2 bindings, authentication, and deployment tooling. Package authors and consumers continue to use standard npm-compatible clients; package data and registry infrastructure stay in the Cloudflare account you control.

## What it provides

- Standard scoped package publish and install endpoints
- Immutable tarballs in R2
- Package metadata and mutable dist-tags in D1
- Cloudflare Secret tokens and short-lived GitHub Actions OIDC authentication
- Repeatable deployment through one `pkgflare deploy` command
- npm-compatible metadata and tarball responses tested with npm, pnpm, Yarn Classic, and Bun

It intentionally does not provide a web UI, npmjs.org proxy, user database, team model, or a hosted registry service.

## Requirements

- Node.js 22 or later
- A Cloudflare account with Workers, D1, and R2 available
- Wrangler authentication, either through `wrangler login` or supported environment credentials

## Set up a registry

### 1. Create the deployment project

Use a dedicated, private repository to keep your deployment configuration and state:

```sh
mkdir acme-registry
cd acme-registry
npm init -y
npm install --save-dev @ponharu/pkgflare
npx pkgflare init
npx wrangler login
```

Edit the generated `pkgflare.config.ts`:

```ts
import { defineConfig } from "@ponharu/pkgflare";

export default defineConfig({
  name: "acme-registry",
  // Use your Cloudflare account ID, not a zone ID.
  accountId: "0123456789abcdef0123456789abcdef",
  scopes: ["@acme"],
  auth: {
    provider: "secrets",
    tokens: [
      { binding: "PKGFLARE_READ_TOKEN", permissions: ["read"] },
      { binding: "PKGFLARE_PUBLISH_TOKEN", permissions: ["publish"] },
    ],
  },
});
```

Replace the account ID, deployment name, and scope with your own. `accountId` can be omitted when Wrangler can resolve exactly one account. The default endpoint uses `workers.dev`. An optional `hostname: "packages.example.com"` configures a [custom domain](./docs/operations.md#cloudflare-authentication-and-domains).

### 2. Deploy and register tokens

```sh
npx pkgflare deploy
```

The command creates the D1 database and R2 bucket, applies migrations, deploys the Worker, and prints its URL and Secret registration commands. Requests require a registered token before they can succeed.

Generate two different tokens by running this command twice, and save them in your password manager:

```sh
npx pkgflare token generate
```

Register the read token, then the publish token. Paste each value at Wrangler's prompt:

```sh
npx wrangler secret put PKGFLARE_READ_TOKEN --config .pkgflare/wrangler.json
npx wrangler secret put PKGFLARE_PUBLISH_TOKEN --config .pkgflare/wrangler.json
```

Keep token values out of source files and Git. Commit the deployment configuration, lockfile, and generated state files to your private deployment repository as described in [deployment state](./docs/operations.md#deployment-state).

### 3. Publish your first package

In a separate directory for the package you want to publish, create `.npmrc` with the URL printed by deploy. Replace the example hostname on **both** lines:

```ini
@acme:registry=https://acme-registry.example.workers.dev
//acme-registry.example.workers.dev/:_authToken=${NPM_TOKEN}
```

Set `NPM_TOKEN` in your shell to the **publish** token. For example, in Bash or Zsh, this prompts without displaying the token or putting its value in shell history:

```sh
printf 'Publish token: '
read -r -s NPM_TOKEN
printf '\n'
export NPM_TOKEN
```

For a minimal example package, create `package.json` and `index.js` in that directory:

```json
{
  "name": "@acme/example",
  "version": "1.0.0",
  "type": "module",
  "exports": "./index.js",
  "files": ["index.js"]
}
```

```js
export const greeting = "Hello from pkgflare";
```

Publish and inspect it:

```sh
npm publish
npm view @acme/example
```

Use an allowed scope and a new version for each publish. Do not set `"private": true` in the package manifest: npm uses that field to prevent publishing to any registry.

### 4. Install from a consumer project

In another project, copy the scope-specific `.npmrc` above. Set `NPM_TOKEN` to the **read** token using the same prompt, then run:

```sh
npm install @acme/example
```

The `.npmrc` contains an environment variable reference and can be committed; the token value must stay in your shell environment or CI secret store. Public dependencies continue to use the client's default registry.

## Compatibility and permissions

| Operation                       | Supported clients            |
| ------------------------------- | ---------------------------- |
| Publish                         | npm, Bun                     |
| Metadata and install            | npm, pnpm, Yarn Classic, Bun |
| List, add, and remove dist-tags | npm                          |

Yarn Berry and other clients are outside the tested compatibility baseline. pkgflare does not implement `npm login`, `npm adduser`, `npm unpublish`, `npm deprecate`, search, or the npm audit API. It is a scoped private registry, not a complete replacement for the public npm service.

A Secret read token can read every package in the registry. A Secret publish token can also publish packages and change dist-tags across all configured scopes. Secret-token permissions are not restricted per package or scope; use GitHub OIDC package grants or separate registry deployments when publishers need narrower trust boundaries.

GitHub Actions jobs can instead use short-lived OIDC tokens with per-package grants and no stored registry token. Configure the trusted repository IDs, owner ID, ref, workflow, permissions, and package names under `auth.githubOidc`, then request the configured audience in the job:

```ts
auth: {
  provider: "secrets",
  tokens: [
    { binding: "PKGFLARE_READ_TOKEN", permissions: ["read"] },
    { binding: "PKGFLARE_PUBLISH_TOKEN", permissions: ["publish"] },
  ],
  githubOidc: {
    audience: "pkgflare://packages.example.com",
    subjects: [{
      repositoryId: "123456789",
      repositoryOwnerId: "987654321",
      ref: "refs/heads/main",
      workflowRef: "acme/example/.github/workflows/publish.yml@refs/heads/main",
      permissions: ["publish"],
      packages: ["@acme/example"],
    }],
  },
}
```

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - run: npm ci
  - name: Publish
    run: NPM_TOKEN="$(npx pkgflare auth github --audience 'pkgflare://packages.example.com')" npm publish
```

The package repository's `.npmrc` still points its scope to pkgflare and references `${NPM_TOKEN}`. Use the same command with `npm ci` or another supported client for OIDC-authenticated reads. See [GitHub Actions OIDC](./docs/operations.md#github-actions-oidc) for reusable workflows, wildcard rules, and the security model.

Versions are immutable. To promote or roll back an existing version, use the publish token with `npm dist-tag`:

```sh
npm dist-tag add @acme/example@1.1.0 latest
npm dist-tag add @acme/example@1.0.0 latest
```

The first command assumes `1.1.0` has already been published. Moving a tag affects future tag-based resolution; it does not rewrite consumers' lockfiles or remove a version.

## CLI

```text
pkgflare deploy [--config <path>] [--secrets-file <path>] [--adopt-existing]
pkgflare auth github --audience <audience>
pkgflare init
pkgflare token generate
```

`token generate` creates a cryptographically random token locally and prints it once. pkgflare does not store, distribute, list, or revoke tokens.

`auth github` requests a short-lived GitHub Actions OIDC JWT and writes only that JWT to standard output. It is intended for command substitution and fails outside the GitHub Actions OIDC environment.

## Publish consistency

A package version is immutable, while dist-tags remain mutable for promotion and rollback. pkgflare incrementally parses the standard npm publish document, decodes its Base64 attachment into fixed-size R2 multipart chunks, and calculates SHA-1 and SHA-512 without holding the complete tarball in Worker memory. A unique attempt object is published in D1 only after R2 completes; D1's package-and-version constraint chooses the sole winner of concurrent publishes.

If a D1 result is uncertain, pkgflare reads the version back before deciding whether the attempt succeeded or conflicted. An interrupted attempt can leave an unreachable R2 object, but it is never returned by metadata or install requests. Automatic orphan collection is not part of the initial release.

pkgflare does not add a tarball-size ceiling. The complete Base64-encoded npm publish request remains subject to Cloudflare's request-body and Worker CPU limits. Those limits are governed separately and can vary with the account and Workers usage model. Non-attachment JSON metadata is limited to 1 MiB, JSON nesting is limited to 128 levels, and tarball downloads are streamed from R2 with immutable caching and byte ranges. See [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) when choosing your deployment plan.

## Rotate tokens

To rotate a token without interrupting existing clients:

1. Add a new Secret binding to the config while retaining the old binding, then deploy.
2. Register the new Secret and switch clients to it.
3. Remove the old binding from the config and deploy again.
4. Delete the old Cloudflare Secret.

Missing configured Secret bindings are ignored as long as another configured token grants access. Secret values and Authorization headers are never logged.

## Updates and migrations

Updating the npm package and running `pkgflare deploy` copies every packaged migration, applies pending migrations, and then deploys the new Worker. Migrations are append-only and must remain compatible with the previously deployed Worker so that a failed deployment can be retried without taking the Registry offline.

See [operations](./docs/operations.md) for CI credentials, deployment recovery, backups, and troubleshooting. The complete behavior and failure contracts are described in [the specification](./docs/specification.md).

## Development

```sh
bun install
bun run check
bun run format
bun run test
bun run test:e2e
bun run build
```

The integration suite runs the Worker with local D1 and R2 bindings through Cloudflare's Vitest integration. It does not require Cloudflare credentials. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and [architecture](./docs/architecture.md) for design decisions and invariants.

## Security

Please report vulnerabilities using the process in [SECURITY.md](./SECURITY.md). Do not include tokens, authorization headers, Cloudflare credentials, or private package contents in public issues.

## License

MIT
