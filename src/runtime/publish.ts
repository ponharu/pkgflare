import { valid as validVersion } from "semver";
import { logRegistryError } from "./diagnostics.js";
import { isAllowedPackage } from "./package-name.js";
import { parsePublishRequest, type PendingTarball, PublishStreamError } from "./publish-stream.js";
import { json, npmError } from "./response.js";
import type { PackageManifest, PublishDocument, RuntimeContext } from "./types.js";

interface Attachment {
  content_type?: unknown;
  data?: unknown;
  length?: unknown;
}

export interface ValidatedPublish {
  packageName: string;
  version: string;
  manifest: PackageManifest;
  tags: Record<string, string>;
  filename: string;
  tarball: PendingTarball;
}

class PublishError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDocument(
  value: unknown,
  pathPackageName: string,
  scopes: readonly string[],
  tarball: PendingTarball,
): ValidatedPublish {
  if (!object(value)) {
    throw new PublishError(400, "bad_request", "publish document must be an object");
  }
  const document = value as PublishDocument;
  if (
    document.name !== pathPackageName ||
    (document._id !== undefined && document._id !== pathPackageName)
  ) {
    throw new PublishError(400, "bad_request", "package name does not match request path");
  }
  if (!isAllowedPackage(pathPackageName, scopes)) {
    throw new PublishError(403, "forbidden", "package scope is not configured for this registry");
  }
  if (!object(document.versions) || Object.keys(document.versions).length !== 1) {
    throw new PublishError(400, "bad_request", "publish must contain exactly one version");
  }

  const [versionEntry] = Object.entries(document.versions);
  if (
    versionEntry === undefined ||
    validVersion(versionEntry[0], { loose: false }) !== versionEntry[0]
  ) {
    throw new PublishError(400, "bad_request", "package version must be valid strict semver");
  }
  const [version, manifestValue] = versionEntry;
  if (
    !object(manifestValue) ||
    manifestValue.name !== pathPackageName ||
    manifestValue.version !== version
  ) {
    throw new PublishError(
      400,
      "bad_request",
      "manifest name and version must match the publish document",
    );
  }

  if (!object(document["dist-tags"]) || Object.keys(document["dist-tags"]).length === 0) {
    throw new PublishError(400, "bad_request", "at least one dist-tag is required");
  }
  const tags: Record<string, string> = {};
  for (const [tag, target] of Object.entries(document["dist-tags"])) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(tag) || target !== version) {
      throw new PublishError(400, "bad_request", "dist-tags must reference the published version");
    }
    tags[tag] = version;
  }

  if (!object(document._attachments) || Object.keys(document._attachments).length !== 1) {
    throw new PublishError(
      400,
      "bad_request",
      "publish must contain exactly one tarball attachment",
    );
  }
  const [attachmentEntry] = Object.entries(document._attachments);
  if (attachmentEntry === undefined || !object(attachmentEntry[1])) {
    throw new PublishError(400, "bad_request", "tarball attachment is invalid");
  }
  const [attachmentName, attachment] = attachmentEntry as [string, Attachment];
  const packageBasename = pathPackageName.slice(pathPackageName.indexOf("/") + 1);
  const filename = `${packageBasename}-${version}.tgz`;
  const standardScopedName = `${pathPackageName}-${version}.tgz`;
  if (
    (attachmentName !== filename && attachmentName !== standardScopedName) ||
    attachmentName !== tarball.filename ||
    typeof attachment.data !== "string"
  ) {
    throw new PublishError(400, "bad_request", "tarball attachment is invalid");
  }
  if (
    attachment.content_type !== undefined &&
    attachment.content_type !== "application/octet-stream"
  ) {
    throw new PublishError(
      400,
      "bad_request",
      "tarball attachment has an unsupported content type",
    );
  }
  if (attachment.length !== undefined && attachment.length !== tarball.length) {
    throw new PublishError(400, "bad_request", "tarball attachment length does not match its data");
  }

  return {
    packageName: pathPackageName,
    version,
    manifest: manifestValue as PackageManifest,
    tags,
    filename,
    tarball,
  };
}

function verifyClientChecksums(manifest: PackageManifest, shasum: string, integrity: string): void {
  if (manifest.dist?.shasum !== undefined && manifest.dist.shasum !== shasum) {
    throw new PublishError(400, "bad_request", "tarball SHA-1 does not match manifest");
  }
  if (manifest.dist?.integrity !== undefined && manifest.dist.integrity !== integrity) {
    throw new PublishError(400, "bad_request", "tarball integrity does not match manifest");
  }
}

