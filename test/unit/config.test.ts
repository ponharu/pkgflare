import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../../src/config.js";

const validConfig = {
  name: "acme-registry",
  scopes: ["@acme"],
  auth: {
    provider: "secrets" as const,
    tokens: [
      { binding: "READ_TOKEN", permissions: ["read" as const] },
      { binding: "PUBLISH_TOKEN", permissions: ["publish" as const] },
    ],
  },
};

function normalizeJobWorkflowRef(jobWorkflowRef: string) {
  return normalizeConfig({
    ...validConfig,
    auth: {
      provider: "secrets",
      githubOidc: {
        audience: "pkgflare://registry",
        subjects: [
          {
            repositoryId: "123456",
            repositoryOwnerId: "654321",
            ref: "refs/heads/main",
            workflowRef: "acme/example/.github/workflows/publish.yml@refs/heads/main",
            jobWorkflowRef,
            permissions: ["publish"],
            packages: ["@acme/example"],
          },
        ],
      },
    },
  });
}

describe("normalizeConfig", () => {
  it("normalizes duplicate scopes and permissions", () => {
    const config = normalizeConfig({
      ...validConfig,
      scopes: ["@acme", "@acme", "@example"],
      auth: {
        provider: "secrets",
        tokens: [{ binding: "PUBLISH_TOKEN", permissions: ["publish", "publish"] }],
      },
    });
    expect(config.scopes).toEqual(["@acme", "@example"]);
    expect(config.auth.tokens[0]?.permissions).toEqual(["publish"]);
  });

  it("accepts a 54-character deployment name and an explicit account ID", () => {
    const config = normalizeConfig({
      ...validConfig,
      name: `a${"b".repeat(53)}`,
      accountId: "0123456789abcdef0123456789abcdef",
    });
    expect(config.name).toHaveLength(54);
    expect(config.accountId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("normalizes package-scoped GitHub OIDC trust without requiring a Secret token", () => {
    const config = normalizeConfig({
      ...validConfig,
      auth: {
        provider: "secrets",
        githubOidc: {
          audience: "pkgflare://packages.example.com",
          subjects: [
            {
              repositoryId: "123456",
              repositoryOwnerId: "654321",
              ref: "refs/tags/v*",
              workflowRef: "acme/example/.github/workflows/publish.yml@refs/tags/v*",
              jobWorkflowRef: "acme/workflows/.github/workflows/npm-publish.yml@refs/heads/main",
              permissions: ["publish", "publish"],
              packages: ["@acme/example", "@acme/example"],
            },
          ],
        },
      },
    });
    expect(config.auth.tokens).toEqual([]);
    expect(config.auth.githubOidc?.subjects[0]).toEqual(
      expect.objectContaining({ permissions: ["publish"], packages: ["@acme/example"] }),
    );
  });

  it("accepts a full commit SHA for a reusable workflow", () => {
    const jobWorkflowRef =
      "acme/workflows/.github/workflows/npm-publish.yml@0123456789abcdef0123456789abcdef01234567";
    const config = normalizeJobWorkflowRef(jobWorkflowRef);

    expect(config.auth.githubOidc?.subjects[0]?.jobWorkflowRef).toBe(jobWorkflowRef);
  });

  it.each(["refs/heads/main", "refs/tags/v1.2.3"])(
    "continues to accept a reusable workflow at %s",
    (ref) => {
      const jobWorkflowRef = `acme/workflows/.github/workflows/npm-publish.yml@${ref}`;
      expect(
        normalizeJobWorkflowRef(jobWorkflowRef).auth.githubOidc?.subjects[0]?.jobWorkflowRef,
      ).toBe(jobWorkflowRef);
    },
  );

  it.each(["a".repeat(39), "g".repeat(40)])(
    "rejects an invalid reusable workflow commit SHA: %s",
    (sha) => {
      expect(() =>
        normalizeJobWorkflowRef(`acme/workflows/.github/workflows/npm-publish.yml@${sha}`),
      ).toThrow("full commit SHA");
    },
  );

  it("keeps caller workflowRef restricted to a branch or tag ref", () => {
    expect(() =>
      normalizeConfig({
        ...validConfig,
        auth: {
          provider: "secrets",
          githubOidc: {
            audience: "pkgflare://registry",
            subjects: [
              {
                repositoryId: "123456",
                repositoryOwnerId: "654321",
                ref: "refs/heads/main",
                workflowRef:
                  "acme/example/.github/workflows/publish.yml@0123456789abcdef0123456789abcdef01234567",
                permissions: ["publish"],
                packages: ["@acme/example"],
              },
            ],
          },
        },
      }),
    ).toThrow("workflowRef");
  });

  it.each([
    [{ ...validConfig, name: "Invalid_Name" }, "name"],
    [{ ...validConfig, name: `a${"b".repeat(54)}` }, "name"],
    [{ ...validConfig, accountId: "not-an-account" }, "accountId"],
    [{ ...validConfig, scopes: [] }, "scope"],
    [{ ...validConfig, scopes: ["acme"] }, "scope"],
    [{ ...validConfig, hostname: "https://packages.example.com" }, "hostname"],
    [
      { ...validConfig, auth: { provider: "secrets" as const, tokens: [] } },
      "authentication method",
    ],
  ])("rejects invalid configuration", (config, message) => {
    expect(() => normalizeConfig(config)).toThrow(message);
  });

  it("rejects duplicate and unsafe binding names", () => {
    expect(() =>
      normalizeConfig({
        ...validConfig,
        auth: {
          provider: "secrets",
          tokens: [
            { binding: "TOKEN", permissions: ["read"] },
            { binding: "TOKEN", permissions: ["publish"] },
          ],
        },
      }),
    ).toThrow("duplicate");
    expect(() =>
      normalizeConfig({
        ...validConfig,
        auth: { provider: "secrets", tokens: [{ binding: "bad-name", permissions: ["read"] }] },
      }),
    ).toThrow("binding");
    expect(() =>
      normalizeConfig({
        ...validConfig,
        auth: { provider: "secrets", tokens: [{ binding: "PKGFLARE_DB", permissions: ["read"] }] },
      }),
    ).toThrow("reserved");
  });

  it.each([
    [
      {
        audience: "bad audience",
        subjects: [],
      },
      "audience",
    ],
    [
      {
        audience: "pkgflare://registry",
        subjects: [
          {
            repositoryId: "name",
            repositoryOwnerId: "654321",
            ref: "refs/heads/main",
            workflowRef: "acme/example/.github/workflows/publish.yml@refs/heads/main",
            permissions: ["publish"],
            packages: ["@acme/example"],
          },
        ],
      },
      "repositoryId",
    ],
    [
      {
        audience: "pkgflare://registry",
        subjects: [
          {
            repositoryId: "123456",
            repositoryOwnerId: "654321",
            ref: "refs/pull/1/merge",
            workflowRef: "acme/example/.github/workflows/publish.yml@refs/heads/main",
            permissions: ["publish"],
            packages: ["@acme/example"],
          },
        ],
      },
      "ref",
    ],
    [
      {
        audience: "pkgflare://registry",
        subjects: [
          {
            repositoryId: "123456",
            repositoryOwnerId: "654321",
            ref: "refs/heads/main",
            workflowRef: "acme/example/.github/workflows/publish.yml@refs/heads/main",
            permissions: ["publish"],
            packages: ["@other/example"],
          },
        ],
      },
      "package",
    ],
  ])("rejects unsafe GitHub OIDC configuration", (githubOidc, message) => {
    expect(() =>
      normalizeConfig({ ...validConfig, auth: { ...validConfig.auth, githubOidc } }),
    ).toThrow(message);
  });

  it("rejects an OIDC policy that cannot fit in the Worker configuration binding", () => {
    const subject = {
      repositoryId: "123456",
      repositoryOwnerId: "654321",
      ref: "refs/heads/main",
      workflowRef: "acme/example/.github/workflows/publish.yml@refs/heads/main",
      permissions: ["read"],
      packages: ["@acme/example"],
    };
    expect(() =>
      normalizeConfig({
        ...validConfig,
        auth: {
          ...validConfig.auth,
          githubOidc: {
            audience: "pkgflare://registry",
            subjects: Array.from({ length: 40 }, (_, index) => ({
              ...subject,
              repositoryId: String(100_000 + index),
            })),
          },
        },
      }),
    ).toThrow("5 KiB");
  });
});
