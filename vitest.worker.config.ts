import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

const runtimeConfig = {
  name: "test-registry",
  scopes: ["@acme", "@example"],
  auth: {
    provider: "secrets",
    tokens: [
      { binding: "READ_TOKEN", permissions: ["read"] },
      { binding: "NEW_READ_TOKEN", permissions: ["read"] },
      { binding: "MISSING_TOKEN", permissions: ["read"] },
      { binding: "PUBLISH_TOKEN", permissions: ["publish"] },
    ],
  },
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        bindings: {
          PKGFLARE_CONFIG: JSON.stringify(runtimeConfig),
          READ_TOKEN: "read-secret",
          NEW_READ_TOKEN: "new-read-secret",
          PUBLISH_TOKEN: "publish-secret",
          TEST_MIGRATIONS: migrations,
        },
        d1Databases: ["PKGFLARE_DB"],
        r2Buckets: ["PKGFLARE_BUCKET"],
      },
    }),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
  },
});
