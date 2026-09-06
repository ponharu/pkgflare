export type Permission = "read" | "publish";

export interface SecretTokenConfig {
  binding: string;
  permissions: readonly Permission[];
}

export interface GitHubOidcSubjectConfig {
  repositoryId: string;
  repositoryOwnerId: string;
  ref: string;
  workflowRef: string;
  jobWorkflowRef?: string;
  permissions: readonly Permission[];
  packages: readonly string[];
}

export interface GitHubOidcConfig {
  audience: string;
  subjects: readonly GitHubOidcSubjectConfig[];
}

export interface SecretsAuthConfig {
  provider: "secrets";
  tokens?: readonly SecretTokenConfig[];
  githubOidc?: GitHubOidcConfig;
}

export interface PkgflareConfig {
  name: string;
  scopes: readonly string[];
  accountId?: string;
  hostname?: string;
  auth: SecretsAuthConfig;
}

export interface NormalizedConfig {
  name: string;
  scopes: string[];
  accountId?: string;
  hostname?: string;
  auth: {
    provider: "secrets";
    tokens: Array<{
      binding: string;
      permissions: Permission[];
    }>;
    githubOidc?: {
      audience: string;
      subjects: Array<{
        repositoryId: string;
        repositoryOwnerId: string;
        ref: string;
        workflowRef: string;
        jobWorkflowRef?: string;
        permissions: Permission[];
        packages: string[];
      }>;
    };
  };
}

const workerNamePattern = /^[a-z](?:[a-z0-9-]{0,52}[a-z0-9])?$/;
const accountIdPattern = /^[a-f0-9]{32}$/;
const scopePattern = /^@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const bindingPattern = /^[A-Z][A-Z0-9_]*$/;
const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const reservedBindings = new Set(["PKGFLARE_DB", "PKGFLARE_BUCKET", "PKGFLARE_CONFIG"]);
const githubIdPattern = /^[1-9][0-9]{0,19}$/;
const audiencePattern = /^[\x21-\x7e]{1,256}$/;
const refPattern = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+\*?$/;
const workflowRefPattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+\*?$/;
const jobWorkflowRefPattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@(?:refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+\*?|[0-9a-f]{40})$/;
const packageSegmentPattern = /^(?!\.)(?:[a-z0-9._-]+)$/;
const maximumGithubSubjects = 128;
const maximumPackagesPerSubject = 128;
const maximumRuntimeConfigBytes = 5 * 1024;

export function defineConfig(config: PkgflareConfig): PkgflareConfig {
  return config;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePermissions(value: unknown, label: string): Permission[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((permission) => permission !== "read" && permission !== "publish")
  ) {
    throw new Error(`invalid permissions for ${label}`);
  }
  return [...new Set(value)] as Permission[];
}

function isSafePattern(value: string, pattern: RegExp): boolean {
  if (!pattern.test(value)) return false;
  const wildcard = value.indexOf("*");
  return wildcard === -1 || wildcard === value.length - 1;
}

function normalizeGithubOidc(
  value: unknown,
  configuredScopes: readonly string[],
): NormalizedConfig["auth"]["githubOidc"] {
  if (!isObject(value) || typeof value.audience !== "string") {
    throw new Error("githubOidc must define an audience and trusted subjects");
  }
  if (!audiencePattern.test(value.audience)) {
    throw new Error("githubOidc audience must be 1-256 printable ASCII characters");
  }
  if (
    !Array.isArray(value.subjects) ||
    value.subjects.length === 0 ||
    value.subjects.length > maximumGithubSubjects
  ) {
    throw new Error(`githubOidc must define 1-${String(maximumGithubSubjects)} subjects`);
  }

  const subjects = value.subjects.map((subjectValue, index) => {
    const label = `githubOidc subject ${String(index + 1)}`;
    if (!isObject(subjectValue)) throw new Error(`${label} must be an object`);
    const { repositoryId, repositoryOwnerId, ref, workflowRef, jobWorkflowRef } = subjectValue;
    if (typeof repositoryId !== "string" || !githubIdPattern.test(repositoryId)) {
      throw new Error(`${label} repositoryId must be a decimal GitHub repository ID`);
    }
    if (typeof repositoryOwnerId !== "string" || !githubIdPattern.test(repositoryOwnerId)) {
      throw new Error(`${label} repositoryOwnerId must be a decimal GitHub owner ID`);
    }
    if (typeof ref !== "string" || !isSafePattern(ref, refPattern)) {
      throw new Error(`${label} ref must be an exact branch/tag ref or trailing-wildcard pattern`);
    }
    if (typeof workflowRef !== "string" || !isSafePattern(workflowRef, workflowRefPattern)) {
      throw new Error(
        `${label} workflowRef must identify a workflow file at an exact or trailing-wildcard ref`,
      );
    }
    if (
      jobWorkflowRef !== undefined &&
      (typeof jobWorkflowRef !== "string" || !isSafePattern(jobWorkflowRef, jobWorkflowRefPattern))
    ) {
      throw new Error(
        `${label} jobWorkflowRef must identify a reusable workflow at a full commit SHA or an exact/trailing-wildcard branch or tag ref`,
      );
    }
    const permissions = normalizePermissions(subjectValue.permissions, label);
    if (
      !Array.isArray(subjectValue.packages) ||
      subjectValue.packages.length === 0 ||
      subjectValue.packages.length > maximumPackagesPerSubject ||
      subjectValue.packages.some((packageName) => typeof packageName !== "string")
    ) {
      throw new Error(
        `${label} must define 1-${String(maximumPackagesPerSubject)} package patterns`,
      );
    }
    const packages = [...new Set(subjectValue.packages as string[])];
    for (const packagePattern of packages) {
      const slash = packagePattern.indexOf("/");
      const scope = packagePattern.slice(0, slash);
      const packageSegment = packagePattern.slice(slash + 1);
      if (
        slash === -1 ||
        packagePattern.length > 214 ||
        !configuredScopes.includes(scope) ||
        (packageSegment !== "*" && !packageSegmentPattern.test(packageSegment))
      ) {
        throw new Error(`${label} contains an invalid or unconfigured package pattern`);
      }
    }
    return {
      repositoryId,
      repositoryOwnerId,
      ref,
      workflowRef,
      ...(jobWorkflowRef === undefined ? {} : { jobWorkflowRef }),
      permissions,
      packages,
    };
  });
  return { audience: value.audience, subjects };
}

