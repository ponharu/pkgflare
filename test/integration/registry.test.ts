import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../../src/config.js";
import { authorize } from "../../src/runtime/auth.js";
import { clearGitHubJwksCache } from "../../src/runtime/github-oidc.js";
import { parsePublishRequest } from "../../src/runtime/publish-stream.js";
import { publishPackage } from "../../src/runtime/publish.js";
import type { RuntimeContext } from "../../src/runtime/types.js";

const authorization = (token: string) => ({ authorization: `Bearer ${token}` });
const registry = exports.default;
const oidcIssuer = "https://token.actions.githubusercontent.com";
const oidcAudience = "pkgflare://registry.example";
let oidcPrivateKey: CryptoKey;
let oidcJwk: JWK;

interface Packument {
  "dist-tags": Record<string, string>;
  versions: Record<string, { dist: { integrity: string; tarball: string } }>;
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    complete = done;
  });
  return { promise, resolve: () => complete?.() };
}

function publishBody(
  name: string,
  version: string,
  bytes: Uint8Array,
  filename = `${name.slice(name.indexOf("/") + 1)}-${version}.tgz`,
): Record<string, unknown> {
  return {
    _id: name,
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: { name, version, description: "test package" },
    },
    _attachments: {
      [filename]: {
        content_type: "application/octet-stream",
        data: Buffer.from(bytes).toString("base64"),
        length: bytes.byteLength,
      },
    },
  };
}

async function publishRaw(name: string, body: string, chunkSize: number): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return registry.fetch(
    new Request(`https://registry.example/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { ...authorization("publish-secret"), "content-type": "application/json" },
      body: stream,
    }),
  );
}

async function publish(
  name: string,
  version: string,
  bytes = new Uint8Array([31, 139, 8, 0]),
  token = "publish-secret",
) {
  return registry.fetch(`https://registry.example/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { ...authorization(token), "content-type": "application/json" },
    body: JSON.stringify(publishBody(name, version, bytes)),
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.PKGFLARE_DB, env.TEST_MIGRATIONS);
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  oidcPrivateKey = keyPair.privateKey;
  oidcJwk = { ...(await exportJWK(keyPair.publicKey)), alg: "RS256", kid: "test-key", use: "sig" };
});

beforeEach(() => {
  clearGitHubJwksCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const objects = await env.PKGFLARE_BUCKET.list();
  if (objects.objects.length > 0)
    await env.PKGFLARE_BUCKET.delete(objects.objects.map((object) => object.key));
});

interface OidcClaims {
  repository_id?: string;
  repository_owner_id?: string;
  ref?: string;
  workflow_ref?: string;
  job_workflow_ref?: string;
  event_name?: string;
  issuer?: string;
  audience?: string;
  expiresAt?: number;
}

async function oidcToken(
  claims: OidcClaims = {},
  privateKey: CryptoKey = oidcPrivateKey,
  kid = "test-key",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repository_id: claims.repository_id ?? "123456",
    repository_owner_id: claims.repository_owner_id ?? "654321",
    ref: claims.ref ?? "refs/heads/main",
    workflow_ref:
      claims.workflow_ref ?? "acme/example/.github/workflows/publish.yml@refs/heads/main",
    ...(claims.job_workflow_ref === undefined ? {} : { job_workflow_ref: claims.job_workflow_ref }),
    event_name: claims.event_name ?? "workflow_dispatch",
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(claims.issuer ?? oidcIssuer)
    .setAudience(claims.audience ?? oidcAudience)
    .setSubject("repo:acme/example:ref:refs/heads/main")
    .setJti(`test-${crypto.randomUUID()}`)
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(claims.expiresAt ?? now + 300)
    .sign(privateKey);
}

function mockGithubJwks(jwk: JWK = oidcJwk): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      }),
  );
}

