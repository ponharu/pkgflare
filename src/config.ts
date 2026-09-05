export type Permission = "read" | "publish";

export interface SecretTokenConfig {
  binding: string;
  permissions: readonly Permission[];
}

export interface SecretsAuthConfig {
  provider: "secrets";
  tokens: readonly SecretTokenConfig[];
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
  };
}

const workerNamePattern = /^[a-z](?:[a-z0-9-]{0,52}[a-z0-9])?$/;
const accountIdPattern = /^[a-f0-9]{32}$/;
const scopePattern = /^@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const bindingPattern = /^[A-Z][A-Z0-9_]*$/;
const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const reservedBindings = new Set(["PKGFLARE_DB", "PKGFLARE_BUCKET", "PKGFLARE_CONFIG"]);

export function defineConfig(config: PkgflareConfig): PkgflareConfig {
  return config;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  if (!Array.isArray(auth.tokens) || auth.tokens.length === 0) {
    throw new Error("at least one authentication token binding is required");
  }

  const seenBindings = new Set<string>();
  const tokens = auth.tokens.map((tokenValue) => {
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

    if (
      !Array.isArray(permissionValues) ||
      permissionValues.length === 0 ||
      permissionValues.some((permission) => permission !== "read" && permission !== "publish")
    ) {
      throw new Error(`invalid permissions for ${binding}`);
    }
    const permissions = [...new Set(permissionValues)] as Permission[];

    return { binding, permissions };
  });

  return {
    name,
    scopes,
    ...(accountId === undefined ? {} : { accountId }),
    ...(hostname === undefined ? {} : { hostname }),
    auth: { provider: "secrets", tokens },
  };
}
