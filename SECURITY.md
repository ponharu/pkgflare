# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue for a suspected vulnerability.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Remove registry tokens, authorization headers, Cloudflare credentials, account identifiers, and private package contents from the report unless they are essential to reproduce the issue.

You should receive an acknowledgement within seven days. A fix and disclosure schedule will be coordinated after the report is validated.

## Deployment responsibility

pkgflare deploys into the user's Cloudflare account. Users are responsible for generating, storing, distributing, rotating, and revoking their registry tokens, and for limiting Cloudflare credentials to the permissions needed for deployment.