function oidcContext(): RuntimeContext {
  return {
    requestId: "oidc-test",
    config: normalizeConfig(JSON.parse(env.PKGFLARE_CONFIG) as unknown),
    env: env as unknown as RuntimeContext["env"],
  };
}

async function oidcDecision(
  token: string,
  permission: "read" | "publish" = "publish",
  packageName = "@acme/oidc-package",
): Promise<Response | null> {
  return authorize(
    new Request("https://registry.example/-/ping", {
      headers: authorization(token),
    }),
    oidcContext(),
    permission,
    packageName,
  );
}

describe("registry authentication", () => {
  it("rejects missing credentials without disclosing configuration", async () => {
    const response = await registry.fetch("https://registry.example/@acme%2Fexample");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(await response.json()).toEqual({
      error: "unauthorized",
      reason: "authentication required",
    });
  });

  it("allows publish tokens to read and prevents read tokens from publishing", async () => {
    const denied = await registry.fetch("https://registry.example/@acme%2Fdenied", {
      method: "PUT",
      headers: { ...authorization("read-secret"), "content-type": "application/json" },
      body: JSON.stringify(publishBody("@acme/denied", "1.0.0", new Uint8Array([1]))),
    });
    expect(denied.status).toBe(403);

    const ping = await registry.fetch("https://registry.example/-/ping", {
      headers: authorization("publish-secret"),
    });
    expect(ping.status).toBe(200);

    const rotated = await registry.fetch("https://registry.example/-/ping", {
      headers: authorization("new-read-secret"),
    });
    expect(rotated.status).toBe(200);
  });

  it("keeps old and new tokens active during overlap and revokes the removed binding", async () => {
    const rotatingContext = {
      requestId: "rotation-test",
      config: {
        name: "test-registry",
        scopes: ["@acme"],
        auth: {
          provider: "secrets",
          tokens: [
            { binding: "NEW_READ_TOKEN", permissions: ["read"] },
            { binding: "MISSING_TOKEN", permissions: ["read"] },
          ],
        },
      },
      env,
    } as unknown as RuntimeContext;
    const oldToken = new Request("https://registry.example/-/ping", {
      headers: authorization("read-secret"),
    });
    const newToken = new Request("https://registry.example/-/ping", {
      headers: authorization("new-read-secret"),
    });
    expect((await authorize(oldToken, rotatingContext, "read"))?.status).toBe(403);
    expect(await authorize(newToken, rotatingContext, "read")).toBeNull();
  });
});

