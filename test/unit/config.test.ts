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

  it.each([
    [{ ...validConfig, name: "Invalid_Name" }, "name"],
    [{ ...validConfig, name: `a${"b".repeat(54)}` }, "name"],
    [{ ...validConfig, accountId: "not-an-account" }, "accountId"],
    [{ ...validConfig, scopes: [] }, "scope"],
    [{ ...validConfig, scopes: ["acme"] }, "scope"],
    [{ ...validConfig, hostname: "https://packages.example.com" }, "hostname"],
    [{ ...validConfig, auth: { provider: "secrets" as const, tokens: [] } }, "token"],
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
});
