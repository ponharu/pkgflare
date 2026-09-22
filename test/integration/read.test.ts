import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../../src/config.js";
import { readPackage } from "../../src/runtime/read.js";

const name = "@acme/large-history";
const registry = exports.default;
const headers = { authorization: "Bearer read-secret" };
const url = `https://registry.example/${encodeURIComponent(name)}`;

beforeAll(async () => {
  await applyD1Migrations(env.PKGFLARE_DB, env.TEST_MIGRATIONS);
  await env.PKGFLARE_DB.prepare("INSERT INTO packages VALUES (?1, ?2, ?2)")
    .bind(name, "2026-01-01T00:00:00.000Z")
    .run();
  for (let start = 0; start < 1000; start += 50) {
    const statements = Array.from({ length: 50 }, (_, index) => {
      const version = `1.0.${String(start + index)}`;
      return env.PKGFLARE_DB.prepare(
        "INSERT INTO versions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      ).bind(
        name,
        version,
        JSON.stringify({
          name,
          version,
          description: "metadata ".repeat(128),
          dependencies: { "@acme/dependency": "^1.0.0" },
        }),
        `history/${version}`,
        `large-history-${version}.tgz`,
        "test-shasum",
        "test-integrity",
        8,
        "2026-01-01T00:00:00.000Z",
      );
    });
    await env.PKGFLARE_DB.batch(statements);
  }
  await env.PKGFLARE_DB.prepare("INSERT INTO dist_tags VALUES (?1, ?2, ?3)")
    .bind(name, "latest", "1.0.999")
    .run();
});

afterEach(() => vi.restoreAllMocks());

