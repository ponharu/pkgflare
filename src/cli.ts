import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { deploy } from "./cli/deploy.js";

function valueAfter(arguments_: readonly string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function help(): void {
  process.stdout.write(
    `pkgflare\n\nUsage:\n  pkgflare deploy [--config <path>] [--secrets-file <path>] [--adopt-existing]\n  pkgflare init\n  pkgflare token generate\n`,
  );
}

async function init(cwd: string): Promise<void> {
  const path = resolve(cwd, "pkgflare.config.ts");
  const file = await open(path, "wx").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("pkgflare.config.ts already exists");
    throw error;
  });
  await file.writeFile(
    `import { defineConfig } from "@ponharu/pkgflare";\n\nexport default defineConfig({\n  name: "acme-registry",\n  scopes: ["@acme"],\n  auth: {\n    provider: "secrets",\n    tokens: [\n      { binding: "PKGFLARE_READ_TOKEN", permissions: ["read"] },\n      { binding: "PKGFLARE_PUBLISH_TOKEN", permissions: ["publish"] },\n    ],\n  },\n});\n`,
  );
  await file.close();
  process.stdout.write("Created pkgflare.config.ts\n");
}

async function main(arguments_: string[]): Promise<void> {
  const [command, subcommand] = arguments_;
  if (command === undefined || command === "--help" || command === "-h") {
    help();
    return;
  }
  if (command === "deploy") {
    const configFile = valueAfter(arguments_, "--config");
    const secretsFile = valueAfter(arguments_, "--secrets-file");
    const adoptExisting = arguments_.includes("--adopt-existing");
    const result = await deploy({
      cwd: process.cwd(),
      ...(configFile === undefined ? {} : { configFile }),
      ...(secretsFile === undefined ? {} : { secretsFile }),
      adoptExisting,
    });
    const statePath = relative(process.cwd(), result.stateFile);
    process.stdout.write(`\nDeployment state: ${statePath}\n`);
    if (result.registryUrl !== null) {
      process.stdout.write(`Registry: ${result.registryUrl}\n`);
    }
    process.stdout.write("\nRegister each token secret if it was not supplied during deploy:\n");
    for (const binding of result.secretBindings) {
      process.stdout.write(`  npx wrangler secret put ${binding} --config ${statePath}\n`);
    }
    if (result.registryUrl !== null) {
      const host = new URL(result.registryUrl).host;
      process.stdout.write("\n.npmrc:\n");
      for (const scope of result.scopes) {
        process.stdout.write(`  ${scope}:registry=${result.registryUrl}\n`);
      }
      process.stdout.write(`  //${host}/:_authToken=\${NPM_TOKEN}\n`);
    }
    return;
  }
  if (command === "init") {
    await init(process.cwd());
    return;
  }
  if (command === "token" && subcommand === "generate") {
    let binary = "";
    for (const byte of randomBytes(32)) binary += String.fromCharCode(byte);
    const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    process.stdout.write(`${token}\n`);
    return;
  }
  throw new Error(`unknown command: ${arguments_.join(" ")}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pkgflare: ${message}\n`);
  process.exitCode = 1;
});
