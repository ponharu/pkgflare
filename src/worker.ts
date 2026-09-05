import { normalizeConfig } from "./config.js";
import { authorize } from "./runtime/auth.js";
import { logRegistryError } from "./runtime/diagnostics.js";
import { deleteDistTag, readDistTags, setDistTag } from "./runtime/dist-tags.js";
import { parseDistTagRoute, parsePackageRoute } from "./runtime/package-name.js";
import { publishPackage } from "./runtime/publish.js";
import { methodNotAllowed, npmError, json } from "./runtime/response.js";
import { readPackage, readTarball } from "./runtime/read.js";
import type { Env, RuntimeContext } from "./runtime/types.js";

function contextFromEnv(env: Env, requestId: string): RuntimeContext | Response {
  try {
    return {
      env,
      config: normalizeConfig(JSON.parse(env.PKGFLARE_CONFIG)),
      requestId,
    };
  } catch {
    return npmError(500, "configuration_error", "registry configuration is invalid");
  }
}

async function handle(request: Request, env: Env, requestId: string): Promise<Response> {
  const context = contextFromEnv(env, requestId);
  if (context instanceof Response) return context;

  const url = new URL(request.url);
  if (url.pathname === "/-/ping") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    const denied = await authorize(request, context, "read");
    if (denied !== null) return denied;
    const response = json({ ok: true, name: context.config.name });
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }

  const distTagRoute = parseDistTagRoute(url.pathname);
  if (distTagRoute !== null) {
    if (distTagRoute.tag === undefined) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      const denied = await authorize(request, context, "read");
      if (denied !== null) return denied;
      const response = await readDistTags(context, distTagRoute.packageName);
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    if (request.method !== "PUT" && request.method !== "DELETE") {
      return methodNotAllowed(["PUT", "DELETE"]);
    }
    const denied = await authorize(request, context, "publish");
    if (denied !== null) return denied;
    return request.method === "PUT"
      ? setDistTag(request, context, distTagRoute.packageName, distTagRoute.tag)
      : deleteDistTag(context, distTagRoute.packageName, distTagRoute.tag);
  }

  const route = parsePackageRoute(url.pathname);
  if (route === null) return npmError(404, "not_found", "endpoint not found");

  if (route.remainder.length === 2 && route.remainder[0] === "-") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    const denied = await authorize(request, context, "read");
    if (denied !== null) return denied;
    return readTarball(request, context, route.packageName, route.remainder[1] ?? "");
  }

  if (route.remainder.length > 1) return npmError(404, "not_found", "endpoint not found");
  if (request.method === "PUT" && route.remainder.length === 0) {
    const denied = await authorize(request, context, "publish");
    if (denied !== null) return denied;
    return publishPackage(request, context, route.packageName);
  }
  if ((request.method === "GET" || request.method === "HEAD") && route.remainder.length <= 1) {
    const denied = await authorize(request, context, "read");
    if (denied !== null) return denied;
    const response = await readPackage(request, context, route.packageName, route.remainder[0]);
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }
  return methodNotAllowed(["GET", "HEAD", "PUT"]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const response = await handle(request, env, requestId);
      response.headers.set("x-pkgflare-request-id", requestId);
      return response;
    } catch (error) {
      logRegistryError(requestId, "request", error);
      const response = npmError(500, "internal_error", "unexpected registry error");
      response.headers.set("x-pkgflare-request-id", requestId);
      return response;
    }
  },
};
