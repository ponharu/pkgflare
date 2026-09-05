import type { NormalizedConfig } from "../config.js";

export interface Env {
  PKGFLARE_DB: D1Database;
  PKGFLARE_BUCKET: R2Bucket;
  PKGFLARE_CONFIG: string;
  [binding: string]: D1Database | R2Bucket | string;
}

export interface RuntimeContext {
  env: Env;
  config: NormalizedConfig;
  requestId: string;
}

export interface PublishDocument {
  _id?: unknown;
  name?: unknown;
  versions?: unknown;
  "dist-tags"?: unknown;
  _attachments?: unknown;
}

export interface PackageManifest {
  name: string;
  version: string;
  dist?: {
    tarball?: string;
    shasum?: string;
    integrity?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StoredVersionRow {
  version: string;
  manifest_json: string;
  tarball_file: string;
  shasum: string;
  integrity: string;
  published_at: string;
}

export interface DistTagRow {
  tag: string;
  version: string;
}

export interface TarballRow {
  tarball_key: string;
  shasum: string;
  integrity: string;
  tarball_size: number;
}
