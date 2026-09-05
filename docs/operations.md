# Operating a registry

This guide covers the deployment project that installs `@ponharu/pkgflare`. Start with the [README](../README.md) to create a registry and publish a package.

## Cloudflare authentication and domains

Cloudflare deployment credentials manage infrastructure. Registry read and publish tokens authenticate npm clients. They are separate credentials: never put a Cloudflare API token in `.npmrc`.

For interactive deployment, use `npx wrangler login`. For CI, store `CLOUDFLARE_API_TOKEN` in the CI secret store and set `accountId` in `pkgflare.config.ts` or supply `CLOUDFLARE_ACCOUNT_ID`. Explicit account selection avoids needing to enumerate accessible accounts. Conflicting account IDs in the environment, configuration, and saved state stop deployment.

A deployment token needs these account permissions for the operations pkgflare performs:

| Permission               | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| Workers Scripts: Edit    | Inspect and deploy the Worker and manage its Secrets |
| D1: Edit                 | Find or create the database and apply migrations     |
| Workers R2 Storage: Edit | Inspect or create the package bucket                 |

Scope the token to the deployment account. These are Cloudflare account API permissions; an R2 S3 object-access credential alone cannot provision this registry. See Cloudflare's [permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) for current permission names and scopes.

For a custom hostname, add `hostname: "packages.example.com"` to the config. The hostname must belong to an active Cloudflare zone in the same account. Give the deployment credentials Zone: Read and Workers Routes: Edit access for that zone in addition to the account permissions. Wrangler configures the custom domain; pkgflare disables its `workers.dev` endpoint when a hostname is configured. Follow Cloudflare's [custom domain requirements](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) when choosing the hostname.

Without `hostname`, use the `workers.dev` URL printed by deploy. The account must have a Workers subdomain configured. Keep the chosen registry hostname stable: `.npmrc` entries and existing lockfiles can contain absolute tarball URLs.

## Deployment state

Use a private deployment repository and commit:

- `package.json`, the package-manager lockfile, and `pkgflare.config.ts`
- `.pkgflare/wrangler.json`, `.pkgflare/ownership.json`, and `.pkgflare/.gitignore`

The two JSON files contain account/resource identifiers, registry configuration, and Worker ownership state. They contain no Secret values, but expose deployment details. The generated `.gitignore` excludes only copied runtime and migrations; do not ignore the entire `.pkgflare` directory. Do not manually change resource identifiers to point at a different registry.

Keep token files out of Git. If using the secrets-file option below, add `.secrets.env` to the deployment project's `.gitignore` before creating it.

Run only one deployment at a time for each registry. The CLI does not lock state across processes or CI jobs; configure CI concurrency accordingly. Keep the same saved state available on subsequent runs, including any changes after a failed deployment. State files identify resources; they are not backups of package data.

## CI deployment and updates

Install from the committed lockfile, provide Cloudflare credentials through CI secrets, and run:

```sh
npm ci
npx pkgflare deploy
```

For initial token provisioning, a private Wrangler-compatible dotenv file can contain the configured bindings:

```dotenv
PKGFLARE_READ_TOKEN=<read-token>
PKGFLARE_PUBLISH_TOKEN=<publish-token>
```

Generate the values with `pkgflare token generate` and populate the file from your secret store. The placeholders above are not usable tokens. Deploy with:

```sh
npx pkgflare deploy --secrets-file .secrets.env
```

Wrangler applies this file additively; omitted Secrets are preserved. Remove temporary secret files after use. Subsequent deployments can omit `--secrets-file` when the Secrets already exist.

To update pkgflare, review the version's changes, update the dependency and lockfile, and run deploy. The CLI applies pending migrations before replacing the Worker. Migrations must support the previous Worker so a failed Worker deployment can be retried. This does not guarantee arbitrary downgrades to older pkgflare versions; do not remove migration history as a rollback technique.

## Recovering a failed deployment

If a command fails, fix the reported cause and rerun it with the same configuration and saved state. A failure does not undo resources or migrations already created or applied.

If state is missing and a matching resource already exists, pkgflare stops rather than assuming ownership. Verify the account and all three resource names before adoption:

| Resource | Name for `name: "acme-registry"` |
| -------- | -------------------------------- |
| Worker   | `acme-registry`                  |
| D1       | `acme-registry-metadata`         |
| R2       | `acme-registry-packages`         |

Then run:

```sh
npx pkgflare deploy --adopt-existing
```

Adoption permits applying migrations and deploying over existing resources; it does not import or validate arbitrary registry data. Use it only for resources intended for this pkgflare deployment. A successful Worker creation whose result was lost can also require adoption on retry. Saved D1 and R2 identifiers are reused.

## Tokens and access

All tokens cover the whole registry. Publish permission includes read access and dist-tag changes. Use read-only tokens for installation jobs and keep publish tokens limited to package release jobs.

For rotation, add a new binding while retaining the old one, deploy, register the new Secret, and switch clients to it. Once clients have switched, remove the old binding and deploy again, then delete the old Secret. Removing a configured binding revokes that token after deployment. For urgent revocation, delete its Secret through Cloudflare; other configured tokens remain usable. Revocation cannot retract package bytes already downloaded by clients.

## Backups and restoration

pkgflare does not provide an automated backup or restore command. A recoverable registry needs the D1 metadata, every R2 object referenced by that metadata, the deployment configuration/state, and access to the token secret store. Back up D1 and R2 separately using Cloudflare or compatible storage tooling. D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) covers database recovery, not R2 objects or Worker Secrets.

For a coordinated snapshot, pause publishing and tag changes, wait for in-flight writes to finish, export D1, and copy the R2 objects before resuming writes. Preserve object keys and bytes: the D1 version rows reference those exact keys. Store backups with access controls appropriate for private source packages.

Before reopening a restored registry, verify that every restored version's `tarball_key` exists in R2 and matches its stored size and integrity. Restore compatible runtime/configuration and Secrets, then check metadata and a cold-cache install. An older D1 snapshot can omit newer versions even if their objects remain in R2; confirm the intended recovery point. Do not treat successful database restoration alone as complete registry recovery.

Failed publishing may leave unreachable objects. Automatic orphan collection is not implemented. Do not apply age-based deletion to the whole bucket: old referenced tarballs remain valid indefinitely. Listing an object without a current D1 reference is also insufficient proof that it is safe to delete while publishing is active.

## Troubleshooting

| Symptom                 | What to check                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| 401                     | `NPM_TOKEN` is set and the `.npmrc` authentication hostname matches the registry URL                       |
| 403                     | The token matches a configured Secret and grants the required permission                                   |
| 409 on publish          | The version already exists; inspect it before deciding whether to publish a new version                    |
| 413                     | Publish metadata exceeds 1 MiB, or the encoded request exceeds Cloudflare's limit                          |
| 503                     | Retry after checking storage availability; a publish result may be uncertain, so inspect the version first |
| Existing resource error | Restore saved state or verify ownership before explicit adoption                                           |
| Account mismatch        | Configuration, environment, and saved state select the same Cloudflare account                             |

Worker responses include `x-pkgflare-request-id`. Use that ID to correlate unexpected errors with Worker logs. Share the request ID and sanitized reproduction steps when reporting a problem; keep tokens and private package contents out of public issues. Cloudflare-generated responses may not include this header.

Large publishes consume CPU for parsing, Base64 decoding, and hashing, even though tarball memory use is bounded. Consult [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and measure representative package sizes on the intended plan. Request-body limits apply to the encoded JSON request, which is larger than the tarball.
