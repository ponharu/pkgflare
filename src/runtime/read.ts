import { isAllowedPackage } from "./package-name.js";
import { json, npmError } from "./response.js";
import type {
  DistTagRow,
  PackageManifest,
  RuntimeContext,
  StoredVersionRow,
  TarballRow,
} from "./types.js";

function tarballUrl(request: Request, packageName: string, filename: string): string {
  const url = new URL(request.url);
  const packagePath = packageName.split("/").map(encodeURIComponent).join("/");
  return `${url.origin}/${packagePath}/-/${encodeURIComponent(filename)}`;
}

function publicManifest(
  request: Request,
  packageName: string,
  row: StoredVersionRow,
): PackageManifest {
  const manifest = JSON.parse(row.manifest_json) as PackageManifest;
  return {
    ...manifest,
    dist: {
      ...manifest.dist,
      tarball: tarballUrl(request, packageName, row.tarball_file),
      shasum: row.shasum,
      integrity: row.integrity,
    },
  };
}

async function packageRows(
  context: RuntimeContext,
  packageName: string,
): Promise<{ versions: StoredVersionRow[]; tags: DistTagRow[] }> {
  const [versionsResult, tagsResult] = (await context.env.PKGFLARE_DB.batch([
    context.env.PKGFLARE_DB.prepare(
      "SELECT version, manifest_json, tarball_file, shasum, integrity, published_at FROM versions WHERE package_name = ?1 ORDER BY published_at",
    ).bind(packageName),
    context.env.PKGFLARE_DB.prepare(
      "SELECT tag, version FROM dist_tags WHERE package_name = ?1 ORDER BY tag",
    ).bind(packageName),
  ])) as [D1Result<StoredVersionRow>, D1Result<DistTagRow>];
  return { versions: versionsResult.results ?? [], tags: tagsResult.results ?? [] };
}

export async function readPackage(
  request: Request,
  context: RuntimeContext,
  packageName: string,
  selector?: string,
): Promise<Response> {
  if (!isAllowedPackage(packageName, context.config.scopes)) {
    return npmError(404, "not_found", "package not found");
  }

  const { versions, tags } = await packageRows(context, packageName);
  if (versions.length === 0) return npmError(404, "not_found", "package not found");

  if (selector !== undefined) {
    const selectedVersion = tags.find((row) => row.tag === selector)?.version ?? selector;
    const row = versions.find((candidate) => candidate.version === selectedVersion);
    return row === undefined
      ? npmError(404, "not_found", "package version or dist-tag not found")
      : json(publicManifest(request, packageName, row), {
          headers: { "cache-control": "private, no-store" },
        });
  }

  const manifests = Object.fromEntries(
    versions.map((row) => [row.version, publicManifest(request, packageName, row)]),
  );
  const distTags = Object.fromEntries(tags.map((row) => [row.tag, row.version]));
  const publishedTimes = Object.fromEntries(versions.map((row) => [row.version, row.published_at]));
  return json(
    {
      _id: packageName,
      name: packageName,
      "dist-tags": distTags,
      versions: manifests,
      time: {
        created: versions[0]?.published_at,
        modified: versions.at(-1)?.published_at,
        ...publishedTimes,
      },
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

function contentRange(object: R2ObjectBody): { header: string; length: number } | null {
  if (object.range === undefined) return null;
  if ("offset" in object.range) {
    const length = object.range.length ?? object.size - object.range.offset;
    return {
      header: `bytes ${String(object.range.offset)}-${String(object.range.offset + length - 1)}/${String(object.size)}`,
      length,
    };
  }
  if ("suffix" in object.range) {
    return {
      header: `bytes ${String(object.size - object.range.suffix)}-${String(object.size - 1)}/${String(object.size)}`,
      length: object.range.suffix,
    };
  }
  return null;
}

export async function readTarball(
  request: Request,
  context: RuntimeContext,
  packageName: string,
  filename: string,
): Promise<Response> {
  if (!isAllowedPackage(packageName, context.config.scopes)) {
    return npmError(404, "not_found", "tarball not found");
  }

  const row = await context.env.PKGFLARE_DB.prepare(
    "SELECT tarball_key, shasum, integrity, tarball_size FROM versions WHERE package_name = ?1 AND tarball_file = ?2",
  )
    .bind(packageName, filename)
    .first<TarballRow>();
  if (row === null) return npmError(404, "not_found", "tarball not found");

  const ifNoneMatch = request.headers.get("if-none-match");
  const range = request.headers.get("range");
  const object =
    request.method === "HEAD"
      ? await context.env.PKGFLARE_BUCKET.head(row.tarball_key)
      : await context.env.PKGFLARE_BUCKET.get(
          row.tarball_key,
          range === null ? {} : { range: request.headers },
        );
  if (object === null) {
    return npmError(503, "storage_inconsistent", "published tarball is temporarily unavailable");
  }

  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "content-type": "application/octet-stream",
    etag: object.httpEtag,
    "x-pkgflare-integrity": row.integrity,
  });
  if (ifNoneMatch === object.httpEtag && range === null) {
    return new Response(null, { status: 304, headers });
  }

  if (request.method === "HEAD") {
    headers.set("content-length", String(row.tarball_size));
    return new Response(null, { status: 200, headers });
  }

  const body = object as R2ObjectBody;
  const rangeHeader = range === null ? null : contentRange(body);
  if (rangeHeader !== null) {
    headers.set("content-range", rangeHeader.header);
    headers.set("content-length", String(rangeHeader.length));
  } else {
    headers.set("content-length", String(row.tarball_size));
  }
  return new Response(body.body, { status: rangeHeader === null ? 200 : 206, headers });
}
