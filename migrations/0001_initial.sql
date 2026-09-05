PRAGMA foreign_keys = ON;

CREATE TABLE packages (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE versions (
  package_name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  tarball_key TEXT NOT NULL UNIQUE,
  tarball_file TEXT NOT NULL,
  shasum TEXT NOT NULL,
  integrity TEXT NOT NULL,
  tarball_size INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (package_name, version),
  UNIQUE (package_name, tarball_file),
  FOREIGN KEY (package_name) REFERENCES packages(name) ON DELETE CASCADE
);

CREATE TABLE dist_tags (
  package_name TEXT NOT NULL,
  tag TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (package_name, tag),
  FOREIGN KEY (package_name, version)
    REFERENCES versions(package_name, version) ON DELETE CASCADE
);

CREATE INDEX versions_package_published
  ON versions(package_name, published_at);
