import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deploy } from "../../src/cli/deploy.js";
import type { CommandResult, WranglerRunner } from "../../src/cli/runner.js";

const temporaryDirectories: string[] = [];

interface StoredState {
  account_id?: string;
  d1_databases: Array<{ migrations_dir?: string }>;
  r2_buckets: Array<{ bucket_name: string }>;
}

async function project(accountId?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pkgflare-test-"));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, "pkgflare.config.ts"),
    `export default { name: "acme-registry", ${accountId === undefined ? "" : `accountId: "${accountId}", `}scopes: ["@acme"], auth: { provider: "secrets", tokens: [{ binding: "READ_TOKEN", permissions: ["read"] }, { binding: "PUBLISH_TOKEN", permissions: ["publish"] }] } }`,
  );
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function result(stdout = ""): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function provisioningRunner(
  cwd: string,
  commands: string[][],
  options: { existing?: boolean; accounts?: Array<{ id: string; name: string }> } = {},
): WranglerRunner {
  return async (arguments_) => {
    const argumentsArray = [...arguments_];
    commands.push(argumentsArray);
    const stateFile = join(cwd, ".pkgflare", "wrangler.json");
    if (argumentsArray[0] === "whoami") {
      return result(
        JSON.stringify({
          loggedIn: true,
          accounts: options.accounts ?? [{ id: "0123456789abcdef0123456789abcdef", name: "Test" }],
        }),
      );
    }
    if (argumentsArray[0] === "versions" && argumentsArray[1] === "list") {
      return { exitCode: 1, stdout: "", stderr: "Worker not found [code: 10007]" };
    }
    if (argumentsArray[0] === "d1" && argumentsArray[1] === "list") {
      return result(
        options.existing
          ? JSON.stringify([{ name: "acme-registry-metadata", uuid: "database-id" }])
          : "[]",
      );
    }
    if (argumentsArray[0] === "r2" && argumentsArray[2] === "info") {
      if (options.existing) return result(JSON.stringify({ name: "acme-registry-packages" }));
      return { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (argumentsArray[0] === "d1" && argumentsArray[1] === "create") {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
      state.d1_databases = [
        {
          binding: "PKGFLARE_DB",
          database_name: "acme-registry-metadata",
          database_id: "database-id",
        },
      ];
      await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    }
    if (
      argumentsArray[0] === "r2" &&
      argumentsArray[1] === "bucket" &&
      argumentsArray[2] === "create"
    ) {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
      state.r2_buckets = [{ binding: "PKGFLARE_BUCKET", bucket_name: "acme-registry-packages" }];
      await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    }
    if (argumentsArray[0] === "deploy") return result("https://acme-registry.example.workers.dev");
    return result();
  };
}

describe("deploy", () => {
  it("provisions once, persists non-secret state, migrates, and deploys", async () => {
    const cwd = await project();
    const firstCommands: string[][] = [];
    const first = await deploy({
      cwd,
      runner: provisioningRunner(cwd, firstCommands),
      assetsDirectory: resolve("dist"),
    });
    expect(first.registryUrl).toBe("https://acme-registry.example.workers.dev");
    expect(first.scopes).toEqual(["@acme"]);
    expect(firstCommands.map((command) => command.slice(0, 3))).toEqual([
      ["whoami", "--json"],
      ["d1", "list", "--json"],
      ["d1", "create", "acme-registry-metadata"],
      ["r2", "bucket", "info"],
      ["r2", "bucket", "create"],
      ["d1", "migrations", "apply"],
      ["versions", "list", "--name"],
      ["deploy", "--no-bundle", "--config"],
    ]);

    const stateContents = await readFile(first.stateFile, "utf8");
    expect(stateContents).not.toContain("read-secret");
    const state = JSON.parse(stateContents) as StoredState;
    expect(state.account_id).toBe("0123456789abcdef0123456789abcdef");
    expect(state.d1_databases).toContainEqual(
      expect.objectContaining({ migrations_dir: "migrations" }),
    );
    expect(state.r2_buckets).toContainEqual({
      bucket_name: "acme-registry-packages",
      binding: "PKGFLARE_BUCKET",
    });

    const secondCommands: string[][] = [];
    await deploy({
      cwd,
      runner: provisioningRunner(cwd, secondCommands),
      assetsDirectory: resolve("dist"),
    });
    expect(secondCommands.map((command) => command[0])).toEqual(["d1", "deploy"]);
    expect(secondCommands[0]?.slice(0, 3)).toEqual(["d1", "migrations", "apply"]);
  });

  it("refuses to reuse state belonging to a different Worker", async () => {
    const cwd = await project();
    const stateDirectory = join(cwd, ".pkgflare");
    await mkdir(stateDirectory);
    await writeFile(
      join(stateDirectory, "wrangler.json"),
      JSON.stringify({ name: "other-registry" }),
    );
    await expect(
      deploy({ cwd, runner: provisioningRunner(cwd, []), assetsDirectory: resolve("dist") }),
    ).rejects.toThrow("belongs to other-registry");
  });

  it("requires explicit adoption when deterministic resource names already exist", async () => {
    const cwd = await project();
    await expect(
      deploy({
        cwd,
        runner: provisioningRunner(cwd, [], { existing: true }),
        assetsDirectory: resolve("dist"),
      }),
    ).rejects.toThrow("--adopt-existing");

    const adopted = await deploy({
      cwd,
      runner: provisioningRunner(cwd, [], { existing: true }),
      assetsDirectory: resolve("dist"),
      adoptExisting: true,
    });
    const state = JSON.parse(await readFile(adopted.stateFile, "utf8")) as StoredState;
    expect(state.d1_databases).toContainEqual(
      expect.objectContaining({ database_id: "database-id" }),
    );
    expect(state.r2_buckets).toContainEqual({
      binding: "PKGFLARE_BUCKET",
      bucket_name: "acme-registry-packages",
    });
  });

  it("requires accountId when credentials expose multiple accounts", async () => {
    const cwd = await project();
    const accounts = [
      { id: "0123456789abcdef0123456789abcdef", name: "First" },
      { id: "fedcba9876543210fedcba9876543210", name: "Second" },
    ];
    await expect(
      deploy({
        cwd,
        runner: provisioningRunner(cwd, [], { accounts }),
        assetsDirectory: resolve("dist"),
      }),
    ).rejects.toThrow("accountId is required");
  });

  it("uses an explicitly configured account without enumerating accounts", async () => {
    const accountId = "0123456789abcdef0123456789abcdef";
    const cwd = await project(accountId);
    const commands: string[][] = [];
    await deploy({
      cwd,
      runner: provisioningRunner(cwd, commands),
      assetsDirectory: resolve("dist"),
    });
    expect(commands.some((command) => command[0] === "whoami")).toBe(false);
    expect(JSON.parse(await readFile(join(cwd, ".pkgflare", "wrangler.json"), "utf8"))).toEqual(
      expect.objectContaining({ account_id: accountId }),
    );
  });

  it("rejects an environment account that conflicts with configuration", async () => {
    const cwd = await project("0123456789abcdef0123456789abcdef");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "fedcba9876543210fedcba9876543210");
    await expect(
      deploy({ cwd, runner: provisioningRunner(cwd, []), assetsDirectory: resolve("dist") }),
    ).rejects.toThrow("does not match");
  });

  it("requires explicit adoption before overwriting an existing Worker", async () => {
    const cwd = await project();
    const workerRunner = (allowExisting: boolean, commands: string[][]): WranglerRunner => {
      const base = provisioningRunner(cwd, commands);
      return async (arguments_, options) => {
        if (arguments_[0] === "versions" && arguments_[1] === "list") {
          commands.push([...arguments_]);
          return allowExisting
            ? result("[]")
            : { exitCode: 1, stdout: "", stderr: "Worker not found [code: 10007]" };
        }
        return base(arguments_, options);
      };
    };

    await expect(
      deploy({ cwd, runner: workerRunner(true, []), assetsDirectory: resolve("dist") }),
    ).rejects.toThrow("--adopt-existing");

    const commands: string[][] = [];
    await deploy({
      cwd,
      runner: workerRunner(true, commands),
      assetsDirectory: resolve("dist"),
      adoptExisting: true,
    });
    expect(JSON.parse(await readFile(join(cwd, ".pkgflare", "ownership.json"), "utf8"))).toEqual({
      account_id: "0123456789abcdef0123456789abcdef",
      worker_name: "acme-registry",
    });
  });

  it("retries after a migration failure without recreating saved resources", async () => {
    const cwd = await project();
    let failMigration = true;
    const commands: string[][] = [];
    const base = provisioningRunner(cwd, commands);
    const runner: WranglerRunner = async (arguments_, options) => {
      if (arguments_[0] === "d1" && arguments_[1] === "migrations" && failMigration) {
        commands.push([...arguments_]);
        failMigration = false;
        throw new Error("migration failed");
      }
      return base(arguments_, options);
    };

    await expect(deploy({ cwd, runner, assetsDirectory: resolve("dist") })).rejects.toThrow(
      "migration failed",
    );
    await deploy({ cwd, runner, assetsDirectory: resolve("dist") });
    expect(
      commands.filter((command) => command.slice(0, 2).join(" ") === "d1 create"),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.slice(0, 3).join(" ") === "r2 bucket create"),
    ).toHaveLength(1);
  });

  it("requires adoption when a failed deploy created the Worker before returning", async () => {
    const cwd = await project();
    let workerExists = false;
    let loseDeployResult = true;
    const commands: string[][] = [];
    const base = provisioningRunner(cwd, commands);
    const runner: WranglerRunner = async (arguments_, options) => {
      if (arguments_[0] === "versions" && arguments_[1] === "list") {
        commands.push([...arguments_]);
        return workerExists
          ? result("[]")
          : { exitCode: 1, stdout: "", stderr: "Worker not found [code: 10007]" };
      }
      if (arguments_[0] === "deploy" && loseDeployResult) {
        commands.push([...arguments_]);
        workerExists = true;
        loseDeployResult = false;
        throw new Error("deploy result was lost");
      }
      return base(arguments_, options);
    };

    await expect(deploy({ cwd, runner, assetsDirectory: resolve("dist") })).rejects.toThrow(
      "deploy result was lost",
    );
    await expect(deploy({ cwd, runner, assetsDirectory: resolve("dist") })).rejects.toThrow(
      "--adopt-existing",
    );
    await deploy({ cwd, runner, assetsDirectory: resolve("dist"), adoptExisting: true });
    expect(
      commands.filter((command) => command.slice(0, 2).join(" ") === "d1 create"),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.slice(0, 3).join(" ") === "r2 bucket create"),
    ).toHaveLength(1);
  });

  it("copies every packaged SQL migration before applying them", async () => {
    const cwd = await project();
    const packageDirectory = await mkdtemp(join(tmpdir(), "pkgflare-assets-"));
    temporaryDirectories.push(packageDirectory);
    const assetsDirectory = join(packageDirectory, "dist");
    const migrationsDirectory = join(packageDirectory, "migrations");
    await Promise.all([
      mkdir(assetsDirectory),
      mkdir(migrationsDirectory),
      writeFile(join(packageDirectory, "placeholder"), ""),
    ]);
    await Promise.all([
      writeFile(join(assetsDirectory, "worker.js"), "export default {};"),
      writeFile(join(assetsDirectory, "worker.js.map"), "{}"),
      writeFile(join(migrationsDirectory, "0001_initial.sql"), "SELECT 1;"),
      writeFile(join(migrationsDirectory, "0002_additive.sql"), "SELECT 2;"),
      writeFile(join(migrationsDirectory, "README.md"), "not a migration"),
    ]);

    const deployed = await deploy({
      cwd,
      runner: provisioningRunner(cwd, []),
      assetsDirectory,
    });
    expect(await readdir(join(deployed.stateFile, "..", "migrations"))).toEqual([
      "0001_initial.sql",
      "0002_additive.sql",
    ]);
  });
});
