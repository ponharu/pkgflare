import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface RunOptions {
  readonly capture?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface PackageWithBin {
  readonly bin: Record<string, string>;
}

type Client = readonly [name: string, executable: string, prefix: readonly string[]];

const require = createRequire(import.meta.url);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
const pnpmPackagePath = require.resolve("pnpm");
const pnpmPackage = JSON.parse(await readFile(pnpmPackagePath, "utf8")) as PackageWithBin;
const pnpmBin = pnpmPackage.bin.pnpm;
if (pnpmBin === undefined) throw new Error("pnpm package does not declare its executable");
const pnpm = join(dirname(pnpmPackagePath), pnpmBin);
const yarn = require.resolve("yarn/bin/yarn.js");

function run(
  executable: string,
  arguments_: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd ?? repository,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        output += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(output);
      else
        reject(
          new Error(
            `${executable} exited with ${String(code)}${output === "" ? "" : `\n${output}`}`,
          ),
        );
    });
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("failed to allocate a test port");
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
  return address.port;
}

async function writePackage(directory: string, name: string, version = "1.0.0"): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name, version, type: "module", main: "index.js" }, null, 2)}\n`,
  );
  await writeFile(
    join(directory, "index.js"),
    `export const client = ${JSON.stringify(name)};\nexport const version = ${JSON.stringify(version)};\n`,
  );
}

async function waitForRegistry(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/-/ping`, {
        headers: { authorization: "Bearer read-secret" },
      });
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("local registry did not become ready");
}

async function verifyInstalled(directory: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await readFile(join(directory, "node_modules", ...name.split("/"), "index.js"), "utf8");
  }
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pkgflare-clients-"));
let worker: ChildProcess | undefined;
let workerStopping = false;

