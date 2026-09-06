async function readGithubTokenResponse(response: Response): Promise<string> {
  const maximumBytes = 32 * 1024;
  if (response.body === null) throw new Error("GitHub OIDC token response is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let contents = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("GitHub OIDC token response is too large");
      }
      contents += decoder.decode(value, { stream: true });
    }
    contents += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("GitHub OIDC token response is invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("value" in value) ||
    typeof value.value !== "string" ||
    value.value.length > 16 * 1024 ||
    !/^[^.]+\.[^.]+\.[^.]+$/.test(value.value)
  ) {
    throw new Error("GitHub OIDC token response is invalid");
  }
  return value.value;
}

export async function requestGithubOidcToken(
  audience: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (audience === undefined) throw new Error("--audience is required");
  if (!/^[\x21-\x7e]{1,256}$/.test(audience)) {
    throw new Error("--audience must be 1-256 printable ASCII characters");
  }
  const requestUrlValue = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (requestUrlValue === undefined || requestToken === undefined || requestToken.length === 0) {
    throw new Error("GitHub Actions OIDC environment is unavailable");
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(requestUrlValue);
  } catch {
    throw new Error("GitHub Actions OIDC request URL is invalid");
  }
  if (
    requestUrl.protocol !== "https:" ||
    (requestUrl.hostname !== "token.actions.githubusercontent.com" &&
      !requestUrl.hostname.endsWith(".actions.githubusercontent.com")) ||
    requestUrl.username !== "" ||
    requestUrl.password !== ""
  ) {
    throw new Error("GitHub Actions OIDC request URL is not trusted");
  }
  requestUrl.searchParams.set("audience", audience);

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      headers: { authorization: `bearer ${requestToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error("GitHub Actions OIDC token request failed");
  }
  if (!response.ok) throw new Error("GitHub Actions OIDC token request failed");
  return readGithubTokenResponse(response);
}
