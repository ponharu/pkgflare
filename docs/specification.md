# pkgflare v1 specification

## Product boundary

pkgflare deploys a scoped private npm-compatible Registry into the user's own Cloudflare account. It provides a CLI, Worker runtime, D1 migrations, R2 bindings, configuration types, and compatibility tests. It is not a hosted service and does not provide a web UI, public Registry proxy, user database, team model, or a custom package client.

Users publish, inspect, install, promote, and roll back packages with standard npm-compatible commands. Registry infrastructure and package data remain in the user's Cloudflare account.

## Supported clients

The compatibility baseline is:

- publish: npm and Bun
- metadata and install: npm, pnpm, Yarn Classic, and Bun
- dist-tag mutation: npm

Compatibility claims apply to the versions exercised by the project's end-to-end test. Other npm-compatible clients and Yarn Berry may work but are not part of the v1 guarantee until tested.

## Configuration

The deployment repository contains `pkgflare.config.ts` and a package-manager lockfile. The configuration defines:

- a lowercase deployment name of at most 54 characters
- one or more allowed npm scopes
- an optional Cloudflare account ID, required when Wrangler credentials expose multiple accounts
- an optional custom hostname
- optional Cloudflare Secret binding names with registry-wide `read` or `publish` permissions
- optional GitHub OIDC audience and subject rules containing repository/owner IDs, ref, workflow, permissions, and allowed package patterns

At least one Secret token or GitHub OIDC configuration is required. Secret values are never stored in configuration or deployment state. A `publish` grant also grants read access and dist-tag mutation. Secret tokens apply to all packages; OIDC subjects are restricted to their exact packages or configured scope wildcards.

The normalized runtime configuration is rejected when its UTF-8 JSON representation exceeds the 5 KiB Cloudflare Worker variable limit.

## Deployment state and resources

`pkgflare deploy` creates a Worker, D1 database, and R2 bucket with deterministic names. The generated `.pkgflare/wrangler.json` stores the resolved account ID and exact resource identifiers. `.pkgflare/ownership.json` records that pkgflare created or explicitly adopted the Worker. Neither file contains Secret values, and both must be preserved for subsequent deployments.

If ownership state is absent and a deterministic resource name already exists, deployment stops. Existing resources are adopted only when the user reruns with `--adopt-existing` after verifying the active account and resources. More than one matching D1 database is always an error. Conflicting account IDs in configuration, deployment state, and the environment are rejected; access to the selected account is verified by the targeted Wrangler operations rather than requiring account-list permission.

Every packaged SQL migration is copied into deployment state. Pending migrations run before the new Worker is deployed. Migrations are append-only and use expand/contract changes so the previous Worker remains compatible if migration succeeds but deployment fails. Both migration and deployment failures stop the command and are safe to retry.

If the Worker was created but the deploy result was lost before ownership could be recorded, the retry treats it as an existing unowned Worker and requires `--adopt-existing`. Previously saved D1 and R2 identifiers are reused rather than recreated.

## Registry operations

v1 accepts scoped names up to 214 characters. Scope segments contain lowercase letters, digits, `.`, `_`, or `-` and start and end with a letter or digit. Package segments contain the same characters and may begin or end with `-` or `_`, but may not begin with `.`. Unscoped names are not supported.

The Registry supports:

- npm CouchDB-style package publish
- complete package metadata and version metadata
- immutable tarball GET and HEAD with byte ranges
- dist-tag GET, PUT, and DELETE used by `npm dist-tag`
- authenticated ping

The login/adduser, unpublish, deprecate, search, and audit APIs are not implemented.

Package versions are immutable. Dist-tags are independently mutable and may point to any existing version, enabling promotion and rollback without republishing bytes.

## Streaming publish pipeline

Standard npm clients embed the tarball as Base64 in a JSON attachment. pkgflare preserves that wire format and does not require a signed-upload protocol or custom publish command.

The Worker incrementally tokenizes strict UTF-8 JSON. It rejects duplicate object keys, invalid escapes, invalid or non-canonical Base64, more than one attachment, metadata larger than 1 MiB, and nesting deeper than 128 levels. Property order and input chunk boundaries do not affect the result.

Attachment data is decoded incrementally into uniform 5 MiB R2 multipart parts. The final part may be smaller. SHA-1 and SHA-512 are calculated with streaming digest APIs under backpressure. The complete tarball and Base64 string are never retained in Worker memory.

Each attempt uses a random R2 object key. After the complete request, attachment length, manifest, scope, version, tags, and client-provided checksums have been validated, the multipart upload is completed. D1 then atomically inserts package metadata, the immutable version row, and initial dist-tags. The D1 primary key on package name and version determines the sole winner of concurrent attempts.

If D1 reports an error after R2 completion, pkgflare reads the version back:

- the same object key and checksums mean the attempt committed successfully
- another object key means the attempt lost the immutable-version race
- no row or a failed read-back means the outcome is retryable or unknown

An object is deleted immediately only when it is known to be a losing attempt. Otherwise it is retained as an unreachable orphan. Reads resolve the D1 row first, so incomplete and orphaned uploads are never installable. Automatic orphan garbage collection is outside v1.

## Size contract

