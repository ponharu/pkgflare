# pkgflare

[![npm version](https://img.shields.io/npm/v/%40ponharu%2Fpkgflare)](https://www.npmjs.com/package/@ponharu/pkgflare)
[![Build and release](https://github.com/ponharu/pkgflare/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/ponharu/pkgflare/actions/workflows/release.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Deploy a scoped private npm registry to your own Cloudflare account.

Publish, inspect, and install packages with familiar npm commands. pkgflare provisions the Cloudflare resources and deploys the registry through one `pkgflare deploy` command.

- **Standard package clients.** Publish with npm or Bun; install with npm, pnpm, Yarn Classic, or Bun.
- **Storage in your account.** A Cloudflare Worker serves package archives from R2 and metadata from D1.
- **Read and publish access.** Authenticate with Cloudflare Secret tokens or short-lived GitHub Actions OIDC tokens with per-package grants.

[Get started](#get-started) · [Compatibility](#compatibility) · [Authentication](#authentication) · [Operations](#operations)

pkgflare serves private packages under your configured scopes. Public dependencies continue to use the client's default registry. It does not provide a hosted service, web UI, npmjs.org proxy, user database, or team model.

## Get started

You need Node.js 22 or later and a Cloudflare account with Workers, D1, and R2 available. The steps below use npm and Bash or Zsh.

Use three separate directories:

| Project         | Purpose                           | Credential              |
| --------------- | --------------------------------- | ----------------------- |
| `acme-registry` | Configure and deploy the registry | Wrangler authentication |
| `acme-example`  | Publish `@acme/example`           | Publish token           |
| `acme-app`      | Install and use `@acme/example`   | Read token              |

### 1. Configure the registry

Create a dedicated, private deployment project:

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

Replace the account ID, deployment name, and scope with your own. You can omit `accountId` when Wrangler can resolve exactly one account. The default endpoint uses `workers.dev`; for a custom hostname or CI credentials, see [Cloudflare authentication and domains](./guides/operations.md#cloudflare-authentication-and-domains).

### 2. Deploy and register tokens

In `acme-registry`, run:

```sh
npx pkgflare deploy
```

This creates the D1 database and R2 bucket, applies migrations, deploys the Worker, and prints the registry URL and Secret registration commands. Requests require a registered token before they can succeed.

Run the following command twice to generate separate read and publish tokens. Save each value in your password manager:

```sh
npx pkgflare token generate
```

Register the read token, then the publish token. Paste each value at Wrangler's prompt:

```sh
npx wrangler secret put PKGFLARE_READ_TOKEN --config .pkgflare/wrangler.json
npx wrangler secret put PKGFLARE_PUBLISH_TOKEN --config .pkgflare/wrangler.json
```

Keep token values out of source files and Git. Commit the configuration, lockfile, and generated state files to your private deployment repository as described in [deployment state](./guides/operations.md#deployment-state).

### 3. Publish a package

In a new terminal, create the package project:

```sh
mkdir acme-example
cd acme-example
```

Create `.npmrc` using the registry URL printed by deploy. Replace the example hostname on **both** lines, and use the scope from your registry configuration:

```ini
@acme:registry=https://acme-registry.example.workers.dev
//acme-registry.example.workers.dev/:_authToken=${NPM_TOKEN}
```

Set `NPM_TOKEN` to the **publish** token. This prompt hides the value and keeps it out of shell history:

```sh
printf 'Publish token: '
read -r -s NPM_TOKEN
printf '\n'
export NPM_TOKEN
```

Create `package.json`. Replace `@acme` if you configured a different scope:

```json
{
  "name": "@acme/example",
  "version": "1.0.0",
  "type": "module",
  "exports": "./index.js",
  "files": ["index.js"]
}
```

Create `index.js`:

```js
export const greeting = "Hello from pkgflare";
```

Publish and inspect the package:

```sh
npm publish
npm view @acme/example
```

`npm view` should report version `1.0.0`. Every publish needs a new version. Do not set `"private": true` in the package manifest: npm uses that field to prevent publication to any registry.

### 4. Install and use the package

In another terminal, create a consumer project:

```sh
mkdir acme-app
cd acme-app
npm init -y
```

Copy the package project's `.npmrc` into `acme-app`. Set `NPM_TOKEN` to the **read** token:

```sh
printf 'Read token: '
read -r -s NPM_TOKEN
printf '\n'
export NPM_TOKEN
```

Install the package and run its exported code. Use your configured scope in both commands:

```sh
npm install @acme/example
node --input-type=module -e 'import { greeting } from "@acme/example"; console.log(greeting)'
```

The final command prints `Hello from pkgflare`.

The `.npmrc` contains an environment variable reference and can be committed. Keep the token value in your shell environment or CI secret store.

## Compatibility

| Operation                       | Tested clients               |
| ------------------------------- | ---------------------------- |
| Publish                         | npm, Bun                     |
| Metadata and install            | npm, pnpm, Yarn Classic, Bun |
| List, add, and remove dist-tags | npm                          |

Yarn Berry and other clients are outside the tested compatibility baseline. pkgflare does not implement `npm login`, `npm adduser`, `npm unpublish`, `npm deprecate`, search, or the npm audit API.

Published versions are immutable. Use a publish token with `npm dist-tag` to promote or roll back an existing version:

```sh
npm dist-tag add @acme/example@1.1.0 latest
npm dist-tag add @acme/example@1.0.0 latest
```

Both versions must already be published. Moving a tag affects future tag-based resolution; it does not rewrite consumers' lockfiles or remove a version.

Package sizes are subject to Cloudflare request-body and Worker CPU limits. The request-body limit applies to the complete Base64-encoded publish request, which is larger than the tarball. Non-attachment metadata is limited to 1 MiB and JSON nesting to 128 levels. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) when choosing a plan.

## Authentication

| Credential                | Access                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- |
| Secret read token         | Read every package in the registry                                                |
| Secret publish token      | Read and publish every package, and change dist-tags across all configured scopes |
| GitHub Actions OIDC token | Access the packages and operations granted to a trusted workflow                  |

Secret-token permissions cannot be restricted per package or scope. Use GitHub OIDC package grants or separate registry deployments when publishers need narrower access.

For GitHub Actions, follow the [OIDC setup guide](./guides/github-actions.md). It covers registry trust rules, authentication before dependency installation, and reusable workflows. For Secret tokens, see [rotation and revocation](./guides/operations.md#rotate-tokens).

## CLI

Run the CLI from the deployment project where `@ponharu/pkgflare` is installed:

```text
pkgflare init
pkgflare deploy [--config <path>] [--secrets-file <path>] [--adopt-existing]
pkgflare token generate
pkgflare auth github --audience <audience>
```

Use `npx pkgflare` to invoke the installed binary. `--help` or `-h` displays usage without executing a command. Unknown options, extra arguments, repeated options, and missing option values are rejected. `deploy` does not support `--dry-run`.

`token generate` creates a random token locally and prints it once. pkgflare does not store, distribute, list, or revoke tokens. `auth github` prints a short-lived JWT for command substitution and requires the GitHub Actions OIDC environment.

## Operations

| Task                                                | Guide                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Configure a custom domain or deployment credentials | [Cloudflare authentication and domains](./guides/operations.md#cloudflare-authentication-and-domains) |
| Preserve resource IDs between deployments           | [Deployment state](./guides/operations.md#deployment-state)                                           |
| Upgrade pkgflare or deploy from CI                  | [CI deployment and updates](./guides/operations.md#ci-deployment-and-updates)                         |
| Retry a deployment or adopt existing resources      | [Deployment recovery](./guides/operations.md#recovering-a-failed-deployment)                          |
| Back up or restore package data                     | [Backups and restoration](./guides/operations.md#backups-and-restoration)                             |
| Investigate an error response                       | [Troubleshooting](./guides/operations.md#troubleshooting)                                             |

## Development

Install Node.js 22 or later and the Bun version declared in `package.json`, then run:

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

| Task                                                       | Document                                 |
| ---------------------------------------------------------- | ---------------------------------------- |
| Choose checks, contribute a change, or understand releases | [Contributing](./CONTRIBUTING.md)        |
| Change request handling or deployment behavior             | [Specification](./docs/specification.md) |
| Understand storage, authentication, or deployment design   | [Architecture](./docs/architecture.md)   |

## Security

Report vulnerabilities using [SECURITY.md](./SECURITY.md). Keep tokens, authorization headers, Cloudflare credentials, and private package contents out of public issues.

## License

[MIT](./LICENSE)
