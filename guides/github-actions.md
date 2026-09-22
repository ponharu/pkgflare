# GitHub Actions authentication

GitHub Actions jobs can use short-lived OIDC tokens to read or publish packages without a stored registry token. Configure which repositories, workflows, and packages the registry trusts, then request a fresh token in each job.

This feature is registry authentication only. It is not npmjs.org Trusted Publishing, does not publish to npmjs.org, and does not authenticate Wrangler or the Cloudflare management API.

## Configure the registry

Add `githubOidc` under `auth` in the deployment project's `pkgflare.config.ts`. Set an audience and one or more subjects. Each subject is an allow rule:

```ts
githubOidc: {
  audience: "pkgflare://packages.example.com",
  subjects: [{
    repositoryId: "123456789",
    repositoryOwnerId: "987654321",
    ref: "refs/tags/v*",
    workflowRef: "acme/example/.github/workflows/publish.yml@refs/tags/v*",
    jobWorkflowRef: "acme/example/.github/workflows/publish.yml@*",
    permissions: ["publish"],
    packages: ["@acme/example"],
  }],
}
```

Replace the example IDs, repository, workflow, and package names with your own, then run `npx pkgflare deploy` in the deployment project.

| Field                               | Matching rule                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `repositoryId`, `repositoryOwnerId` | Decimal GitHub IDs; these remain the primary identity checks across renames                                   |
| `ref`, `workflowRef`                | Exact branch or tag ref, or a prefix ending in `*`                                                            |
| `jobWorkflowRef`                    | Branch/tag ref, full 40-character lowercase commit SHA, or `@*` after an exact owner/repository/workflow path |
| `packages`                          | Exact scoped names or a complete scope wildcard such as `@acme/*`, within a configured registry scope         |

The complete normalized registry configuration must fit Cloudflare's 5 KiB per-variable limit. pkgflare checks this before deployment; prefer a scope wildcard or another registry when a very large subject/package matrix would exceed it.

`jobWorkflowRef` is optional in the configuration, but omission is an explicit requirement that the token does not contain `job_workflow_ref`; it is not a wildcard. GitHub-issued tokens can include `job_workflow_ref` for jobs defined directly in a workflow. In that case, set `jobWorkflowRef` to that workflow's ref, which normally matches `workflowRef` as shown above. Omit it only for an execution environment whose tokens do not contain the claim.

OIDC requests from `pull_request`, `pull_request_target`, related pull-request events, and merge queues are rejected even if another claim pattern would match. Use a trusted branch, tag, or manually dispatched workflow. A `publish` grant includes reads and dist-tag changes only for its allowed packages; a `read` grant cannot publish or change tags. Metadata and tarball reads apply the same package grant.

## Configure the package workflow

In the package repository, keep a scope-specific `.npmrc` with `${NPM_TOKEN}` and a committed npm lockfile. Add `.github/workflows/publish.yml` with a job that has `id-token: write`. The workflow below matches the tag rule above and bootstraps the public CLI before installing private dependencies:

```yaml
name: Publish package

on:
  push:
    tags: ["v*"]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: |
          set -eu
          NPM_TOKEN="$(npm exec --yes --ignore-scripts --registry=https://registry.npmjs.org --package=@ponharu/pkgflare@1.2.0 -- pkgflare auth github --audience 'pkgflare://packages.example.com')"
          export NPM_TOKEN
          npm ci
      - name: Publish package
        run: |
          set -eu
          NPM_TOKEN="$(npm exec --yes --ignore-scripts --registry=https://registry.npmjs.org --package=@ponharu/pkgflare@1.2.0 -- pkgflare auth github --audience 'pkgflare://packages.example.com')"
          export NPM_TOKEN
          npm publish
```

Replace the audience in both token requests with the value in your registry configuration. Set the package version before pushing a matching tag. Add any package-specific build steps before publication.

`--package=@ponharu/pkgflare@1.2.0` identifies the scoped package and a fixed version even in a clean checkout. Update the version pin deliberately when upgrading. `--ignore-scripts` applies to CLI bootstrapping; the subsequent project installation retains its normal script behavior. Do not invoke bare `npx pkgflare` before installing the CLI: npm can resolve the unscoped package name instead.

An alternative after project dependencies are available is to add `@ponharu/pkgflare` as an exact development dependency, commit the lockfile, and run its local binary with `npm exec --no -- pkgflare auth github --audience 'pkgflare://packages.example.com'`. This alone cannot bootstrap an initial `npm ci` that needs private packages; use the explicit package command above for that first authentication.

Grant the installation step access to every private dependency it needs. For read-only CI, grant `permissions: ["read"]`, omit the publish step, and use `npm ci`, pnpm, Yarn Classic, or Bun after exporting the token. Request a fresh token before publication because dependency installation can outlast the previous token. Keep token assignment separate from `export` and the package command so `set -e` stops the step on authentication failure. Never echo the command result or enable shell tracing around it.

## Reusable workflows

For a reusable workflow, set the caller and called workflow refs independently:

- `repositoryId`, `repositoryOwnerId`, `ref`, and `workflowRef` identify and constrain the caller.
- `jobWorkflowRef` identifies the called reusable workflow and its trusted ref.

To allow routine commit-SHA updates for one reusable workflow without changing the registry policy, fix its complete identity and wildcard only the ref:

```ts
{
  jobWorkflowRef: "acme/automation/.github/workflows/publish.yml@*",
}
```

This wildcard cannot replace any part of the owner, repository, or workflow path. A matching JWT must still contain a valid full commit SHA, branch ref, or tag ref, and every repository ID, owner ID, caller ref/workflow, permission, and package grant in the subject must also match. Continue pinning the reusable workflow's `uses` entry to a full commit SHA; `@*` only avoids duplicating that changing revision in the registry policy.

Set `jobWorkflowRef` to a full commit SHA instead when the registry policy must independently require that one revision. That stricter option requires a policy deployment whenever the reusable workflow SHA changes. GitHub keeps the caller information in the standard claims and puts the called workflow reference in `job_workflow_ref`; its trust examples also support filtering a fixed reusable workflow repository with a wildcard ref. See GitHub's documentation for [OIDC with reusable workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows) and [calling reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#calling-a-reusable-workflow).

## Token handling and verification

The JWT is a Bearer credential and can be replayed until it expires. Request it immediately before the package command, do not persist it in files or job outputs, and keep untrusted scripts out of the authenticated step.

Invalid tokens are rejected. If GitHub signing keys are unavailable or invalid, the registry rejects the request with 503. Token contents are not logged.