export async function reconcileCommit(
  context: RuntimeContext,
  publish: ValidatedPublish,
): Promise<Response> {
  const { shasum, integrity } = publish.tarball;
  let committed: { tarball_key: string; shasum: string; integrity: string } | null;
  try {
    committed = await context.env.PKGFLARE_DB.prepare(
      "SELECT tarball_key, shasum, integrity FROM versions WHERE package_name = ?1 AND version = ?2",
    )
      .bind(publish.packageName, publish.version)
      .first<{ tarball_key: string; shasum: string; integrity: string }>();
  } catch (error) {
    logRegistryError(context.requestId, "publish_d1_reconcile", error);
    return npmError(503, "storage_error", "publish outcome is unknown; retry the same version");
  }

  if (
    committed?.tarball_key === publish.tarball.key &&
    committed.shasum === shasum &&
    committed.integrity === integrity
  ) {
    return json({ ok: true, id: publish.packageName, rev: publish.version }, { status: 201 });
  }
  if (committed !== null) {
    await context.env.PKGFLARE_BUCKET.delete(publish.tarball.key).catch((error) => {
      logRegistryError(context.requestId, "publish_r2_cleanup", error);
    });
    return npmError(409, "conflict", "package version already exists");
  }
  return npmError(503, "storage_error", "publish was not committed; retrying is safe");
}

export async function publishPackage(
  request: Request,
  context: RuntimeContext,
  packageName: string,
): Promise<Response> {
  if (!isAllowedPackage(packageName, context.config.scopes)) {
    return npmError(403, "forbidden", "package scope is not configured for this registry");
  }
  let parsed: Awaited<ReturnType<typeof parsePublishRequest>>;
  try {
    parsed = await parsePublishRequest(request, context.env.PKGFLARE_BUCKET, packageName);
  } catch (error) {
    if (error instanceof PublishStreamError) {
      return npmError(error.status, error.code, error.message);
    }
    logRegistryError(context.requestId, "publish_parse", error);
    return npmError(503, "storage_error", "publish request could not be stored; retry is safe");
  }

  let completed = false;
  try {
    const publish = validateDocument(
      parsed.document,
      packageName,
      context.config.scopes,
      parsed.tarball,
    );
    const existing = await context.env.PKGFLARE_DB.prepare(
      "SELECT 1 AS present FROM versions WHERE package_name = ?1 AND version = ?2",
    )
      .bind(publish.packageName, publish.version)
      .first<{ present: number }>();
    if (existing !== null) {
      await publish.tarball.abort();
      return npmError(409, "conflict", "package version already exists");
    }

    const { shasum, integrity } = publish.tarball;
    verifyClientChecksums(publish.manifest, shasum, integrity);
    const stored = await publish.tarball.complete();
    completed = true;
    if (stored.size !== publish.tarball.length) {
      await context.env.PKGFLARE_BUCKET.delete(publish.tarball.key).catch(() => undefined);
      logRegistryError(context.requestId, "publish_r2_size", new Error("stored size mismatch"));
      return npmError(503, "storage_error", "tarball storage could not be verified");
    }

    const now = new Date().toISOString();
    const manifest = {
      ...publish.manifest,
      dist: {
        ...publish.manifest.dist,
        shasum,
        integrity,
      },
    };
    const statements = [
      context.env.PKGFLARE_DB.prepare(
        "INSERT INTO packages (name, created_at, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at",
      ).bind(publish.packageName, now),
      context.env.PKGFLARE_DB.prepare(
        "INSERT INTO versions (package_name, version, manifest_json, tarball_key, tarball_file, shasum, integrity, tarball_size, published_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      ).bind(
        publish.packageName,
        publish.version,
        JSON.stringify(manifest),
        publish.tarball.key,
        publish.filename,
        shasum,
        integrity,
        publish.tarball.length,
        now,
      ),
      ...Object.entries(publish.tags).map(([tag, version]) =>
        context.env.PKGFLARE_DB.prepare(
          "INSERT INTO dist_tags (package_name, tag, version) VALUES (?1, ?2, ?3) ON CONFLICT(package_name, tag) DO UPDATE SET version = excluded.version",
        ).bind(publish.packageName, tag, version),
      ),
    ];
    try {
      await context.env.PKGFLARE_DB.batch(statements);
      return json({ ok: true, id: publish.packageName, rev: publish.version }, { status: 201 });
    } catch (error) {
      logRegistryError(context.requestId, "publish_d1_commit", error);
      return reconcileCommit(context, publish);
    }
  } catch (error) {
    if (!completed) await parsed.tarball.abort().catch(() => undefined);
    if (error instanceof PublishError) return npmError(error.status, error.code, error.message);
    logRegistryError(context.requestId, "publish", error);
    return npmError(503, "storage_error", "publish failed; retrying the same version is safe");
  }
}