pkgflare imposes no tarball-size ceiling below Cloudflare's platform limits. Memory use is bounded by parser metadata, one multipart part, stream queues, and runtime overhead rather than total tarball size.

The complete Base64-encoded publish request remains subject to Cloudflare's request-body limit. Cloudflare can reject an oversized request before the Worker executes, in which case pkgflare cannot customize the response. Processing is also subject to the Worker's CPU limit, which is governed separately from the request-body limit. The 1 MiB metadata and 128-level nesting limits are security limits, not tarball limits.

Supported publish sizes depend on the deployment plan and request processing cost; pkgflare does not promise a universal maximum package size. See [platform limits](https://developers.cloudflare.com/workers/platform/limits/).

## Authentication and rotation

Every Registry operation requires a Bearer token. Static tokens are compared against configured Cloudflare Secret bindings without logging request credentials. Missing bindings do not disable other valid bindings.

When GitHub OIDC is configured, a non-Secret Bearer token may be a GitHub JWT. The Worker accepts only RS256 with JWT type, the fixed `https://token.actions.githubusercontent.com` issuer and fixed GitHub JWKS URL, the configured audience, required timing and identity claims, and a maximum issued age of ten minutes. It matches numeric repository and owner IDs, branch/tag ref, caller workflow, optional reusable workflow, permission, and package. Pull-request-related and merge-group events are rejected.

Rules that omit `jobWorkflowRef` require `job_workflow_ref` to be absent from the token; omission does not disable matching for that claim. Rules that set it require a match in addition to `workflow_ref`. GitHub-issued tokens may include `job_workflow_ref` for jobs defined directly in a workflow, in which case the configured value normally matches that workflow's `workflow_ref`. For reusable jobs, `workflow_ref` identifies the caller and `job_workflow_ref` identifies the called workflow. Caller workflow refs accept exact or terminal-wildcard branch/tag refs. A job workflow ref additionally accepts an exact full 40-character lowercase hexadecimal commit SHA or a complete-ref wildcard written as `owner/repository/.github/workflows/file.yml@*`. The wildcard does not apply to the workflow identity, and the JWT claim must still end in a valid full SHA, branch ref, or tag ref. Shortened or malformed SHAs and wildcarded owners, repositories, or paths are rejected. OIDC package grants are enforced before metadata, tarball, publish, and dist-tag handlers.

GitHub keys are fetched under timeout and response-size/key-count limits, cached per isolate, and refreshed after a cooldown when an unknown key is encountered. Invalid signatures/claims fail with 403. JWKS retrieval and validation failures fail closed with 503. Tokens and claims are not included in diagnostics.

`pkgflare auth github --audience <audience>` requests a JWT through the GitHub Actions OIDC environment and prints only the token. npm-compatible clients use it as `NPM_TOKEN`. The direct JWT design does not issue pkgflare sessions and is independent of npmjs.org Trusted Publishing and Cloudflare API authentication.

Automated tests use locally generated signing keys and a mocked fixed GitHub JWKS response. A real GitHub-issued token and a deployed registry require a separate trusted-workflow acceptance run.

Rotation uses overlapping bindings: add the new binding, deploy, register and distribute the new Secret, remove the old binding and deploy, then delete the old Secret. Both tokens work during the overlap; the removed token stops working after the second deployment.

## Consistent reads

D1 is the visibility boundary. Package metadata reads obtain versions and dist-tags in one D1 batch so a publish cannot produce a response combining two different snapshots. A tarball is returned only when referenced by a committed version row. A missing referenced object produces a retryable storage-consistency response.

## Diagnostics and privacy

Every Worker response includes an opaque request ID. Unexpected failures emit a structured log containing the request ID, operation, and error type. Error logs and error responses never include Bearer tokens, Authorization headers, Secret values, request bodies, manifests, or tarball contents.

Input errors return 400, authorization failures return 401 or 403, immutable conflicts return 409, application-enforced size limits return 413, and transient or uncertain storage failures return 503. Platform-generated errors may use Cloudflare's response format.

## Acceptance criteria

v1 is accepted when automated tests demonstrate:

1. first deployment, repeat deployment, account pinning, explicit adoption, and all-migration copying
2. npm and Bun publish through the packaged Worker runtime
3. cold-cache, read-token-only install through npm, pnpm, Yarn Classic, and Bun
4. npm dist-tag promotion, rollback, listing, and removal
5. immutable and concurrent version publication with only a D1-referenced winner visible
6. property-order and chunk-boundary independence, strict JSON/Base64 rejection, depth and metadata limits, multipart boundaries, disconnect cleanup, and backpressure
7. D1 commit error reconciliation and safe orphan behavior
8. consistent package metadata snapshots during publication
9. overlapping-token rotation and missing-binding tolerance
10. absence of credentials and package contents from diagnostics
11. GitHub OIDC signature, issuer, audience, time, repository, owner, ref, normal/reusable workflow, event, permission, package, key rotation, and failure-closed checks

Deployment acceptance should also exercise initial setup, repeat deployment, failure recovery, and large publishes on the intended Cloudflare account. Record the account plan, encoded request size, tarball size, CPU time, and result when assessing capacity.
