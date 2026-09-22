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
