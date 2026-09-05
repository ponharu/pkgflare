import { validRange } from "semver";

const scopePart = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const packagePart = "[a-z0-9_-][a-z0-9._-]*";
const packageNamePattern = new RegExp(`^@${scopePart}/${packagePart}$`);

export interface PackageRoute {
  packageName: string;
  remainder: string[];
}

export interface DistTagRoute {
  packageName: string;
  tag?: string;
}

export function parsePackageRoute(pathname: string): PackageRoute | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const segments = decoded.split("/").filter(Boolean);
  const scope = segments[0];
  const name = segments[1];
  if (scope === undefined || name === undefined || !scope.startsWith("@")) return null;
  const packageName = `${scope}/${name}`;
  if (packageName.length > 214 || !packageNamePattern.test(packageName)) return null;
  return { packageName, remainder: segments.slice(2) };
}

export function parseDistTagRoute(pathname: string): DistTagRoute | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (
    segments[0] !== "-" ||
    segments[1] !== "package" ||
    segments[4] !== "dist-tags" ||
    segments.length > 6
  ) {
    return null;
  }
  const scope = segments[2];
  const name = segments[3];
  if (scope === undefined || name === undefined) return null;
  const packageName = `${scope}/${name}`;
  if (packageName.length > 214 || !packageNamePattern.test(packageName)) return null;
  const tag = segments[5];
  return tag === undefined ? { packageName } : { packageName, tag };
}

export function isAllowedPackage(packageName: string, scopes: readonly string[]): boolean {
  const separator = packageName.indexOf("/");
  return separator > 0 && scopes.includes(packageName.slice(0, separator));
}

export function isValidDistTag(tag: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(tag) && validRange(tag, { loose: false }) === null;
}
