import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type LocalJWKSet } from "jose";
import type { Permission } from "../config.js";
import type { RuntimeContext } from "./types.js";

const githubIssuer = "https://token.actions.githubusercontent.com";
const githubJwksUrl = new URL(`${githubIssuer}/.well-known/jwks`);
const maximumJwksBytes = 64 * 1024;
const maximumJwksKeys = 16;
const jwksCacheMilliseconds = 5 * 60 * 1000;
const jwksCooldownMilliseconds = 30 * 1000;
const jwksTimeoutMilliseconds = 5000;
const maximumClaimLength = 512;

interface CachedJwks {
  resolver: LocalJWKSet;
  fetchedAt: number;
  expiresAt: number;
}

let cachedJwks: CachedJwks | undefined;
let pendingJwks: Promise<CachedJwks> | undefined;

export class GitHubOidcUnavailableError extends Error {
  override readonly name = "GitHubOidcUnavailableError";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) throw new GitHubOidcUnavailableError("GitHub JWKS response is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let contents = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumJwksBytes) {
        await reader.cancel();
        throw new GitHubOidcUnavailableError("GitHub JWKS response is too large");
      }
      contents += decoder.decode(value, { stream: true });
    }
    contents += decoder.decode();
    return contents;
  } catch (error) {
    if (error instanceof GitHubOidcUnavailableError) throw error;
    throw new GitHubOidcUnavailableError("GitHub JWKS response could not be read");
  } finally {
    reader.releaseLock();
  }
}

async function fetchJwks(): Promise<CachedJwks> {
  let response: Response;
  try {
    response = await fetch(githubJwksUrl, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(jwksTimeoutMilliseconds),
    });
  } catch {
    throw new GitHubOidcUnavailableError("GitHub JWKS endpoint is unavailable");
  }
  if (!response.ok)
    throw new GitHubOidcUnavailableError("GitHub JWKS endpoint rejected the request");

  let value: unknown;
  try {
    value = JSON.parse(await readBoundedBody(response)) as unknown;
  } catch (error) {
    if (error instanceof GitHubOidcUnavailableError) throw error;
    throw new GitHubOidcUnavailableError("GitHub JWKS response is invalid");
  }
  if (
    !isObject(value) ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > maximumJwksKeys ||
    value.keys.some(
      (key) =>
        !isObject(key) ||
        key.kty !== "RSA" ||
        typeof key.kid !== "string" ||
        key.kid.length === 0 ||
        key.kid.length > 256 ||
        (key.alg !== undefined && key.alg !== "RS256") ||
        (key.use !== undefined && key.use !== "sig") ||
        typeof key.n !== "string" ||
        typeof key.e !== "string",
    )
  ) {
    throw new GitHubOidcUnavailableError("GitHub JWKS response is invalid");
  }

  let resolver: LocalJWKSet;
  try {
    resolver = createLocalJWKSet(value as unknown as JSONWebKeySet);
  } catch {
    throw new GitHubOidcUnavailableError("GitHub JWKS response is invalid");
  }
  const fetchedAt = Date.now();
  return { resolver, fetchedAt, expiresAt: fetchedAt + jwksCacheMilliseconds };
}

async function loadJwks(force: boolean): Promise<CachedJwks> {
  const now = Date.now();
  if (!force && cachedJwks !== undefined && cachedJwks.expiresAt > now) return cachedJwks;
  if (pendingJwks !== undefined) return pendingJwks;
  pendingJwks = fetchJwks();
  try {
    cachedJwks = await pendingJwks;
    return cachedJwks;
  } finally {
    pendingJwks = undefined;
  }
}

async function resolveGithubKey(
  protectedHeader: Parameters<LocalJWKSet>[0],
  token: Parameters<LocalJWKSet>[1],
): Promise<CryptoKey> {
  const jwks = await loadJwks(false);
  try {
    return await jwks.resolver(protectedHeader, token);
  } catch (error) {
    if (
      !(error instanceof errors.JWKSNoMatchingKey) ||
      Date.now() - jwks.fetchedAt < jwksCooldownMilliseconds
    ) {
      throw error;
    }
    return (await loadJwks(true)).resolver(protectedHeader, token);
  }
}

function claim(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 && value.length <= maximumClaimLength
    ? value
    : null;
}

function matchesPattern(value: string, pattern: string): boolean {
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

function grants(permissions: readonly Permission[], required: Permission): boolean {
  return permissions.includes("publish") || permissions.includes(required);
}

function grantsPackage(patterns: readonly string[], packageName: string | undefined): boolean {
  if (packageName === undefined) return true;
  return patterns.some((pattern) => {
    if (pattern.endsWith("/*")) return packageName.startsWith(pattern.slice(0, -1));
    return packageName === pattern;
  });
}

export async function authorizeGitHubOidc(
  token: string,
  context: RuntimeContext,
  required: Permission,
  packageName?: string,
): Promise<boolean> {
  const configuration = context.config.auth.githubOidc;
  if (configuration === undefined) return false;

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, resolveGithubKey, {
      algorithms: ["RS256"],
      audience: configuration.audience,
      clockTolerance: 5,
      issuer: githubIssuer,
      maxTokenAge: "10m",
      requiredClaims: [
        "sub",
        "exp",
        "iat",
        "nbf",
        "jti",
        "repository_id",
        "repository_owner_id",
        "ref",
        "workflow_ref",
        "event_name",
      ],
      typ: "JWT",
    });
    payload = verified.payload;
  } catch (error) {
    if (error instanceof GitHubOidcUnavailableError) throw error;
    return false;
  }

  const repositoryId = claim(payload, "repository_id");
  const repositoryOwnerId = claim(payload, "repository_owner_id");
  const ref = claim(payload, "ref");
  const workflowRef = claim(payload, "workflow_ref");
  const eventName = claim(payload, "event_name");
  const jobWorkflowRef = claim(payload, "job_workflow_ref");
  if (
    repositoryId === null ||
    repositoryOwnerId === null ||
    ref === null ||
    workflowRef === null ||
    eventName === null
  ) {
    return false;
  }
  if (eventName.includes("pull_request") || eventName === "merge_group") return false;

  return configuration.subjects.some(
    (subject) =>
      subject.repositoryId === repositoryId &&
      subject.repositoryOwnerId === repositoryOwnerId &&
      matchesPattern(ref, subject.ref) &&
      matchesPattern(workflowRef, subject.workflowRef) &&
      (subject.jobWorkflowRef === undefined
        ? jobWorkflowRef === null
        : jobWorkflowRef !== null && matchesPattern(jobWorkflowRef, subject.jobWorkflowRef)) &&
      grants(subject.permissions, required) &&
      grantsPackage(subject.packages, packageName),
  );
}

export function clearGitHubJwksCache(): void {
  cachedJwks = undefined;
  pendingJwks = undefined;
}
