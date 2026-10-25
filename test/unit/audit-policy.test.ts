import { describe, expect, it } from "vitest";

import { verifyNpmAudit } from "../../scripts/audit-policy";

const exception = {
  id: "GHSA-4qv8-2p9j-2685",
  name: "undici",
  versions: ["7.29.1"],
  expires: "2026-11-09",
  reason: "Upstream pins the affected version",
};
const advisory = { name: "undici", url: `https://github.com/advisories/${exception.id}` };

describe("installed dependency audit policy", () => {
  it("allows only an approved advisory and its affected parents", () => {
    expect(check(report([advisory]))).toBe(1);
  });

  it("rejects a new advisory alongside an approved advisory", () => {
    expect(() =>
      check(report([advisory, { ...advisory, url: "https://github.com/advisories/GHSA-new" }])),
    ).toThrow("Unapproved npm audit advisory");
  });

  it("rejects another installed version or another affected copy", () => {
    expect(() => check(report([advisory]), () => "7.30.0")).toThrow(
      "Unapproved npm audit advisory",
    );
    const value = report([advisory]);
    value.vulnerabilities.undici.nodes.push("node_modules/other/node_modules/undici");
    expect(() => check(value, (node) => (node.includes("other") ? "7.30.0" : "7.29.1"))).toThrow(
      "Unapproved npm audit advisory",
    );
  });

  it("rejects the same advisory attributed to another package", () => {
    expect(() => check(report([{ ...advisory, name: "other" }]))).toThrow(
      "Invalid npm audit advisory",
    );
  });

  it("rejects expired exceptions even when no vulnerabilities are reported", () => {
    expect(() =>
      verifyNpmAudit(
        { auditReportVersion: 2, vulnerabilities: {} },
        () => "7.29.1",
        [exception],
        "2026-11-09",
      ),
    ).toThrow("expired on 2026-11-09");
  });

  it("accepts a clean report without consuming an exception", () => {
    expect(check({ auditReportVersion: 2, vulnerabilities: {} })).toBe(0);
  });

  it("rejects malformed reports and missing or circular dependency references", () => {
    for (const value of [
      null,
      {},
      { auditReportVersion: 2, vulnerabilities: [] },
      report([]),
      report(["missing"]),
      report(["wrangler"]),
    ]) {
      expect(() => check(value)).toThrow();
    }
  });
});

function check(value: unknown, version = (_node: string) => "7.29.1"): number {
  return verifyNpmAudit(value, version, [exception], "2026-10-25");
}

function report(via: unknown[]) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      undici: { name: "undici", via, nodes: ["node_modules/undici"] },
      miniflare: { name: "miniflare", via: ["undici"], nodes: ["node_modules/miniflare"] },
      wrangler: { name: "wrangler", via: ["miniflare"], nodes: ["node_modules/wrangler"] },
    },
  };
}
