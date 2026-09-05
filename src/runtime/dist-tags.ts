import { valid as validVersion } from "semver";
import { isAllowedPackage, isValidDistTag } from "./package-name.js";
import { json, npmError } from "./response.js";
import type { DistTagRow, RuntimeContext } from "./types.js";

const maximumDistTagBodyBytes = 256;

async function readVersion(request: Request): Promise<unknown> {
  if (request.body === null) throw new Error("missing body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let contents = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumDistTagBodyBytes) {
        await reader.cancel();
        throw new PublishTagBodyError(413, "dist-tag request body exceeds 256 bytes");
      }
      contents += decoder.decode(value, { stream: true });
    }
    contents += decoder.decode();
    return JSON.parse(contents) as unknown;
  } finally {
    reader.releaseLock();
  }
}

class PublishTagBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readDistTags(
  context: RuntimeContext,
  packageName: string,
): Promise<Response> {
  if (!isAllowedPackage(packageName, context.config.scopes)) {
    return npmError(404, "not_found", "package not found");
  }
  const result = await context.env.PKGFLARE_DB.prepare(
    "SELECT tag, version FROM dist_tags WHERE package_name = ?1 ORDER BY tag",
  )
    .bind(packageName)
    .all<DistTagRow>();
  if (result.results.length === 0) {
    const packageRow = await context.env.PKGFLARE_DB.prepare(
      "SELECT 1 AS present FROM packages WHERE name = ?1",
    )
      .bind(packageName)
      .first<{ present: number }>();
    if (packageRow === null) return npmError(404, "not_found", "package not found");
  }
  return json(Object.fromEntries(result.results.map((row) => [row.tag, row.version])), {
    headers: { "cache-control": "private, no-store" },
  });
}

export async function setDistTag(
  request: Request,
  context: RuntimeContext,
  packageName: string,
  tag: string,
): Promise<Response> {
  if (!isAllowedPackage(packageName, context.config.scopes)) {
    return npmError(404, "not_found", "package not found");
  }
  if (!isValidDistTag(tag)) return npmError(400, "bad_request", "dist-tag is invalid");
  let version: unknown;
  try {
    version = await readVersion(request);
  } catch (error) {
    if (error instanceof PublishTagBodyError) {
      return npmError(error.status, "payload_too_large", error.message);
    }
    return npmError(400, "bad_request", "dist-tag target must be a JSON version string");
  }
  if (typeof version !== "string" || validVersion(version, { loose: false }) !== version) {
    return npmError(400, "bad_request", "dist-tag target must be a valid strict semver version");
  }
  const result = await context.env.PKGFLARE_DB.prepare(
    "INSERT INTO dist_tags (package_name, tag, version) SELECT package_name, ?3, version FROM versions WHERE package_name = ?1 AND version = ?2 ON CONFLICT(package_name, tag) DO UPDATE SET version = excluded.version",
  )
    .bind(packageName, version, tag)
    .run();
  if (result.meta.changes === 0) {
    return npmError(404, "not_found", "package version not found");
  }
  return json({ ok: true });
}

export async function deleteDistTag(
  context: RuntimeContext,
  packageName: string,
  tag: string,
): Promise<Response> {
  if (!isAllowedPackage(packageName, context.config.scopes)) {
    return npmError(404, "not_found", "package not found");
  }
  if (!isValidDistTag(tag)) return npmError(400, "bad_request", "dist-tag is invalid");
  const result = await context.env.PKGFLARE_DB.prepare(
    "DELETE FROM dist_tags WHERE package_name = ?1 AND tag = ?2",
  )
    .bind(packageName, tag)
    .run();
  return result.meta.changes === 0
    ? npmError(404, "not_found", "dist-tag not found")
    : json({ ok: true });
}