export function normalizeConfig(value: unknown): NormalizedConfig {
  if (!isObject(value)) throw new Error("configuration must be an object");
  const { name, scopes: scopeValues, accountId, hostname, auth } = value;
  if (typeof name !== "string" || !workerNamePattern.test(name)) {
    throw new Error("name must be a lowercase Cloudflare resource name of at most 54 characters");
  }

  if (
    accountId !== undefined &&
    (typeof accountId !== "string" || !accountIdPattern.test(accountId))
  ) {
    throw new Error("accountId must be a 32-character lowercase hexadecimal Cloudflare account ID");
  }

  if (
    !Array.isArray(scopeValues) ||
    scopeValues.length === 0 ||
    scopeValues.some((scope) => typeof scope !== "string")
  ) {
    throw new Error("at least one package scope is required");
  }

  const scopes = [...new Set(scopeValues as string[])];
  for (const scope of scopes) {
    if (!scopePattern.test(scope)) {
      throw new Error(`invalid package scope: ${scope}`);
    }
  }

  if (hostname !== undefined && (typeof hostname !== "string" || !hostnamePattern.test(hostname))) {
    throw new Error("hostname must be a valid DNS hostname without a scheme or path");
  }

  if (!isObject(auth) || auth.provider !== "secrets") {
    throw new Error("unsupported authentication provider");
  }

  const tokenValues = auth.tokens ?? [];
  if (!Array.isArray(tokenValues)) {
    throw new Error("authentication token bindings must be an array");
  }

  const seenBindings = new Set<string>();
  const tokens = tokenValues.map((tokenValue) => {
    if (!isObject(tokenValue) || typeof tokenValue.binding !== "string") {
      throw new Error("authentication token binding must be an object with a binding name");
    }
    const { binding, permissions: permissionValues } = tokenValue;
    if (!bindingPattern.test(binding)) {
      throw new Error(`invalid secret binding: ${binding}`);
    }
    if (reservedBindings.has(binding)) {
      throw new Error(`secret binding is reserved by pkgflare: ${binding}`);
    }
    if (seenBindings.has(binding)) {
      throw new Error(`duplicate secret binding: ${binding}`);
    }
    seenBindings.add(binding);

    const permissions = normalizePermissions(permissionValues, binding);

    return { binding, permissions };
  });

  const githubOidc =
    auth.githubOidc === undefined ? undefined : normalizeGithubOidc(auth.githubOidc, scopes);
  if (tokens.length === 0 && githubOidc === undefined) {
    throw new Error("at least one authentication method is required");
  }

  const normalized: NormalizedConfig = {
    name,
    scopes,
    ...(accountId === undefined ? {} : { accountId }),
    ...(hostname === undefined ? {} : { hostname }),
    auth: {
      provider: "secrets",
      tokens,
      ...(githubOidc === undefined ? {} : { githubOidc }),
    },
  };
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > maximumRuntimeConfigBytes) {
    throw new Error("normalized configuration exceeds the 5 KiB Worker variable limit");
  }
  return normalized;
}
