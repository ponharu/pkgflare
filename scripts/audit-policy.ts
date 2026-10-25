import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import policy from "../audit-exceptions.json";

interface AuditException {
  id: string;
  name: string;
  versions: readonly string[];
  expires: string;
  reason: string;
}

export function auditInstalledDependencies(cwd: string): void {
  const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd,
    encoding: "utf8",
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`npm audit failed: ${result.stderr || String(result.status)}`);
  }
  const ignored = verifyNpmAudit(JSON.parse(result.stdout), (node) => {
    if (!node.startsWith("node_modules/") || node.split("/").includes("..")) {
      throw new Error(`Invalid npm audit package path: ${node}`);
    }
    const manifest: unknown = JSON.parse(readFileSync(join(cwd, node, "package.json"), "utf8"));
    if (!isRecord(manifest) || typeof manifest.version !== "string") {
      throw new Error(`Missing installed package version: ${node}`);
    }
    return manifest.version;
  });
  if (result.status === 1 && ignored === 0) {
    throw new Error("npm audit failed without an approved advisory");
  }
  console.info(`Installed dependency audit passed (${ignored} approved advisories)`);
}

export function verifyNpmAudit(
  report: unknown,
  installedVersion: (node: string) => string,
  exceptions: readonly AuditException[] = policy.npm,
  today = new Date().toISOString().slice(0, 10),
): number {
  for (const exception of exceptions) {
    if (today >= exception.expires) {
      throw new Error(`Audit exception ${exception.id} expired on ${exception.expires}`);
    }
  }
  if (!isRecord(report) || report.auditReportVersion !== 2 || !isRecord(report.vulnerabilities)) {
    throw new Error("Invalid npm audit report");
  }
  const vulnerabilities = report.vulnerabilities;
  const visited = new Set<string>();
  const visiting = new Set<string>();
  let ignored = 0;

  function check(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular npm audit dependency: ${name}`);
    const vulnerability = vulnerabilities[name];
    if (
      !isRecord(vulnerability) ||
      vulnerability.name !== name ||
      !Array.isArray(vulnerability.via) ||
      vulnerability.via.length === 0 ||
      !Array.isArray(vulnerability.nodes) ||
      vulnerability.nodes.length === 0
    ) {
      throw new Error(`Invalid npm audit vulnerability: ${name}`);
    }
    visiting.add(name);
    for (const via of vulnerability.via) {
      if (typeof via === "string") {
        check(via);
        continue;
      }
      if (!isRecord(via) || via.name !== name || typeof via.url !== "string") {
        throw new Error(`Invalid npm audit advisory: ${name}`);
      }
      const exception = exceptions.find(
        (entry) => entry.name === name && via.url === `https://github.com/advisories/${entry.id}`,
      );
      if (
        exception === undefined ||
        !vulnerability.nodes.every(
          (node) => typeof node === "string" && exception.versions.includes(installedVersion(node)),
        )
      ) {
        throw new Error(`Unapproved npm audit advisory: ${name} (${via.url})`);
      }
      ignored++;
      console.warn(
        `Audit exception: ${exception.id} (expires ${exception.expires}): ${exception.reason}`,
      );
    }
    visiting.delete(name);
    visited.add(name);
  }

  for (const name of Object.keys(vulnerabilities)) check(name);
  return ignored;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
