import { spawnSync } from "node:child_process";

// No patched release exists. Only trusted release configuration patterns reach braces.
// Reassess this exception before its expiry; all other advisories remain blocking.
const exceptions = [{ id: "GHSA-vfj7-8cjw-p6xm", expires: "2026-11-09" }];

const today = new Date().toISOString().slice(0, 10);
for (const exception of exceptions) {
  if (today >= exception.expires) {
    throw new Error(`Audit exception ${exception.id} expired on ${exception.expires}`);
  }
  console.warn(`Audit exception: ${exception.id} (expires ${exception.expires})`);
}

const result = spawnSync(
  process.execPath,
  ["audit", ...exceptions.flatMap((exception) => ["--ignore", exception.id])],
  { stdio: "inherit", shell: false },
);
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
