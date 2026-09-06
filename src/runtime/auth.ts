import type { Permission } from "../config.js";
import { logRegistryError } from "./diagnostics.js";
import { authorizeGitHubOidc, GitHubOidcUnavailableError } from "./github-oidc.js";
import { npmError } from "./response.js";
import type { RuntimeContext } from "./types.js";

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function grants(permissions: readonly Permission[], required: Permission): boolean {
  return permissions.includes("publish") || permissions.includes(required);
}

const maximumBearerTokenBytes = 16 * 1024;

export async function authorize(
  request: Request,
  context: RuntimeContext,
  required: Permission,
  packageName?: string,
): Promise<Response | null> {
  const candidate = bearerToken(request);
  if (candidate === null) {
    return npmError(401, "unauthorized", "authentication required");
  }
  if (candidate.length > maximumBearerTokenBytes) {
    return npmError(403, "forbidden", `token does not grant ${required} access`);
  }

  const candidateDigest = await digest(candidate);
  let authorized = false;

  for (const token of context.config.auth.tokens) {
    const secret = context.env[token.binding];
    if (typeof secret !== "string" || secret.length === 0) continue;
    const matches = equalDigest(candidateDigest, await digest(secret));
    authorized ||= matches && grants(token.permissions, required);
  }

  if (authorized) return null;

  try {
    if (await authorizeGitHubOidc(candidate, context, required, packageName)) return null;
  } catch (error) {
    if (error instanceof GitHubOidcUnavailableError) {
      logRegistryError(context.requestId, "github_oidc_jwks", error);
      return npmError(503, "authentication_unavailable", "OIDC authentication is unavailable");
    }
    throw error;
  }

  return npmError(403, "forbidden", `token does not grant ${required} access`);
}
