import { describe, expect, it } from "vitest";
import { installMediaType, prefersInstallMetadata } from "../../src/runtime/install-metadata.js";

describe("installation metadata negotiation", () => {
  it.each([
    [null, false],
    ["", false],
    ["*/*", false],
    ["application/*", false],
    ["application/json", false],
    ["text/html", false],
    [installMediaType, true],
    [installMediaType.toUpperCase(), true],
    [`${installMediaType}; q=1.0, application/json; q=0.8, */*`, true],
    [`${installMediaType};q=0.8, application/json;q=0.9`, false],
    [`${installMediaType};q=0.8, application/json;q=0.2, */*;q=1`, true],
    [`${installMediaType};q=0.8, */*;q=1`, false],
    [`${installMediaType};q=0, */*`, false],
    [`application/*;q=0, ${installMediaType}`, true],
    [`text/html;q=1, ${installMediaType};q=0.5`, true],
    [`${installMediaType};q=1, application/json;q=1`, true],
    [`${installMediaType};q=0, application/json;q=0`, false],
    [`${installMediaType};q=invalid`, false],
    [`${installMediaType};q=1.1`, false],
    [`${installMediaType};q=0.9999`, false],
    [`${installMediaType};q=0;q=1`, false],
  ])("negotiates %s as abbreviated=%s", (accept, abbreviated) => {
    expect(prefersInstallMetadata(accept)).toBe(abbreviated);
  });
});
