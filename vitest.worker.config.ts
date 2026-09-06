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
    githubOidc: {
      audience: "pkgflare://registry.example",
      subjects: [
        {
          repositoryId: "123456",
          repositoryOwnerId: "654321",
          ref: "refs/heads/main",
          workflowRef: "acme/example/.github/workflows/publish.yml@refs/heads/main",
          permissions: ["publish"],
          packages: ["@acme/oidc-package"],
        },
        {
          repositoryId: "222222",
          repositoryOwnerId: "654321",
          ref: "refs/heads/main",
          workflowRef: "acme/reader/.github/workflows/test.yml@refs/heads/main",
          permissions: ["read"],
          packages: ["@acme/read-only"],
        },
        {
          repositoryId: "333333",
          repositoryOwnerId: "654321",
          ref: "refs/heads/main",
          workflowRef: "acme/caller/.github/workflows/release.yml@refs/heads/main",
          jobWorkflowRef: "acme/workflows/.github/workflows/npm-publish.yml@refs/heads/main",
          permissions: ["publish"],
          packages: ["@acme/reusable-package"],
        },
      ],
    },
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
