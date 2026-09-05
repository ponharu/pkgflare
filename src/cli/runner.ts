import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type WranglerRunner = (
  arguments_: readonly string[],
  options?: { allowFailure?: boolean; silent?: boolean },
) => Promise<CommandResult>;

function wranglerEntry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

export function createWranglerRunner(cwd: string): WranglerRunner {
  return async (arguments_, options = {}) => {
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(process.execPath, [wranglerEntry(), ...arguments_], {
        cwd,
        env: process.env,
        shell: false,
        stdio: ["inherit", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!options.silent) process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (!options.silent) process.stderr.write(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });

    if (result.exitCode !== 0 && !options.allowFailure) {
      const operation = arguments_.slice(0, 3).join(" ");
      throw new Error(
        `Wrangler command ${JSON.stringify(operation)} exited with status ${String(result.exitCode)}`,
      );
    }
    return result;
  };
}