try {
  const port = await availablePort();
  const registryUrl = `http://127.0.0.1:${port}`;
  const configPath = join(temporaryDirectory, "wrangler.json");
  const config = {
    name: "pkgflare-client-test",
    main: resolve(repository, "dist", "worker.js"),
    compatibility_date: "2026-08-01",
    vars: {
      PKGFLARE_CONFIG: JSON.stringify({
        name: "pkgflare-client-test",
        scopes: ["@acme"],
        auth: {
          provider: "secrets",
          tokens: [
            { binding: "READ_TOKEN", permissions: ["read"] },
            { binding: "PUBLISH_TOKEN", permissions: ["publish"] },
          ],
        },
      }),
      READ_TOKEN: "read-secret",
      PUBLISH_TOKEN: "publish-secret",
    },
    d1_databases: [
      {
        binding: "PKGFLARE_DB",
        database_name: "client-test",
        database_id: "client-test",
        migrations_dir: resolve(repository, "migrations"),
      },
    ],
    r2_buckets: [{ binding: "PKGFLARE_BUCKET", bucket_name: "client-test" }],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await run("node", [
    wrangler,
    "d1",
    "migrations",
    "apply",
    "PKGFLARE_DB",
    "--local",
    "--config",
    configPath,
  ]);

  worker = spawn(
    "node",
    [wrangler, "dev", "--local", "--port", String(port), "--config", configPath],
    {
      cwd: temporaryDirectory,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let workerOutput = "";
  worker.stdout?.setEncoding("utf8");
  worker.stderr?.setEncoding("utf8");
  worker.stdout?.on("data", (chunk: string) => {
    workerOutput += chunk;
  });
  worker.stderr?.on("data", (chunk: string) => {
    workerOutput += chunk;
  });
  worker.once("exit", (code) => {
    if (!workerStopping && code !== null && code !== 0) process.stderr.write(workerOutput);
  });
  await waitForRegistry(registryUrl);

  const npmPackage = join(temporaryDirectory, "npm-package");
  const bunPackage = join(temporaryDirectory, "bun-package");
  await Promise.all([
    writePackage(npmPackage, "@acme/npm-client"),
    writePackage(bunPackage, "@acme/bun-client"),
  ]);
  const npmrc = join(temporaryDirectory, ".npmrc");
  const npmrcContents = `@acme:registry=${registryUrl}\n//127.0.0.1:${String(port)}/:_authToken=\${NPM_TOKEN}\n`;
  await writeFile(npmrc, npmrcContents);
  const publishEnvironment = {
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_TOKEN: "publish-secret",
    npm_config_userconfig: npmrc,
  };

  await run("npm", ["publish", "--registry", registryUrl], {
    cwd: npmPackage,
    env: publishEnvironment,
  });
  await writePackage(npmPackage, "@acme/npm-client", "1.1.0");
  await run("npm", ["publish", "--tag", "next", "--registry", registryUrl], {
    cwd: npmPackage,
    env: publishEnvironment,
  });
  await run("bun", ["publish", "--registry", registryUrl], {
    cwd: bunPackage,
    env: { ...publishEnvironment, NPM_CONFIG_TOKEN: "publish-secret" },
  });
  await run(
    "npm",
    ["dist-tag", "add", "@acme/npm-client@1.1.0", "latest", "--registry", registryUrl],
    { cwd: temporaryDirectory, env: publishEnvironment },
  );
  await run(
    "npm",
    ["dist-tag", "add", "@acme/npm-client@1.0.0", "latest", "--registry", registryUrl],
    { cwd: temporaryDirectory, env: publishEnvironment },
  );
  await run("npm", ["dist-tag", "rm", "@acme/npm-client", "next", "--registry", registryUrl], {
    cwd: temporaryDirectory,
    env: publishEnvironment,
  });
  const readEnvironment = {
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_TOKEN: "read-secret",
    npm_config_userconfig: npmrc,
  };
  const viewedVersion = await run("npm", ["view", "@acme/npm-client", "version", "--json"], {
    cwd: temporaryDirectory,
    env: readEnvironment,
    capture: true,
  });
  if ((JSON.parse(viewedVersion) as unknown) !== "1.0.0") {
    throw new Error("npm view returned the wrong version");
  }

  const packages = ["@acme/npm-client@1.0.0", "@acme/bun-client@1.0.0"];
  const packageNames = packages.map((name) => name.slice(0, name.lastIndexOf("@")));
  const clients: readonly Client[] = [
    ["npm", "npm", ["install"]],
    ["pnpm", "node", [pnpm, "add"]],
    ["Yarn", "node", [yarn, "add", "--ignore-scripts"]],
    ["Bun", "bun", ["add", "--minimum-release-age", "0"]],
  ];
  for (const [client, executable, prefix] of clients) {
    const directory = join(temporaryDirectory, `install-${client.toLowerCase()}`);
    await mkdir(directory);
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    await writeFile(join(directory, ".npmrc"), npmrcContents);
    const cacheDirectory = join(temporaryDirectory, `cache-${client.toLowerCase()}`);
    const cacheArguments =
      client === "pnpm"
        ? ["--store-dir", cacheDirectory]
        : client === "Yarn"
          ? ["--cache-folder", cacheDirectory]
          : [];
    const cacheEnvironment = {
      ...readEnvironment,
      ...(client === "npm" ? { NPM_CONFIG_CACHE: cacheDirectory } : {}),
      ...(client === "Bun" ? { BUN_INSTALL_CACHE_DIR: cacheDirectory } : {}),
    };
    await run(executable, [...prefix, ...packages, ...cacheArguments], {
      cwd: directory,
      env: cacheEnvironment,
    });
    await verifyInstalled(directory, packageNames);
    process.stdout.write(`Verified ${client} install\n`);
  }
} finally {
  if (worker !== undefined && worker.exitCode === null) {
    workerStopping = true;
    worker.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      worker?.once("exit", () => resolvePromise());
    });
  }
  await rm(temporaryDirectory, { recursive: true });
}
