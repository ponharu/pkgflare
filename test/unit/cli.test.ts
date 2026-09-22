import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = resolve("dist/cli.js");
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pkgflare-cli-"));
  await writeFile(join(cwd, "pkgflare.config.ts"), 'throw new Error("CONFIG_EVALUATED");\n');
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

describe("CLI argument validation", () => {
  it.each(
    [
      [],
      ["--help"],
      ["-h"],
      ["deploy", "--help"],
      ["init", "-h"],
      ["auth", "--help"],
      ["auth", "github", "--help"],
      ["token", "--help"],
      ["token", "generate", "-h"],
    ].map((args) => [args]),
  )("shows help without side effects for %j", async (args) => {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
    expect(await readdir(cwd)).toEqual(["pkgflare.config.ts"]);
  });

  it.each(
    [
      ["deploy", "--dry-run"],
      ["deploy", "--configg", "alternate.ts"],
      ["deploy", "unexpected"],
      ["deploy", "--config"],
      ["deploy", "--config="],
      ["deploy", "--config", "--help"],
      ["deploy", "--config", "one.ts", "--config", "two.ts"],
      ["deploy", "--adopt-existing", "--adopt-existing"],
      ["deploy", "--adopt-existing=false"],
      ["deploy", "--help", "--dry-run"],
      ["init", "unexpected"],
      ["init", "--config", "alternate.ts"],
      ["token", "generate", "unexpected"],
      ["auth", "github", "--audience"],
      ["auth", "github", "--audience", "one", "--audience", "two"],
      ["auth", "github", "--adopt-existing"],
      ["auth", "unknown"],
      ["--help", "deploy"],
    ].map((args) => [args]),
  )("rejects invalid arguments before executing %j", async (args) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pkgflare:");
    expect(result.stderr).not.toContain("CONFIG_EVALUATED");
    expect(result.stdout).toBe("");
    expect(await readdir(cwd)).toEqual(["pkgflare.config.ts"]);
  });

  it.each([["--config", "alternate.ts"], ["--config=alternate.ts"]].map((args) => [args]))(
    "loads an explicitly selected configuration for %j",
    async (args) => {
      await writeFile(join(cwd, "alternate.ts"), 'throw new Error("ALTERNATE_CONFIG");\n');
      const result = run(["deploy", ...args, "--adopt-existing"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ALTERNATE_CONFIG");
      expect(result.stderr).not.toContain("CONFIG_EVALUATED");
      expect(await readdir(cwd)).not.toContain(".pkgflare");
    },
  );

  it("runs local commands and preserves exclusive initialization", async () => {
    await rm(join(cwd, "pkgflare.config.ts"));
    expect(run(["init"]).status).toBe(0);
    const config = await readFile(join(cwd, "pkgflare.config.ts"), "utf8");
    expect(config).toContain("defineConfig");
    expect(run(["init"]).status).toBe(1);
    expect(await readFile(join(cwd, "pkgflare.config.ts"), "utf8")).toBe(config);
    const generated = run(["token", "generate"]);
    expect(generated.status).toBe(0);
    expect(generated.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
  });
});
