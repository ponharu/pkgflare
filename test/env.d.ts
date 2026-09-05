declare namespace Cloudflare {
  interface Exports {
    default: Fetcher;
  }

  interface Env {
    PKGFLARE_DB: D1Database;
    PKGFLARE_BUCKET: R2Bucket;
    PKGFLARE_CONFIG: string;
    READ_TOKEN: string;
    NEW_READ_TOKEN: string;
    PUBLISH_TOKEN: string;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  }
}
