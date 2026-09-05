import { describe, expect, it } from "vitest";
import {
  isAllowedPackage,
  isValidDistTag,
  parseDistTagRoute,
  parsePackageRoute,
} from "../../src/runtime/package-name.js";

describe("package routes", () => {
  it.each([
    ["/@acme%2Fexample", "@acme/example", []],
    ["/@acme/example", "@acme/example", []],
    ["/@acme%2Fexample/1.2.3", "@acme/example", ["1.2.3"]],
    ["/@acme/example/-/example-1.2.3.tgz", "@acme/example", ["-", "example-1.2.3.tgz"]],
  ])("parses npm package paths", (path, packageName, remainder) => {
    expect(parsePackageRoute(path)).toEqual({ packageName, remainder });
  });

  it.each(["/example", "/@acme", "/@acme/../secret", "/%not-encoded"])(
    "rejects invalid paths",
    (path) => expect(parsePackageRoute(path)).toBeNull(),
  );

  it("matches only configured scopes", () => {
    expect(isAllowedPackage("@acme/example", ["@acme"])).toBe(true);
    expect(isAllowedPackage("@other/example", ["@acme"])).toBe(false);
  });

  it.each(["example-", "example_", "_example", "-example"])(
    "accepts npm-compatible scoped package segment %s",
    (name) => expect(parsePackageRoute(`/@acme/${name}`)?.packageName).toBe(`@acme/${name}`),
  );

  it("parses npm dist-tag routes", () => {
    expect(parseDistTagRoute("/-/package/@acme%2Fexample/dist-tags")).toEqual({
      packageName: "@acme/example",
    });
    expect(parseDistTagRoute("/-/package/@acme%2Fexample/dist-tags/latest")).toEqual({
      packageName: "@acme/example",
      tag: "latest",
    });
  });

  it("enforces npm package length and prevents semver-like dist-tags", () => {
    const maximumName = `@a/${"b".repeat(211)}`;
    expect(maximumName).toHaveLength(214);
    expect(parsePackageRoute(`/${maximumName}`)?.packageName).toBe(maximumName);
    expect(parsePackageRoute(`/@a/${"b".repeat(212)}`)).toBeNull();
    expect(isValidDistTag("latest")).toBe(true);
    expect(isValidDistTag("1.0.0")).toBe(false);
    expect(isValidDistTag("v1")).toBe(false);
  });
});
