import { logRegistryError } from "./diagnostics.js";
import { isAllowedPackage } from "./package-name.js";
import {
  installManifestSql,
  installMediaType,
  prefersInstallMetadata,
} from "./install-metadata.js";
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

interface HistoryBounds {
  watermark: number | null;
  first: string | null;
  last: string | null;
}

interface VersionCursor {
  version: string;
  published_at: string;
}

async function* versionPages<T extends VersionCursor>(
  context: RuntimeContext,
  packageName: string,
  watermark: number,
  manifestColumn?: string,
): AsyncGenerator<T> {
  let cursor = "";
  while (true) {
    const [result] = await context.env.PKGFLARE_DB.batch<T>([
      context.env.PKGFLARE_DB.prepare(
        manifestColumn === undefined
          ? "SELECT version, published_at FROM versions WHERE package_name = ?1 AND version > ?2 AND rowid <= ?3 ORDER BY version LIMIT 128"
          : `WITH page AS (
            SELECT version, ${manifestColumn} AS manifest_json, tarball_file, shasum, integrity, published_at
            FROM versions WHERE package_name = ?1 AND version > ?2 AND rowid <= ?3 ORDER BY version LIMIT 128
          ), bounded AS (
            SELECT *, SUM(length(CAST(manifest_json AS BLOB))) OVER (ORDER BY version) AS bytes,
              ROW_NUMBER() OVER (ORDER BY version) AS position FROM page
          ) SELECT version, manifest_json, tarball_file, shasum, integrity, published_at
            FROM bounded WHERE bytes <= 1048576 OR position = 1 ORDER BY version`,
      ).bind(packageName, cursor, watermark),
    ]);
    const rows = result?.results ?? [];
    if (rows.length === 0) return;
    for (const row of rows) {
      cursor = row.version;
      yield row;
    }
  }
}

async function* packageJson(
  request: Request,
  context: RuntimeContext,
  packageName: string,
  watermark: number,
  abbreviated: boolean,
  tags: DistTagRow[],
  times: { created_at: string; updated_at: string } | undefined,
  bounds: HistoryBounds,
): AsyncGenerator<string> {
  const modified = times?.updated_at ?? bounds.last;
  const fields = abbreviated
    ? {
        name: packageName,
        modified,
        "dist-tags": Object.fromEntries(tags.map((row) => [row.tag, row.version])),
      }
    : {
        _id: packageName,
        name: packageName,
        "dist-tags": Object.fromEntries(tags.map((row) => [row.tag, row.version])),
      };
  yield `${JSON.stringify(fields).slice(0, -1)},"versions":{`;
  let separator = "";
  for await (const row of versionPages<StoredVersionRow>(
    context,
    packageName,
    watermark,
    abbreviated ? installManifestSql : "manifest_json",
  )) {
    yield `${separator}${JSON.stringify(row.version)}:${JSON.stringify(publicManifest(request, packageName, row))}`;
    separator = ",";
  }
  yield "}";
  if (!abbreviated) {
    yield `,"time":${JSON.stringify({ created: times?.created_at ?? bounds.first, modified }).slice(0, -1)}`;
    for await (const row of versionPages<VersionCursor>(context, packageName, watermark)) {
      yield `,${JSON.stringify(row.version)}:${JSON.stringify(row.published_at)}`;
    }
    yield "}";
  }
  yield "}";
}

function metadataBody(
  context: RuntimeContext,
  chunks: AsyncGenerator<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await chunks.next();
          if (chunk.done) controller.close();
          else controller.enqueue(encoder.encode(chunk.value));
        } catch (error) {
          logRegistryError(context.requestId, "metadata_stream", error);
          controller.error(new Error("package metadata could not be read"));
        }
      },
      async cancel() {
        await chunks.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
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

  const abbreviated = prefersInstallMetadata(request.headers.get("accept"));
  // Capture tags, timestamps and the immutable version high-water mark together.
  // Later pages exclude publications committed after this snapshot.
  const [boundsResult, tagsResult, timesResult] = await context.env.PKGFLARE_DB.batch([
    context.env.PKGFLARE_DB.prepare(
      "SELECT MAX(rowid) AS watermark, MIN(published_at) AS first, MAX(published_at) AS last FROM versions WHERE package_name = ?1",
    ).bind(packageName),
    context.env.PKGFLARE_DB.prepare(
      "SELECT tag, version FROM dist_tags WHERE package_name = ?1 ORDER BY tag",
    ).bind(packageName),
    context.env.PKGFLARE_DB.prepare(
      "SELECT created_at, updated_at FROM packages WHERE name = ?1",
    ).bind(packageName),
  ]);
  const bounds = boundsResult?.results[0] as HistoryBounds | undefined;
  if (bounds?.watermark === null || bounds?.watermark === undefined)
    return npmError(404, "not_found", "package not found");
  const tags = (tagsResult?.results ?? []) as unknown as DistTagRow[];
  const times = timesResult?.results[0] as { created_at: string; updated_at: string } | undefined;
  const headers = {
    "cache-control": "private, no-store",
    vary: "Accept",
    "content-type": abbreviated
      ? `${installMediaType}; charset=utf-8`
      : "application/json; charset=utf-8",
  };
  return new Response(
    request.method === "HEAD"
      ? null
      : metadataBody(
          context,
          packageJson(
            request,
            context,
            packageName,
            bounds.watermark,
            abbreviated,
            tags,
            times,
            bounds,
          ),
        ),
    { headers },
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

const MAX_IF_NONE_MATCH_LENGTH = 8 * 1024;

function matchesIfNoneMatch(value: string | null, etag: string): boolean {
  if (value === null || value.length > MAX_IF_NONE_MATCH_LENGTH) return false;
  if (value.trim() === "*") return true;

  let index = 0;
  let matched = false;
  while (index < value.length) {
    while (value[index] === " " || value[index] === "\t") index += 1;
    if (index === value.length) break;
    // Empty list members are permitted by the HTTP list extension grammar.
    if (value[index] === ",") {
      index += 1;
      continue;
    }

    if (value.startsWith("W/", index)) index += 2;
    if (value[index] !== '"') return false;
    const tagStart = index;
    index += 1;
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index);
      if (code !== 0x21 && !(code >= 0x23 && code <= 0x7e) && !(code >= 0x80 && code <= 0xff)) {
        return false;
      }
      index += 1;
    }
    if (index === value.length) return false;
    index += 1;
    matched ||= value.slice(tagStart, index) === etag;

    while (value[index] === " " || value[index] === "\t") index += 1;
    if (index === value.length) return matched;
    if (value[index] !== ",") return false;
    index += 1;
  }
  return matched;
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