describe("GitHub Actions OIDC authentication", () => {
  it("authenticates in the Worker runtime without following JWKS redirects", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.redirect === "error") {
        throw new TypeError("the Worker runtime does not implement redirect:error");
      }
      if (init?.redirect !== "manual") throw new Error("JWKS redirects must not be followed");
      return new Response(JSON.stringify({ keys: [oidcJwk] }));
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await oidcDecision(await oidcToken())).toBeNull();

    clearGitHubJwksCache();
    request.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/untrusted-jwks" },
      }),
    );
    expect((await oidcDecision(await oidcToken()))?.status).toBe(503);
    expect(log.mock.calls.flat().join(" ")).not.toContain("example.com");
  });

  it("accepts a valid signed token and rejects trust-claim mismatches", async () => {
    mockGithubJwks();
    expect(await oidcDecision(await oidcToken())).toBeNull();

    const invalidClaims: OidcClaims[] = [
      { issuer: "https://example.com" },
      { audience: "pkgflare://other" },
      { expiresAt: Math.floor(Date.now() / 1000) - 60 },
      { repository_id: "999999" },
      { repository_owner_id: "999999" },
      { ref: "refs/heads/feature" },
      { workflow_ref: "acme/example/.github/workflows/other.yml@refs/heads/main" },
    ];
    for (const claims of invalidClaims) {
      expect((await oidcDecision(await oidcToken(claims)))?.status).toBe(403);
    }

    const otherKey = await generateKeyPair("RS256");
    expect((await oidcDecision(await oidcToken({}, otherKey.privateKey)))?.status).toBe(403);
  });

  it("distinguishes normal and reusable workflows and rejects pull-request contexts", async () => {
    mockGithubJwks();
    const unexpectedReusable = await oidcToken({
      job_workflow_ref: "acme/workflows/.github/workflows/npm-publish.yml@refs/heads/main",
    });
    expect((await oidcDecision(unexpectedReusable))?.status).toBe(403);

    const reusable = await oidcToken({
      repository_id: "333333",
      workflow_ref: "acme/caller/.github/workflows/release.yml@refs/heads/main",
      job_workflow_ref:
        "acme/workflows/.github/workflows/npm-publish.yml@0123456789abcdef0123456789abcdef01234567",
    });
    expect(await oidcDecision(reusable, "publish", "@acme/reusable-package")).toBeNull();

    expect((await oidcDecision(await oidcToken({ event_name: "pull_request" })))?.status).toBe(403);
    expect((await oidcDecision(await oidcToken({ event_name: "merge_group" })))?.status).toBe(403);
  });

  it("prevents permission escalation and access to another package", async () => {
    mockGithubJwks();
    const readOnly = await oidcToken({
      repository_id: "222222",
      workflow_ref: "acme/reader/.github/workflows/test.yml@refs/heads/main",
    });
    expect(await oidcDecision(readOnly, "read", "@acme/read-only")).toBeNull();
    expect((await oidcDecision(readOnly, "publish", "@acme/read-only"))?.status).toBe(403);
    expect((await oidcDecision(readOnly, "read", "@acme/oidc-package"))?.status).toBe(403);
  });

  it("uses the same package grant for publish, metadata, tarball, and dist-tags", async () => {
    mockGithubJwks();
    const token = await oidcToken();
    const packageName = "@acme/oidc-package";
    expect((await publish(packageName, "1.0.0", new Uint8Array([1, 2, 3]), token)).status).toBe(
      201,
    );

    const metadata = await registry.fetch(
      `https://registry.example/${encodeURIComponent(packageName)}`,
      { headers: authorization(token) },
    );
    expect(metadata.status).toBe(200);
    const packument = await metadata.json<Packument>();
    const tarballUrl = packument.versions["1.0.0"]?.dist.tarball;
    expect(tarballUrl).toBeDefined();
    if (tarballUrl === undefined) throw new Error("OIDC package tarball URL is missing");
    expect((await registry.fetch(tarballUrl, { headers: authorization(token) })).status).toBe(200);

    const tagsUrl = `https://registry.example/-/package/${encodeURIComponent(packageName)}/dist-tags/latest`;
    expect(
      (
        await registry.fetch(tagsUrl, {
          method: "PUT",
          headers: { ...authorization(token), "content-type": "application/json" },
          body: JSON.stringify("1.0.0"),
        })
      ).status,
    ).toBe(200);

    const otherPackage = "@acme/not-authorized";
    expect((await publish(otherPackage, "1.0.0", new Uint8Array([4]))).status).toBe(201);
    expect(
      (
        await registry.fetch(`https://registry.example/${encodeURIComponent(otherPackage)}`, {
          headers: authorization(token),
        })
      ).status,
    ).toBe(403);
  });

  it("caches keys, refreshes an unknown key after cooldown, and fails closed", async () => {
    const secondKey = await generateKeyPair("RS256", { extractable: true });
    const secondJwk = {
      ...(await exportJWK(secondKey.publicKey)),
      alg: "RS256",
      kid: "rotated-key",
      use: "sig",
    };
    let currentJwk = oidcJwk;
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ keys: [currentJwk] })));
    expect(await oidcDecision(await oidcToken())).toBeNull();
    expect(await oidcDecision(await oidcToken())).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);

    const rotatedToken = await oidcToken({}, secondKey.privateKey, "rotated-key");
    currentJwk = secondJwk;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    expect(await oidcDecision(rotatedToken)).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);

    clearGitHubJwksCache();
    request.mockImplementation(async () => new Response(null, { status: 503 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await oidcDecision(await oidcToken()))?.status).toBe(503);
    expect(log.mock.calls.flat().join(" ")).not.toContain("eyJ");
  });

  it("rejects an oversized JWKS response without reading it unbounded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ keys: [oidcJwk], padding: "x".repeat(64 * 1024) })),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await oidcDecision(await oidcToken()))?.status).toBe(503);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        level: "error",
        requestId: "oidc-test",
        operation: "github_oidc_jwks",
        errorType: "GitHubOidcUnavailableError",
      }),
    );
  });
});

