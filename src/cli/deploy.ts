import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedConfig } from "../config.js";
import { loadConfig } from "./config-loader.js";
import { createWranglerRunner, type WranglerRunner } from "./runner.js";

const stateDirectoryName = ".pkgflare";
const stateFileName = "wrangler.json";
const ownershipFileName = "ownership.json";
const d1Binding = "PKGFLARE_DB";
const r2Binding = "PKGFLARE_BUCKET";

interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir?: string;
}

interface R2Binding {
  binding: string;
  bucket_name: string;
}

interface WranglerState {
  $schema: string;
  account_id?: string;
  name: string;
  main: string;
  compatibility_date: string;
  workers_dev: boolean;
  routes?: Array<{ pattern: string; custom_domain: true }>;
  vars: { PKGFLARE_CONFIG: string };
  d1_databases: D1Binding[];
  r2_buckets: R2Binding[];
}

interface D1ListEntry {
  name?: unknown;
  uuid?: unknown;
}

interface WhoamiResult {
  loggedIn?: unknown;
  accounts?: unknown;
}

interface AccountEntry {
  id: string;
  name?: string;
}

interface OwnershipState {
  account_id: string;
  worker_name: string;
}

export interface DeployOptions {
  cwd: string;
  configFile?: string;
  secretsFile?: string;
  adoptExisting?: boolean;
  runner?: WranglerRunner;
  assetsDirectory?: string;
}

export interface DeployResult {
  registryUrl: string | null;
  stateFile: string;
  secretBindings: string[];
  scopes: string[];
}

function packageRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function stateFor(
  config: NormalizedConfig,
  accountId: string,
  previous?: WranglerState,
): WranglerState {
  if (previous?.account_id !== undefined && previous.account_id !== accountId) {
    throw new Error("authenticated Cloudflare account does not match the deployment state");
  }
  const state: WranglerState = {
    $schema:
      "https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/config-schema.json",
    account_id: accountId,
    name: config.name,
    main: "runtime/worker.js",
    compatibility_date: "2026-08-01",
    workers_dev: config.hostname === undefined,
    vars: { PKGFLARE_CONFIG: JSON.stringify(config) },
    d1_databases: previous?.d1_databases ?? [],
    r2_buckets: previous?.r2_buckets ?? [],
  };
  if (config.hostname !== undefined) {
    state.routes = [{ pattern: config.hostname, custom_domain: true }];
  }
  return state;
}

async function readState(
  path: string,
  config: NormalizedConfig,
): Promise<WranglerState | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const state = JSON.parse(contents) as WranglerState;
  if (state.name !== config.name) {
    throw new Error(
      `existing deployment state belongs to ${state.name}; remove ${stateDirectoryName} only after verifying the remote resources`,
    );
  }
  return state;
}

