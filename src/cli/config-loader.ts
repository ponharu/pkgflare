import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { normalizeConfig, type NormalizedConfig } from "../config.js";

export const defaultConfigFile = "pkgflare.config.ts";

export async function loadConfig(
  cwd: string,
  configFile = defaultConfigFile,
): Promise<NormalizedConfig> {
  const path = resolve(cwd, configFile);
  try {
    await access(path);
  } catch {
    throw new Error(`configuration file not found: ${configFile}`);
  }

  const jiti = createJiti(pathToFileURL(import.meta.url).href, {
    interopDefault: true,
    moduleCache: false,
  });
  const imported = await jiti.import(path, { default: true });
  return normalizeConfig(imported);
}