describe("publish and install protocol", () => {
  it("publishes immutable metadata and streams its tarball", async () => {
    const bytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]);
    const published = await publish("@acme/example", "1.0.0", bytes);
    expect(published.status).toBe(201);

    const metadata = await registry.fetch("https://registry.example/@acme%2Fexample", {
      headers: authorization("read-secret"),
    });
    expect(metadata.status).toBe(200);
    const packument = await metadata.json<Packument>();
    const manifest = packument.versions["1.0.0"];
    expect(manifest).toBeDefined();
    if (manifest === undefined) throw new Error("published manifest is missing");
    expect(packument["dist-tags"].latest).toBe("1.0.0");
    expect(manifest.dist.integrity).toMatch(/^sha512-/);
    expect(manifest.dist.tarball).toBe(
      "https://registry.example/%40acme/example/-/example-1.0.0.tgz",
    );

    const tarball = await registry.fetch(manifest.dist.tarball, {
      headers: authorization("read-secret"),
    });
    expect(tarball.status).toBe(200);
    expect(new Uint8Array(await tarball.arrayBuffer())).toEqual(bytes);
    expect(tarball.headers.get("cache-control")).toContain("immutable");

    const partial = await registry.fetch(manifest.dist.tarball, {
      headers: { ...authorization("read-secret"), range: "bytes=2-4" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 2-4/${String(bytes.byteLength)}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.slice(2, 5));

    const selected = await registry.fetch("https://registry.example/@acme%2Fexample/latest", {
      headers: authorization("read-secret"),
    });
    expect(selected.status).toBe(200);
    expect((await selected.json<{ version: string }>()).version).toBe("1.0.0");
  });

  it("rejects a second publish of the same version", async () => {
    expect((await publish("@acme/immutable", "1.0.0", new Uint8Array([1]))).status).toBe(201);
    const repeated = await publish("@acme/immutable", "1.0.0", new Uint8Array([2]));
    expect(repeated.status).toBe(409);
  });

  it("commits exactly one object when the same version is published concurrently", async () => {
    const name = "@acme/concurrent";
    const [first, second] = await Promise.all([
      publish(name, "1.0.0", new Uint8Array([1])),
      publish(name, "1.0.0", new Uint8Array([2])),
    ]);
    expect(new Set([first.status, second.status])).toEqual(new Set([201, 409]));
    const objects = await env.PKGFLARE_BUCKET.list({
      prefix: `packages/${encodeURIComponent(name)}/`,
    });
    expect(objects.objects).toHaveLength(1);
  });

  it("keeps earlier versions while advancing a dist-tag", async () => {
    expect((await publish("@acme/multiple", "1.0.0", new Uint8Array([1]))).status).toBe(201);
    expect((await publish("@acme/multiple", "1.1.0", new Uint8Array([2]))).status).toBe(201);
    const response = await registry.fetch("https://registry.example/@acme%2Fmultiple", {
      headers: authorization("read-secret"),
    });
    const packument = await response.json<Packument>();
    expect(Object.keys(packument.versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(packument["dist-tags"].latest).toBe("1.1.0");
  });

  it("does not expose partial metadata while a publish request is still streaming", async () => {
    const name = "@acme/snapshot";
    expect((await publish(name, "1.0.0", new Uint8Array([1]))).status).toBe(201);

    const encoded = new TextEncoder().encode(
      JSON.stringify(publishBody(name, "2.0.0", new Uint8Array([2]))),
    );
    const gate = signal();
    const blocked = signal();
    let part = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (part === 0) {
          part += 1;
          controller.enqueue(encoded.slice(0, Math.floor(encoded.byteLength / 2)));
          return;
        }
        if (part === 1) {
          part += 1;
          blocked.resolve();
          await gate.promise;
          controller.enqueue(encoded.slice(Math.floor(encoded.byteLength / 2)));
          return;
        }
        controller.close();
      },
    });
    const publishing = registry.fetch(
      new Request(`https://registry.example/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { ...authorization("publish-secret"), "content-type": "application/json" },
        body,
      }),
    );
    await blocked.promise;

    const during = await registry.fetch(`https://registry.example/${encodeURIComponent(name)}`, {
      headers: authorization("read-secret"),
    });
    const duringPackument = await during.json<Packument>();
    expect(duringPackument["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(Object.keys(duringPackument.versions)).toEqual(["1.0.0"]);

    gate.resolve();
    expect((await publishing).status).toBe(201);
    const after = await registry.fetch(`https://registry.example/${encodeURIComponent(name)}`, {
      headers: authorization("read-secret"),
    });
    const afterPackument = await after.json<Packument>();
    expect(afterPackument["dist-tags"]).toEqual({ latest: "2.0.0" });
    expect(Object.keys(afterPackument.versions)).toEqual(["1.0.0", "2.0.0"]);
  });

  it("promotes and rolls back versions through npm-compatible dist-tag endpoints", async () => {
    expect((await publish("@acme/tags", "1.0.0", new Uint8Array([1]))).status).toBe(201);
    expect((await publish("@acme/tags", "2.0.0", new Uint8Array([2]))).status).toBe(201);

    const route = "https://registry.example/-/package/@acme%2Ftags/dist-tags";
    const promote = await registry.fetch(`${route}/next`, {
      method: "PUT",
      headers: { ...authorization("publish-secret"), "content-type": "application/json" },
      body: JSON.stringify("2.0.0"),
    });
    expect(promote.status).toBe(200);

    const rollback = await registry.fetch(`${route}/latest`, {
      method: "PUT",
      headers: { ...authorization("publish-secret"), "content-type": "application/json" },
      body: JSON.stringify("1.0.0"),
    });
    expect(rollback.status).toBe(200);

    const tags = await registry.fetch(route, { headers: authorization("read-secret") });
    expect(await tags.json()).toEqual({ latest: "1.0.0", next: "2.0.0" });

    const removed = await registry.fetch(`${route}/next`, {
      method: "DELETE",
      headers: authorization("publish-secret"),
    });
    expect(removed.status).toBe(200);
    expect(
      await (await registry.fetch(route, { headers: authorization("read-secret") })).json(),
    ).toEqual({
      latest: "1.0.0",
    });

    const oversized = await registry.fetch(`${route}/large`, {
      method: "PUT",
      headers: { ...authorization("publish-secret"), "content-type": "application/json" },
      body: JSON.stringify("1".repeat(300)),
    });
    expect(oversized.status).toBe(413);

    const semverTag = await registry.fetch(`${route}/1.0.0`, {
      method: "PUT",
      headers: { ...authorization("publish-secret"), "content-type": "application/json" },
      body: JSON.stringify("1.0.0"),
    });
    expect(semverTag.status).toBe(400);
  });

  it("streams property-order-independent and escaped attachment data across chunk boundaries", async () => {
    for (const chunkSize of [1, 2, 3, 7, 64]) {
      const name = `@acme/chunk-${String(chunkSize)}`;
      const body = `{"_attachments":{"chunk-${String(chunkSize)}-1.0.0.tgz":{"data":"\\u0041Q==","length":1,"content_type":"application/octet-stream"}},"versions":{"1.0.0":{"name":${JSON.stringify(name)},"version":"1.0.0"}},"dist-tags":{"latest":"1.0.0"},"name":${JSON.stringify(name)},"_id":${JSON.stringify(name)}}`;
      const response = await publishRaw(name, body, chunkSize);
      expect(response.status).toBe(201);
    }
  });

  it("rejects duplicate keys, excessive nesting, oversized metadata, and non-canonical base64", async () => {
    const duplicateName = "@acme/duplicate-json";
    const duplicateBody = JSON.stringify(
      publishBody(duplicateName, "1.0.0", new Uint8Array([1])),
    ).replace(`"name":"${duplicateName}"`, `"name":"${duplicateName}","name":"${duplicateName}"`);
    expect((await publishRaw(duplicateName, duplicateBody, 11)).status).toBe(400);

    const duplicateDataName = "@acme/duplicate-data";
    const duplicateDataBody = JSON.stringify(
      publishBody(duplicateDataName, "1.0.0", new Uint8Array([1])),
    ).replace('"data":"AQ=="', '"data":"AQ==","data":"AQ=="');
    expect((await publishRaw(duplicateDataName, duplicateDataBody, 7)).status).toBe(400);

    const depthName = "@acme/depth";
    const normal = JSON.stringify(publishBody(depthName, "1.0.0", new Uint8Array([1])));
    const depthBody = normal.replace("{", `{"deep":${"[".repeat(129)}0${"]".repeat(129)},`);
    expect((await publishRaw(depthName, depthBody, 256)).status).toBe(400);

    const metadataName = "@acme/metadata-limit";
    const metadataBody = JSON.stringify({
      ...publishBody(metadataName, "1.0.0", new Uint8Array([1])),
      readme: "x".repeat(1024 * 1024),
    });
    expect((await publishRaw(metadataName, metadataBody, 4096)).status).toBe(413);

    const base64Name = "@acme/noncanonical";
    const base64Body = JSON.stringify(
      publishBody(base64Name, "1.0.0", new Uint8Array([1])),
    ).replace('"data":"AQ=="', '"data":"AR=="');
    expect((await publishRaw(base64Name, base64Body, 5)).status).toBe(400);
  });

  it("uploads more than one R2 part without buffering the tarball", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 3);
    bytes.fill(42);
    const started = performance.now();
    const response = await publish("@acme/multipart", "1.0.0", bytes);
    expect(response.status).toBe(201);
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("aborts an R2 multipart upload when the request stream disconnects", async () => {
    let aborted = false;
    const upload = {
      key: "attempt.tgz",
      uploadId: "upload-id",
      uploadPart: async () => ({ partNumber: 1, etag: "etag" }),
      abort: async () => {
        aborted = true;
      },
      complete: async () => ({ size: 0 }) as R2Object,
    } as R2MultipartUpload;
    const bucket = {
      createMultipartUpload: async () => upload,
    } as unknown as R2Bucket;
    const prefix = new TextEncoder().encode('{"_attachments":{"x.tgz":{"data":"AAAA');
    let read = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!read) {
          read = true;
          controller.enqueue(prefix);
          return;
        }
        controller.error(new Error("client disconnected"));
      },
    });
    const request = new Request("https://registry.example/%40acme%2Fdisconnect", {
      method: "PUT",
      body,
    });
    await expect(parsePublishRequest(request, bucket, "@acme/disconnect")).rejects.toThrow(
      "client disconnected",
    );
    expect(aborted).toBe(true);
  });

  it("stops consuming request chunks while an R2 part is under backpressure", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes.fill(7);
    const encoded = new TextEncoder().encode(
      JSON.stringify(publishBody("@acme/backpressure", "1.0.0", bytes)),
    );
    const uploadStarted = signal();
    const releaseUpload = signal();
    let pulls = 0;
    const upload = {
      key: "attempt.tgz",
      uploadId: "upload-id",
      async uploadPart(partNumber: number) {
        if (partNumber === 1) {
          uploadStarted.resolve();
          await releaseUpload.promise;
        }
        return { partNumber, etag: `etag-${String(partNumber)}` };
      },
      abort: async () => undefined,
      complete: async () => ({ size: bytes.byteLength }) as R2Object,
    } as R2MultipartUpload;
    const bucket = {
      createMultipartUpload: async () => upload,
    } as unknown as R2Bucket;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (offset === encoded.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 64 * 1024, encoded.byteLength);
        controller.enqueue(encoded.slice(offset, end));
        offset = end;
      },
    });
    const parsing = parsePublishRequest(
      new Request("https://registry.example/%40acme%2Fbackpressure", {
        method: "PUT",
        body,
      }),
      bucket,
      "@acme/backpressure",
    );
    await uploadStarted.promise;
    const pullsWhileBlocked = pulls;
    await Promise.resolve();
    await Promise.resolve();
    expect(pulls).toBeLessThanOrEqual(pullsWhileBlocked + 1);
    releaseUpload.resolve();
    const parsed = await parsing;
    expect(parsed.tarball.length).toBe(bytes.byteLength);
    await parsed.tarball.abort();
  });

  it("retains an unreachable object after an uncertain D1 failure and allows a retry", async () => {
    let attempts = 0;
    let batchCalls = 0;
    let deleted = false;
    const bucket = {
      createMultipartUpload: async (key: string) => ({
        key,
        uploadId: `upload-${String(++attempts)}`,
        uploadPart: async (partNumber: number) => ({ partNumber, etag: "etag" }),
        abort: async () => undefined,
        complete: async () => ({ size: 1 }) as R2Object,
      }),
      delete: async () => {
        deleted = true;
      },
    } as unknown as R2Bucket;
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => null,
          run: async () => ({ meta: { changes: 1 } }),
          query,
        }),
      }),
      batch: async () => {
        batchCalls += 1;
        if (batchCalls === 1) throw new Error("uncertain D1 response");
        return [];
      },
    } as unknown as D1Database;
    const context = {
      requestId: "request-id",
      config: {
        name: "registry",
        scopes: ["@acme"],
        auth: { provider: "secrets", tokens: [] },
      },
      env: { PKGFLARE_DB: database, PKGFLARE_BUCKET: bucket, PKGFLARE_CONFIG: "{}" },
    } as unknown as RuntimeContext;
    const makeRequest = () =>
      new Request("https://registry.example/%40acme%2Fretry", {
        method: "PUT",
        body: JSON.stringify(publishBody("@acme/retry", "1.0.0", new Uint8Array([1]))),
      });

    expect((await publishPackage(makeRequest(), context, "@acme/retry")).status).toBe(503);
    expect(deleted).toBe(false);
    expect((await publishPackage(makeRequest(), context, "@acme/retry")).status).toBe(201);
  });

  it("rejects packages outside configured scopes and malformed attachments", async () => {
    expect((await publish("@other/example", "1.0.0")).status).toBe(403);
    const body = publishBody("@acme/broken", "1.0.0", new Uint8Array([1]));
    const attachments = body._attachments as Record<string, { data: string }>;
    const attachment = attachments["broken-1.0.0.tgz"];
    if (attachment === undefined) throw new Error("test attachment is missing");
    attachment.data = "not base64";
    const response = await registry.fetch("https://registry.example/@acme%2Fbroken", {
      method: "PUT",
      headers: { ...authorization("publish-secret"), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);

    const primitive = await registry.fetch("https://registry.example/@acme%2Fprimitive", {
      method: "PUT",
      headers: { ...authorization("publish-secret"), "content-type": "application/json" },
      body: "null",
    });
    expect(primitive.status).toBe(400);
    expect(primitive.headers.get("x-pkgflare-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
