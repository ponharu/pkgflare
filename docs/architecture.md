# Architecture and design decisions

pkgflare has two parts: a Node.js deployment CLI and a Cloudflare Worker serving npm-compatible requests. The CLI provisions resources through the packaged Wrangler dependency; the Worker accesses D1, R2, and Secrets through bindings. See the [specification](./specification.md) for the wire behavior and limits.

## Storage and visibility

R2 stores immutable tarball bytes. D1 stores versions, manifests, checksums, object keys, and mutable dist-tags. This keeps package metadata transactional without putting package archives in the database.

R2 and D1 do not share a transaction. Each publish therefore uploads to a unique attempt key, completes the object, and then inserts the version and tags in a D1 transaction. Reads use D1 as the visibility boundary: an R2 object alone is never a published version. A database uniqueness constraint selects the winner when two requests publish the same version.

If the D1 result is uncertain, read-back can identify the successful attempt or a losing attempt. Only a confirmed losing object's key may be deleted immediately. An unknown result retains the object because deleting it could break a committed version. This trades possible unused storage for preserving installable packages. Any future garbage collector must account for in-flight requests and uncertain commits.

Versions are immutable; tags are mutable pointers to existing versions. This supports promotion and rollback without replacing bytes at an existing version URL. Package metadata reads fetch versions and tags in one D1 batch to avoid combining different snapshots.

## Why publish uses a streaming parser

Standard npm publish embeds a Base64 tarball in JSON. Reading the complete body with `request.json()` would retain both the encoded request and decoded bytes, making Worker memory usage grow with package size. A separate upload protocol would require changing normal package publishing workflows.

The parser keeps the npm wire format and streams attachment bytes while retaining bounded metadata. It is deliberately specialized to publishing rather than exposed as a general-purpose JSON library. The added parser complexity is the cost of supporting standard clients without buffering whole archives.

Attachment length may appear after attachment data, so it cannot be assumed known when uploading starts. Fixed-size R2 multipart uploads handle this with 5 MiB parts and a smaller final part. Streaming digests and awaited storage writes maintain backpressure. CPU cost still grows with input size.

Changes to this path must preserve:

- Strict UTF-8, JSON, and canonical Base64 validation regardless of input chunk boundaries or property order.
- Duplicate-key rejection, one attachment, bounded metadata and nesting, and bounded part buffering.
- Full manifest, attachment, and checksum validation before the version becomes visible.
- Cancellation and multipart cleanup on malformed input or disconnect, without deleting another attempt's object.
- D1 reconciliation after an uncertain result, including the possibility that read-back also fails.

## Authentication boundary

Secrets provide a small deployment-owned token set with registry-wide read or publish permissions. GitHub Actions OIDC adds short-lived workflow identity with explicit repository ID, owner ID, ref, workflow, permission, and package grants. Both methods enter the same route authorization boundary, so package grants cover metadata, tarballs, publish, and dist-tag operations consistently.

pkgflare uses the GitHub JWT directly as the npm Bearer token. A token exchange would shorten or reshape the credential but would also require a pkgflare signing key, a new session endpoint, and another token lifecycle. Direct verification keeps standard npm/Bun requests, retains GitHub's short expiry, and makes GitHub's fixed issuer/JWKS the only signing trust root. JWKS fetches are bounded, cached, and fail closed.

Normal and reusable workflows are separate trust cases. A normal rule requires the absence of `job_workflow_ref`; a reusable rule matches both the caller's `workflow_ref` and the called `job_workflow_ref`. Pull-request contexts are not accepted. Immutable numeric repository and owner IDs are authoritative; workflow path claims add execution constraints rather than replacing identity.

Unexpected diagnostics identify the request and operation without recording credentials or package payloads. Normal authenticated metadata responses do contain package manifests; the privacy restriction applies to diagnostics and error responses.

## Deployment lifecycle

The CLI stores selected resource IDs and Worker ownership separately from generated runtime files. Explicit adoption prevents a name collision from silently authorizing an overwrite. Adoption is an operator decision, not proof that arbitrary existing resources have a compatible schema.

Migrations run before Worker deployment. New migrations must remain compatible with the previous runtime if the deployment fails after migration. Keep migrations append-only; do not edit an already released migration. Concurrent deployment coordination belongs to the operator or CI system.

## Code map

| Location                        | Responsibility                                                            |
| ------------------------------- | ------------------------------------------------------------------------- |
| `src/config.ts`                 | Public configuration types and validation                                 |
| `src/cli/`                      | Account selection, resource provisioning, saved state, Wrangler execution |
| `src/worker.ts`                 | HTTP routing, authentication dispatch, request IDs                        |
| `src/runtime/publish-stream.ts` | Incremental parsing, decoding, multipart upload, streaming hashes         |
| `src/runtime/publish.ts`        | Publish validation and D1 commit/reconciliation                           |
| `src/runtime/read.ts`           | Metadata and tarball reads                                                |
| `src/runtime/dist-tags.ts`      | Tag reads and mutations                                                   |
| `src/runtime/github-oidc.ts`    | GitHub JWT verification, bounded JWKS retrieval, and package grants       |
| `migrations/`                   | Append-only D1 schema history                                             |

## Deliberate boundaries

The project does not implement a public registry proxy, hosted tenancy, a web UI, npm user management, unpublish, or deprecation. These are product scope decisions rather than implied future work. Changes to those boundaries should establish the intended behavior and operational cost before adding endpoints.