describe("selected package metadata", () => {
  it.each([
    ["1.0.0", "1.0.0"],
    ["latest", "1.0.999"],
    ["missing", undefined],
  ])("keeps D1 reads bounded for selector %s across 1000 versions", async (selector, version) => {
    let rowsRead = 0;
    const batch = env.PKGFLARE_DB.batch.bind(env.PKGFLARE_DB);
    vi.spyOn(env.PKGFLARE_DB, "batch").mockImplementation(
      async <T>(statements: D1PreparedStatement[]) => {
        const results = await batch<T>(statements);
        rowsRead += results.reduce((total, result) => total + result.meta.rows_read, 0);
        return results;
      },
    );
    const response = await readPackage(
      new Request(`${url}/${selector}`),
      {
        env: {
          PKGFLARE_DB: env.PKGFLARE_DB,
          PKGFLARE_BUCKET: env.PKGFLARE_BUCKET,
          PKGFLARE_CONFIG: env.PKGFLARE_CONFIG,
        },
        config: normalizeConfig(JSON.parse(env.PKGFLARE_CONFIG)),
        requestId: "selected-read-test",
      },
      name,
      selector,
    );
    expect(response.status).toBe(version === undefined ? 404 : 200);
    const body = await response.json();
    if (version !== undefined) {
      expect(rowsRead).toBeGreaterThan(0);
      expect(body).toMatchObject({
        name,
        version,
        dependencies: { "@acme/dependency": "^1.0.0" },
        dist: { shasum: "test-shasum", integrity: "test-integrity" },
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(rowsRead).toBeLessThan(20);
  });

  it("reflects tag changes immediately and preserves exact-version and HEAD responses", async () => {
    const tagUrl = `https://registry.example/-/package/${encodeURIComponent(name)}/dist-tags/moving`;
    for (const version of ["1.0.999", "1.0.0"]) {
      expect(
        (
          await registry.fetch(tagUrl, {
            method: "PUT",
            headers: { authorization: "Bearer publish-secret" },
            body: JSON.stringify(version),
          })
        ).status,
      ).toBe(200);
      const selected = await registry.fetch(`${url}/moving`, { headers });
      expect(await selected.json()).toMatchObject({ name, version });
      const head = await registry.fetch(`${url}/moving`, { method: "HEAD", headers });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect(
      (
        await registry.fetch(tagUrl, {
          method: "DELETE",
          headers: { authorization: "Bearer publish-secret" },
        })
      ).status,
    ).toBe(200);
    expect((await registry.fetch(`${url}/moving`, { headers })).status).toBe(404);
    expect((await registry.fetch(`${url}/1.0.0`, { headers })).status).toBe(200);
    expect((await registry.fetch(`${url}/2.0.0`, { headers })).status).toBe(404);
    expect(
      (await registry.fetch("https://registry.example/@acme/absent/1.0.0", { headers })).status,
    ).toBe(404);
    expect((await registry.fetch(`${url}/1.0.0`)).status).toBe(401);
  });
});

describe("abbreviated installation metadata", () => {
  const mediaType = "application/vnd.npm.install-v1+json";

  it.each([
    ["none", {}, false],
    ["empty", { scripts: { install: "" } }, false],
    ["prepare", { scripts: { prepare: "node prepare.js" } }, false],
    ["preinstall", { scripts: { preinstall: "node setup.js" } }, true],
    ["install", { scripts: { install: "node setup.js" } }, true],
    ["native", { gypfile: true }, true],
    ["declared", { hasInstallScript: true }, true],
  ] as const)("reports install scripts for %s manifests", async (label, fields, expected) => {
    const packageName = `@acme/install-script-${label}`;
    await env.PKGFLARE_DB.prepare("INSERT INTO packages VALUES (?1, ?2, ?2)")
      .bind(packageName, "2026-01-01T00:00:00.000Z")
      .run();
    await env.PKGFLARE_DB.prepare(
      "INSERT INTO versions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
      .bind(
        packageName,
        "1.0.0",
        JSON.stringify({ name: packageName, version: "1.0.0", ...fields }),
        `install-scripts/${label}`,
        `${label}-1.0.0.tgz`,
        "shasum",
        "integrity",
        8,
        "2026-01-01T00:00:00.000Z",
      )
      .run();
    const response = await registry.fetch(
      `https://registry.example/${encodeURIComponent(packageName)}`,
      { headers: { ...headers, accept: mediaType } },
    );
    const body = await response.json<{ versions: Record<string, Record<string, unknown>> }>();
    expect(body.versions["1.0.0"]?.hasInstallScript).toBe(expected);
    expect(body.versions["1.0.0"]).not.toHaveProperty("scripts");
    expect(body.versions["1.0.0"]).not.toHaveProperty("_hasShrinkwrap");
  });

  it("reduces both D1 result data and response size for a large version history", async () => {
    const full = await registry.fetch(url, { headers });
    const fullText = await full.text();
    let databaseBytes = 0;
    const batch = env.PKGFLARE_DB.batch.bind(env.PKGFLARE_DB);
    vi.spyOn(env.PKGFLARE_DB, "batch").mockImplementation(
      async <T>(statements: D1PreparedStatement[]) => {
        const results = await batch<T>(statements);
        databaseBytes += new TextEncoder().encode(
          JSON.stringify(results.map((result) => result.results)),
        ).byteLength;
        return results;
      },
    );
    const response = await readPackage(
      new Request(url, { headers: { accept: mediaType } }),
      {
        env: {
          PKGFLARE_DB: env.PKGFLARE_DB,
          PKGFLARE_BUCKET: env.PKGFLARE_BUCKET,
          PKGFLARE_CONFIG: env.PKGFLARE_CONFIG,
        },
        config: normalizeConfig(JSON.parse(env.PKGFLARE_CONFIG)),
        requestId: "abbreviated-read-test",
      },
      name,
    );
    expect(response.headers.get("content-type")).toBe(`${mediaType}; charset=utf-8`);
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    const body = JSON.parse(text) as {
      versions: Record<string, unknown>;
      name: string;
      modified: string;
    };
    expect(body.name).toBe(name);
    expect(body.modified).toMatch(/^\d{4}-/);
    expect(Object.keys(body.versions)).toHaveLength(1000);
    expect(body.versions["1.0.0"]).toMatchObject({
      dependencies: { "@acme/dependency": "^1.0.0" },
    });
    expect(body.versions["1.0.0"]).not.toHaveProperty("description");
    expect(text.length).toBeLessThan(fullText.length / 3);
    expect(databaseBytes).toBeGreaterThan(0);
    expect(databaseBytes).toBeLessThan(fullText.length / 3);
  });

  it("preserves full metadata by default and for selectors", async () => {
    for (const target of [url, `${url}/1.0.0`, `${url}/latest`]) {
      const response = await registry.fetch(target, {
        headers: { ...headers, ...(target === url ? {} : { accept: mediaType }) },
      });
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = await response.json<{
        versions?: Record<string, { description: string }>;
        description?: string;
      }>();
      expect(target === url ? body.versions?.["1.0.0"]?.description : body.description).toContain(
        "metadata",
      );
      if (target === url) expect(response.headers.get("vary")).toBe("Accept");
    }
    const head = await registry.fetch(url, {
      method: "HEAD",
      headers: { ...headers, accept: mediaType },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(`${mediaType}; charset=utf-8`);
    expect(await head.text()).toBe("");
    expect((await registry.fetch(url, { headers: { accept: mediaType } })).status).toBe(401);
  });

  it("preserves installation fields and JSON types while deriving install-script indicators", async () => {
    const packageName = "@acme/install-fields";
    const manifest = {
      name: packageName,
      version: "1.0.0",
      description: "long description",
      readme: "long readme",
      custom: "not needed for installation",
      dependencies: { "@acme/dep": "^1" },
      optionalDependencies: { "@acme/optional": "^2" },
      devDependencies: { "@acme/dev": "^3" },
      acceptDependencies: { "@acme/dep": "^2" },
      peerDependencies: { "@acme/peer": "^4" },
      peerDependenciesMeta: { "@acme/peer": { optional: true } },
      bundleDependencies: ["@acme/bundled"],
      bundledDependencies: ["@acme/bundled"],
      bin: { tool: "cli.js" },
      directories: { bin: "bin" },
      engines: { node: ">=22" },
      cpu: ["x64", "arm64"],
      os: ["linux", "darwin"],
      libc: ["glibc", "musl"],
      deprecated: "example warning",
      funding: [{ url: "https://example.com/funding" }],
      _hasShrinkwrap: false,
      hasInstallScript: false,
      scripts: { postinstall: "node setup.js" },
      dist: { fileCount: 3, unpackedSize: 120, tarball: "https://example.com/untrusted.tgz" },
    };
    await env.PKGFLARE_DB.prepare("INSERT INTO packages VALUES (?1, ?2, ?2)")
      .bind(packageName, "2026-01-01T00:00:00.000Z")
      .run();
    await env.PKGFLARE_DB.prepare(
      "INSERT INTO versions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
      .bind(
        packageName,
        "1.0.0",
        JSON.stringify(manifest),
        "install-fields/1.0.0",
        "install-fields-1.0.0.tgz",
        "shasum",
        "integrity",
        8,
        "2026-01-01T00:00:00.000Z",
      )
      .run();
    const target = `https://registry.example/${encodeURIComponent(packageName)}`;
    const response = await registry.fetch(target, { headers: { ...headers, accept: mediaType } });
    const body = await response.json<{
      versions: Record<string, Record<string, unknown>>;
      modified: string;
    }>();
    const version = body.versions["1.0.0"];
    expect(version).toEqual({
      name: packageName,
      version: "1.0.0",
      dependencies: manifest.dependencies,
      optionalDependencies: manifest.optionalDependencies,
      devDependencies: manifest.devDependencies,
      acceptDependencies: manifest.acceptDependencies,
      peerDependencies: manifest.peerDependencies,
      peerDependenciesMeta: manifest.peerDependenciesMeta,
      bundleDependencies: manifest.bundleDependencies,
      bundledDependencies: manifest.bundledDependencies,
      bin: manifest.bin,
      directories: manifest.directories,
      engines: manifest.engines,
      cpu: manifest.cpu,
      os: manifest.os,
      libc: manifest.libc,
      deprecated: manifest.deprecated,
      funding: manifest.funding,
      _hasShrinkwrap: false,
      hasInstallScript: true,
      dist: {
        fileCount: 3,
        unpackedSize: 120,
        tarball: "https://registry.example/%40acme/install-fields/-/install-fields-1.0.0.tgz",
        shasum: "shasum",
        integrity: "integrity",
      },
    });
    const tagUrl = `https://registry.example/-/package/${encodeURIComponent(packageName)}/dist-tags/latest`;
    for (const method of ["PUT", "DELETE"]) {
      await env.PKGFLARE_DB.prepare("UPDATE packages SET updated_at = ?2 WHERE name = ?1")
        .bind(packageName, "2026-01-01T00:00:00.000Z")
        .run();
      expect(
        (
          await registry.fetch(tagUrl, {
            method,
            headers: { authorization: "Bearer publish-secret" },
            ...(method === "PUT" ? { body: JSON.stringify("1.0.0") } : {}),
          })
        ).status,
      ).toBe(200);
      const updated = await (
        await registry.fetch(target, { headers: { ...headers, accept: mediaType } })
      ).json<{ modified: string; "dist-tags": Record<string, string> }>();
      expect(updated.modified).not.toBe("2026-01-01T00:00:00.000Z");
      expect(updated["dist-tags"]).toEqual(method === "PUT" ? { latest: "1.0.0" } : {});
      const full = await (
        await registry.fetch(target, { headers })
      ).json<{ time: { modified: string } }>();
      expect(full.time.modified).toBe(updated.modified);
    }
  });
});
