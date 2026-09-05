import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

interface CommandOptions {
  cwd: string;
  silent?: boolean;
}

async function command(
  program: string,
  arguments_: string[],
  options: CommandOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, arguments_, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: options.silent ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${program} exited with status ${String(code ?? 1)}`));
    });
  });
}

const root = process.cwd();
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pkgflare-package-test-"));

try {
  const packDirectory = join(temporaryDirectory, "pack");
  const projectDirectory = join(temporaryDirectory, "project");
  await Promise.all([mkdir(packDirectory), mkdir(projectDirectory)]);

  await command("npm", ["pack", "--ignore-scripts", "--pack-destination", packDirectory], {
    cwd: root,
  });
  const archiveName = (await readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
  if (archiveName === undefined) throw new Error("npm pack did not produce an archive");
  const archive = join(packDirectory, archiveName);

  await writeFile(
    join(projectDirectory, "package.json"),
    `${JSON.stringify({ name: "pkgflare-package-test", private: true }, null, 2)}\n`,
  );
  await command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    cwd: projectDirectory,
    silent: true,
  });

  const installedPackage = join(projectDirectory, "node_modules", "@ponharu", "pkgflare");
  await Promise.all([
    readFile(join(installedPackage, "docs", "specification.md"), "utf8"),
    readFile(join(installedPackage, "migrations", "0001_initial.sql"), "utf8"),
  ]);
  await command(process.execPath, [join(installedPackage, "dist", "cli.js"), "--help"], {
    cwd: projectDirectory,
  });

  const wranglerConfig = join(projectDirectory, "wrangler.json");
  await writeFile(
    wranglerConfig,
    `${JSON.stringify(
      {
        $schema:
          "https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/config-schema.json",
        name: "pkgflare-package-test",
        main: relative(projectDirectory, join(installedPackage, "dist", "worker.js")),
        compatibility_date: "2026-08-01",
        vars: {
          PKGFLARE_CONFIG: JSON.stringify({
            name: "pkgflare-package-test",
            scopes: ["@acme"],
            auth: {
              provider: "secrets",
              tokens: [{ binding: "READ_TOKEN", permissions: ["read"] }],
            },
          }),
        },
        d1_databases: [
          {
            binding: "PKGFLARE_DB",
            database_name: "pkgflare-package-test-metadata",
            database_id: "00000000-0000-0000-0000-000000000000",
          },
        ],
        r2_buckets: [{ binding: "PKGFLARE_BUCKET", bucket_name: "pkgflare-package-test-packages" }],
      },
      null,
      2,
    )}\n`,
  );

  const projectRequire = createRequire(join(projectDirectory, "package.json"));
  const wranglerPackage = projectRequire.resolve("wrangler/package.json");
  await command(
    process.execPath,
    [
      join(dirname(wranglerPackage), "bin", "wrangler.js"),
      "deploy",
      "--dry-run",
      "--no-bundle",
      "--config",
      wranglerConfig,
      "--outdir",
      join(projectDirectory, "dry-run"),
    ],
    { cwd: projectDirectory },
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
