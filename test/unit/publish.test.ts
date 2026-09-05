import { describe, expect, it, vi } from "vitest";
import { reconcileCommit, type ValidatedPublish } from "../../src/runtime/publish.js";
import type { PendingTarball } from "../../src/runtime/publish-stream.js";
import type { RuntimeContext } from "../../src/runtime/types.js";

function scenario(
  committed: { tarball_key: string; shasum: string; integrity: string } | null | Error,
): { context: RuntimeContext; publish: ValidatedPublish; deleted: string[] } {
  const deleted: string[] = [];
  const tarball: PendingTarball = {
    filename: "example-1.0.0.tgz",
    key: "packages/example/attempt.tgz",
    length: 3,
    shasum: "sha1",
    integrity: "sha512-value",
    complete: async () => ({ size: 3 }) as R2Object,
    abort: async () => undefined,
  };
  const database = {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (committed instanceof Error) throw committed;
          return committed;
        },
      }),
    }),
  };
  const bucket = {
    delete: async (key: string) => {
      deleted.push(key);
    },
  };
  const context = {
    requestId: "request-id",
    config: {
      name: "registry",
      scopes: ["@acme"],
      auth: { provider: "secrets", tokens: [] },
    },
    env: { PKGFLARE_DB: database, PKGFLARE_BUCKET: bucket, PKGFLARE_CONFIG: "{}" },
  } as unknown as RuntimeContext;
  return {
    context,
    deleted,
    publish: {
      packageName: "@acme/example",
      version: "1.0.0",
      manifest: { name: "@acme/example", version: "1.0.0" },
      tags: { latest: "1.0.0" },
      filename: tarball.filename,
      tarball,
    },
  };
}

describe("publish commit reconciliation", () => {
  it("recognizes an acknowledged commit after an uncertain D1 response", async () => {
    const { context, publish, deleted } = scenario({
      tarball_key: "packages/example/attempt.tgz",
      shasum: "sha1",
      integrity: "sha512-value",
    });
    expect((await reconcileCommit(context, publish)).status).toBe(201);
    expect(deleted).toEqual([]);
  });

  it("deletes only a confirmed losing object", async () => {
    const { context, publish, deleted } = scenario({
      tarball_key: "packages/example/winner.tgz",
      shasum: "other",
      integrity: "other",
    });
    expect((await reconcileCommit(context, publish)).status).toBe(409);
    expect(deleted).toEqual(["packages/example/attempt.tgz"]);
  });

  it("retains an orphan when the outcome is absent or cannot be read", async () => {
    const absent = scenario(null);
    expect((await reconcileCommit(absent.context, absent.publish)).status).toBe(503);
    expect(absent.deleted).toEqual([]);

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unknown = scenario(new Error("private request data must not be logged"));
    expect((await reconcileCommit(unknown.context, unknown.publish)).status).toBe(503);
    expect(unknown.deleted).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        level: "error",
        requestId: "request-id",
        operation: "publish_d1_reconcile",
        errorType: "Error",
      }),
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain("private request data");
    log.mockRestore();
  });
});