async function writeState(path: string, state: WranglerState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readWorkerOwnership(
  path: string,
  workerName: string,
  accountId: string,
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const ownership = JSON.parse(contents) as Partial<OwnershipState>;
  if (ownership.worker_name !== workerName || ownership.account_id !== accountId) {
    throw new Error("deployment ownership state does not match the configured Worker and account");
  }
  return true;
}

async function writeWorkerOwnership(
  path: string,
  workerName: string,
  accountId: string,
): Promise<void> {
  const ownership: OwnershipState = { account_id: accountId, worker_name: workerName };
  await writeFile(path, `${JSON.stringify(ownership, null, 2)}\n`, "utf8");
}

async function copyRuntimeFiles(stateDirectory: string, root: string): Promise<void> {
  const runtimeDirectory = join(stateDirectory, "runtime");
  const migrationsDirectory = join(stateDirectory, "migrations");
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(migrationsDirectory, { recursive: true }),
  ]);
  const sourceMigrations = resolve(root, "..", "migrations");
  const migrationFiles = (await readdir(sourceMigrations, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name);
  // oxlint-disable-next-line unicorn/no-array-sort -- this array has just been created locally
  migrationFiles.sort();
  if (migrationFiles.length === 0) throw new Error("pkgflare package contains no D1 migrations");
  await Promise.all([
    copyFile(join(root, "worker.js"), join(runtimeDirectory, "worker.js")),
    copyFile(join(root, "worker.js.map"), join(runtimeDirectory, "worker.js.map")),
    ...migrationFiles.map((file) =>
      copyFile(join(sourceMigrations, file), join(migrationsDirectory, file)),
    ),
  ]);
  await writeFile(join(stateDirectory, ".gitignore"), "runtime/\nmigrations/\n", {
    flag: "wx",
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
}

function configArguments(stateFile: string, cwd: string): string[] {
  return ["--config", relative(cwd, stateFile)];
}

async function recoverD1(
  runner: WranglerRunner,
  databaseName: string,
  configArgs: readonly string[],
): Promise<D1Binding | null> {
  const result = await runner(["d1", "list", "--json", ...configArgs], { silent: true });
  const entries = JSON.parse(result.stdout) as D1ListEntry[];
  const matches = entries.filter(
    (entry) => entry.name === databaseName && typeof entry.uuid === "string",
  );
  if (matches.length > 1) throw new Error(`multiple D1 databases are named ${databaseName}`);
  const match = matches[0];
  return match === undefined
    ? null
    : {
        binding: d1Binding,
        database_name: databaseName,
        database_id: match.uuid as string,
        migrations_dir: "migrations",
      };
}

async function recoverR2(
  runner: WranglerRunner,
  bucketName: string,
  configArgs: readonly string[],
): Promise<R2Binding | null> {
  const result = await runner(["r2", "bucket", "info", bucketName, "--json", ...configArgs], {
    silent: true,
    allowFailure: true,
  });
  if (result.exitCode === 0) return { binding: r2Binding, bucket_name: bucketName };
  if (/not found|does not exist|10006/i.test(result.stderr)) return null;
  throw new Error(`unable to inspect the ${bucketName} R2 bucket with the current credentials`);
}

function accountsFromWhoami(value: unknown): AccountEntry[] {
  if (typeof value !== "object" || value === null)
    throw new Error("Wrangler returned invalid account information");
  const accounts = (value as WhoamiResult).accounts;
  if (!Array.isArray(accounts)) throw new Error("Wrangler returned invalid account information");
  return accounts.flatMap((account) => {
    if (
      typeof account !== "object" ||
      account === null ||
      !("id" in account) ||
      typeof account.id !== "string"
    ) {
      return [];
    }
    return [
      {
        id: account.id,
        ...(typeof (account as { name?: unknown }).name === "string"
          ? { name: (account as { name: string }).name }
          : {}),
      },
    ];
  });
}

async function resolveAccountId(
  runner: WranglerRunner,
  configuredAccountId: string | undefined,
): Promise<string> {
  if (configuredAccountId !== undefined) return configuredAccountId;
  const result = await runner(["whoami", "--json"], { silent: true });
  const accounts = accountsFromWhoami(JSON.parse(result.stdout) as unknown);
  if (accounts.length !== 1) {
    throw new Error("accountId is required when Wrangler credentials can access multiple accounts");
  }
  const account = accounts[0];
  if (account === undefined)
    throw new Error("Wrangler credentials do not provide a Cloudflare account");
  return account.id;
}

async function workerExists(
  runner: WranglerRunner,
  workerName: string,
  configArgs: readonly string[],
): Promise<boolean> {
  const result = await runner(["versions", "list", "--name", workerName, "--json", ...configArgs], {
    silent: true,
    allowFailure: true,
  });
  if (result.exitCode === 0) return true;
  if (/not found|does not exist|10007/i.test(result.stderr)) return false;
  throw new Error(`unable to inspect the ${workerName} Worker with the current credentials`);
}

async function verifyWorkerOwnership(
  workerName: string,
  configArgs: readonly string[],
  runner: WranglerRunner,
  adoptExisting: boolean,
): Promise<boolean> {
  const exists = await workerExists(runner, workerName, configArgs);
  if (exists && !adoptExisting) {
    throw new Error(
      `the ${workerName} Worker already exists; verify it, then rerun with --adopt-existing`,
    );
  }
  return exists;
}

async function ensureResources(
  state: WranglerState,
  stateFile: string,
  cwd: string,
  runner: WranglerRunner,
  adoptExisting: boolean,
): Promise<WranglerState> {
  const d1Name = `${state.name}-metadata`;
  const r2Name = `${state.name}-packages`;
  const configArgs = configArguments(stateFile, cwd);
  const configuredD1 = state.d1_databases.filter((database) => database.binding === d1Binding);
  const configuredR2 = state.r2_buckets.filter((bucket) => bucket.binding === r2Binding);
  const selectedD1 = configuredD1[0];
  const selectedR2 = configuredR2[0];
  if (
    configuredD1.length > 1 ||
    (selectedD1 !== undefined && selectedD1.database_name !== d1Name)
  ) {
    throw new Error(`${d1Binding} must reference the ${d1Name} D1 database`);
  }
  if (configuredR2.length > 1 || (selectedR2 !== undefined && selectedR2.bucket_name !== r2Name)) {
    throw new Error(`${r2Binding} must reference the ${r2Name} R2 bucket`);
  }

  if (configuredD1.length === 0) {
    const recovered = await recoverD1(runner, d1Name, configArgs);
    if (recovered !== null) {
      if (!adoptExisting) {
        throw new Error(
          `the ${d1Name} D1 database already exists; verify it, then rerun with --adopt-existing`,
        );
      }
      state.d1_databases.push(recovered);
      await writeState(stateFile, state);
    } else {
      await runner([
        "d1",
        "create",
        d1Name,
        "--binding",
        d1Binding,
        "--update-config",
        ...configArgs,
      ]);
      state = JSON.parse(await readFile(stateFile, "utf8")) as WranglerState;
    }
  }

  if (configuredR2.length === 0) {
    const recovered = await recoverR2(runner, r2Name, configArgs);
    if (recovered !== null) {
      if (!adoptExisting) {
        throw new Error(
          `the ${r2Name} R2 bucket already exists; verify it, then rerun with --adopt-existing`,
        );
      }
      state.r2_buckets.push(recovered);
      await writeState(stateFile, state);
    } else {
      await runner([
        "r2",
        "bucket",
        "create",
        r2Name,
        "--binding",
        r2Binding,
        "--update-config",
        ...configArgs,
      ]);
      state = JSON.parse(await readFile(stateFile, "utf8")) as WranglerState;
    }
  }

  state.d1_databases = state.d1_databases.map((database) =>
    database.binding === d1Binding ? { ...database, migrations_dir: "migrations" } : database,
  );
  await writeState(stateFile, state);
  return state;
}

function deploymentUrl(output: string, config: NormalizedConfig): string | null {
  if (config.hostname !== undefined) return `https://${config.hostname}`;
  return output.match(/https:\/\/[^\s]+\.workers\.dev\b/)?.[0] ?? null;
}

export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const cwd = resolve(options.cwd);
  const config = await loadConfig(cwd, options.configFile);
  const stateDirectory = join(cwd, stateDirectoryName);
  const stateFile = join(stateDirectory, stateFileName);
  const ownershipFile = join(stateDirectory, ownershipFileName);
  await mkdir(stateDirectory, { recursive: true });

  const previous = await readState(stateFile, config);
  const runner = options.runner ?? createWranglerRunner(cwd);
  const environmentAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const configuredAccountId = config.accountId ?? previous?.account_id;
  if (
    environmentAccountId !== undefined &&
    configuredAccountId !== undefined &&
    environmentAccountId !== configuredAccountId
  ) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID does not match the configured deployment account");
  }
  const accountId = await resolveAccountId(runner, configuredAccountId ?? environmentAccountId);
  const ownsWorker = await readWorkerOwnership(ownershipFile, config.name, accountId);
  let state = stateFor(config, accountId, previous);
  await writeState(stateFile, state);
  await copyRuntimeFiles(stateDirectory, options.assetsDirectory ?? packageRoot());

  state = await ensureResources(state, stateFile, cwd, runner, options.adoptExisting ?? false);
  const configArgs = configArguments(stateFile, cwd);
  await runner(["d1", "migrations", "apply", d1Binding, "--remote", ...configArgs]);

  const adoptedWorker = ownsWorker
    ? false
    : await verifyWorkerOwnership(state.name, configArgs, runner, options.adoptExisting ?? false);
  if (adoptedWorker) await writeWorkerOwnership(ownershipFile, state.name, accountId);

  const deployArguments = ["deploy", "--no-bundle", ...configArgs];
  if (options.secretsFile !== undefined) {
    deployArguments.push("--secrets-file", options.secretsFile);
  }
  const deployed = await runner(deployArguments);
  if (!ownsWorker && !adoptedWorker)
    await writeWorkerOwnership(ownershipFile, state.name, accountId);
  return {
    registryUrl: deploymentUrl(deployed.stdout, config),
    stateFile,
    secretBindings: config.auth.tokens.map((token) => token.binding),
    scopes: config.scopes,
  };
}
