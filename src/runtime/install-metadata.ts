export const installMediaType = "application/vnd.npm.install-v1+json";

const installFields = [
  "name",
  "version",
  "deprecated",
  "dependencies",
  "acceptDependencies",
  "optionalDependencies",
  "devDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bin",
  "directories",
  "dist",
  "engines",
  "_hasShrinkwrap",
  "funding",
  "cpu",
  "os",
  "libc",
  "installConfig",
];

// Project existing manifests inside D1, preserving JSON arrays, objects, and booleans.
// Only this fixed field list is interpolated into SQL.
export const installManifestSql = `json_patch(
  (SELECT json_group_object(key, CASE type
    WHEN 'object' THEN json(value) WHEN 'array' THEN json(value)
    WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') ELSE value END)
   FROM json_each(versions.manifest_json)
   WHERE key IN (${installFields.map((field) => `'${field}'`).join(", ")})),
  json_object('hasInstallScript', json(CASE WHEN
    json_extract(manifest_json, '$.hasInstallScript') = 1
    OR json_extract(manifest_json, '$.gypfile') = 1
    OR (json_type(manifest_json, '$.scripts.preinstall') = 'text' AND length(json_extract(manifest_json, '$.scripts.preinstall')) > 0)
    OR (json_type(manifest_json, '$.scripts.install') = 'text' AND length(json_extract(manifest_json, '$.scripts.install')) > 0)
    OR (json_type(manifest_json, '$.scripts.postinstall') = 'text' AND length(json_extract(manifest_json, '$.scripts.postinstall')) > 0)
    THEN 'true' ELSE 'false' END)))`;

export function prefersInstallMetadata(accept: string | null): boolean {
  if (accept === null) return false;
  const preferences = [
    { type: installMediaType, specificity: -1, quality: 0 },
    { type: "application/json", specificity: -1, quality: 0 },
  ];
  for (const range of accept.toLowerCase().split(",")) {
    const [type, ...parameters] = range.split(";").map((part) => part.trim());
    const qualityParameters = parameters.filter((parameter) => /^q\s*=/.test(parameter));
    const value = qualityParameters[0]?.split("=")[1]?.trim() ?? "1";
    const quality =
      qualityParameters.length > 1 || !/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)
        ? 0
        : Number(value);
    for (const preference of preferences) {
      const specificity =
        type === preference.type ? 2 : type === "application/*" ? 1 : type === "*/*" ? 0 : -1;
      if (specificity < 0) continue;
      if (
        specificity > preference.specificity ||
        (specificity === preference.specificity && quality > preference.quality)
      ) {
        preference.specificity = specificity;
        preference.quality = quality;
      }
    }
  }
  const [installation, full] = preferences;
  return (
    installation !== undefined &&
    full !== undefined &&
    installation.specificity === 2 &&
    installation.quality > 0 &&
    installation.quality >= full.quality
  );
}
