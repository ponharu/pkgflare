# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue for a suspected vulnerability.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Remove registry tokens, authorization headers, Cloudflare credentials, account identifiers, and private package contents from the report unless they are essential to reproduce the issue.

You should receive an acknowledgement within seven days. A fix and disclosure schedule will be coordinated after the report is validated.

## Deployment responsibility

pkgflare deploys into the user's Cloudflare account. Users are responsible for generating, storing, distributing, rotating, and revoking their registry tokens, and for limiting Cloudflare credentials to the permissions needed for deployment.

## Package integrity and publisher trust

Published versions cannot be overwritten through the registry API, and tarball hashes are calculated by the Worker. These checks establish byte integrity, not that package code is benign. pkgflare does not scan tarballs for malware or require package signatures or provenance attestations. Protect publish authority and review dependencies before installation.

Prefer GitHub OIDC subjects restricted to specific packages, immutable repository and owner IDs, and exact workflow/branch references. Static publish tokens apply to every configured scope; reserve them for trusted publishers and rotate or revoke them if exposed. A publisher can release a new version or move a dist-tag, so an immutable version alone does not protect clients that automatically follow tags or version ranges. Commit and enforce the consuming project's lockfile.
