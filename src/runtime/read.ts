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

  if (selector !== undefined) {
    const [result] = await context.env.PKGFLARE_DB.batch<StoredVersionRow>([
      context.env.PKGFLARE_DB.prepare(
        "SELECT version, manifest_json, tarball_file, shasum, integrity, published_at FROM versions WHERE package_name = ?1 AND version = COALESCE((SELECT version FROM dist_tags WHERE package_name = ?1 AND tag = ?2), ?2)",
      ).bind(packageName, selector),
    ]);
    const row = result?.results[0];
    return row === undefined
      ? npmError(404, "not_found", "package version or dist-tag not found")
      : json(publicManifest(request, packageName, row), {
          headers: { "cache-control": "private, no-store" },
        });
  }

  const { versions, tags } = await packageRows(context, packageName);
  if (versions.length === 0) return npmError(404, "not_found", "package not found");

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

function byteRange(
  value: string | null,
  size: number,
): { offset: number; length: number } | "unsatisfiable" | null {
  if (value === null) return null;
  // Unsupported multiple ranges and malformed fields are ignored, never sent to R2.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  const [, first = "", last = ""] = match;
  const total = BigInt(size);
  if (first === "") {
    const suffix = BigInt(last);
    const length = Number(suffix < total ? suffix : total);
    return length === 0 ? "unsatisfiable" : { offset: size - length, length };
  }
  const start = BigInt(first);
  const end = last === "" ? null : BigInt(last);
  if (end !== null && end < start) return null;
  if (start >= total) return "unsatisfiable";
  const final = end !== null && end < total ? end : total - 1n;
  return { offset: Number(start), length: Number(final - start + 1n) };
}

function matchesIfNoneMatch(value: string | null, etag: string): boolean {
  if (value === null) return false;
  if (value.trim() === "*") return true;
  // Commas are legal inside opaque entity tags, so do not split the field on commas.
  const entityTag = /(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/g;
  const list = new RegExp(
    `^[\\t ]*(?:${entityTag.source})?(?:[\\t ]*,[\\t ]*(?:${entityTag.source})?)*[\\t ]*$`,
  );
  if (!list.test(value)) return false;
  const tags = value.match(entityTag);
  return tags?.some((tag) => tag.replace(/^W\//, "") === etag) ?? false;
}

function tarballHeaders(etag: string, integrity: string): Headers {
  return new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "content-type": "application/octet-stream",
    etag,
    "x-pkgflare-integrity": integrity,
  });
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
  const ifRange = request.headers.get("if-range");
  const isHead = request.method === "HEAD";
  const metadata =
    isHead || ifNoneMatch !== null || (range !== null && ifRange !== null)
      ? await context.env.PKGFLARE_BUCKET.head(row.tarball_key)
      : undefined;
  if (metadata === null) {
    return npmError(503, "storage_inconsistent", "published tarball is temporarily unavailable");
  }
  if (metadata !== undefined) {
    const headers = tarballHeaders(metadata.httpEtag, row.integrity);
    if (matchesIfNoneMatch(ifNoneMatch, metadata.httpEtag)) {
      return new Response(null, { status: 304, headers });
    }
    if (isHead) {
      headers.set("content-length", String(row.tarball_size));
      return new Response(null, { status: 200, headers });
    }
  }

  // No Last-Modified validator is advertised, so date-based If-Range cannot match.
  const selectedRange =
    ifRange !== null && ifRange.trim() !== metadata?.httpEtag
      ? null
      : byteRange(range, row.tarball_size);
  if (selectedRange === "unsatisfiable") {
    const response = npmError(416, "range_not_satisfiable", "tarball range is not satisfiable");
    response.headers.set("content-range", `bytes */${String(row.tarball_size)}`);
    return response;
  }
  const object = await context.env.PKGFLARE_BUCKET.get(
    row.tarball_key,
    selectedRange === null ? {} : { range: selectedRange },
  );
  if (object === null) {
    return npmError(503, "storage_inconsistent", "published tarball is temporarily unavailable");
  }
  const headers = tarballHeaders(object.httpEtag, row.integrity);
  headers.set("content-length", String(selectedRange?.length ?? row.tarball_size));
  if (selectedRange !== null) {
    const { offset, length } = selectedRange;
    headers.set(
      "content-range",
      `bytes ${String(offset)}-${String(offset + length - 1)}/${String(row.tarball_size)}`,
    );
  }
  return new Response(object.body, { status: selectedRange === null ? 200 : 206, headers });
}
