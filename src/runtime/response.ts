export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function npmError(status: number, error: string, reason: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (status === 401) {
    headers.set("www-authenticate", 'Bearer realm="pkgflare"');
  }
  return json({ error, reason }, { status, headers });
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  const response = npmError(405, "method_not_allowed", "method not allowed");
  response.headers.set("allow", allowed.join(", "));
  return response;
}
