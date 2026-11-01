import { readFile, writeFile } from "node:fs/promises";

const source = new URL("../docs/audit-exceptions.source.json", import.meta.url);
const snapshot = new URL("../audit-exceptions.json", import.meta.url);
const generated = await readFile(source, "utf8");
JSON.parse(generated);

if (process.argv.includes("--check")) {
  if ((await readFile(snapshot, "utf8")) !== generated) {
    throw new Error("Audit policy snapshot is stale; run bun run audit:generate");
  }
} else {
  await writeFile(snapshot, generated);
}
