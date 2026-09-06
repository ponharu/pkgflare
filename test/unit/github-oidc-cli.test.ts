import { afterEach, describe, expect, it, vi } from "vitest";
import { requestGithubOidcToken } from "../../src/cli/github-oidc.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub OIDC CLI authentication", () => {
  it("requests the configured audience without exposing the request credential", async () => {
    const token = "header.payload.signature";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ value: token }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await requestGithubOidcToken("pkgflare://registry", {
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://pipelines.actions.githubusercontent.com/example/idtoken?api-version=2.0",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-credential",
    });
    expect(result).toBe(token);
    const [url, options] = request.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error("OIDC request URL was not a URL");
    expect(url.searchParams.get("audience")).toBe("pkgflare://registry");
    expect(new Headers(options?.headers).get("authorization")).toBe("bearer request-credential");
  });

  it("rejects missing context, untrusted request URLs, and malformed responses", async () => {
    await expect(requestGithubOidcToken("bad audience", {})).rejects.toThrow("printable ASCII");
    await expect(requestGithubOidcToken("pkgflare://registry", {})).rejects.toThrow(
      "environment is unavailable",
    );
    await expect(
      requestGithubOidcToken("pkgflare://registry", {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.com/idtoken",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-credential",
      }),
    ).rejects.toThrow("not trusted");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"value":"not-a-jwt"}'));
    await expect(
      requestGithubOidcToken("pkgflare://registry", {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/idtoken",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-credential",
      }),
    ).rejects.toThrow("response is invalid");
  });
});
