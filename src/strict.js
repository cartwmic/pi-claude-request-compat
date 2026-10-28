export const COMPAT_PROVIDER = "claude-compat";
export const COMPAT_API = "claude-compat-messages";
export const PROXY_PROVIDER = "claude-compat-proxy";
export const PROXY_API = "claude-compat-proxy-messages";
// Selects Pi's OAuth request layout for proxy mode. The fetch wrapper replaces it
// with the proxy key before any byte leaves the process; it is never a credential.
export const PROXY_LAYOUT_TOKEN = "sk-ant-oat-claude-compat-proxy-layout";
const PROXY_KEY = /^cpa_[A-Za-z0-9_-]{16,}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

// An owner-configured CLIProxyAPI origin: HTTPS, or plain HTTP on loopback only
// (an SSH tunnel). No credentials, path, query or fragment.
export function normalizeProxyOrigin(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Claude Compat proxy mode needs a proxy origin");
  }
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) ||
      url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw new Error("Claude Compat proxy origin must be HTTPS (or HTTP on loopback) with no path or credentials");
  }
  return url.origin;
}

// Proxy mode accepts exactly the configured origin; otherwise only Anthropic.
export function assertEndpointUrl(value, proxyOrigin) {
  if (!proxyOrigin) return assertOfficialUrl(value);
  const url = new URL(value);
  if (url.origin !== proxyOrigin || url.username || url.password ||
      !["", "/", "/v1/messages"].includes(url.pathname)) {
    throw new Error("Claude Compat requires the configured proxy endpoint");
  }
  return url;
}

// Proxy mode sends a CLIProxyAPI client key, never an Anthropic token or API key.
export function requireProxyKey(options = {}, modelHeaders) {
  const headers = new Headers(modelHeaders);
  for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
  const bearer = headers.get("authorization");
  const headerKey = bearer ? /^Bearer (cpa_\S+)$/.exec(bearer)?.[1] : undefined;
  const key = options.apiKey ?? headerKey;
  if (typeof key !== "string" || !PROXY_KEY.test(key) ||
      (bearer && headerKey !== key) || headers.has("x-api-key")) {
    throw new Error("Claude Compat proxy mode requires a cpa_ proxy key; Anthropic tokens, API keys and conflicting auth headers are blocked.");
  }
  return key;
}

export function assertOfficialUrl(value) {
  const url = new URL(value);
  if (url.origin !== "https://api.anthropic.com" || url.username || url.password ||
      !["", "/", "/v1/messages"].includes(url.pathname)) {
    throw new Error("Claude Compat requires the official HTTPS Anthropic endpoint");
  }
  return url;
}

export function requireOAuth(options = {}, modelHeaders) {
  const headers = new Headers(modelHeaders);
  for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
  const bearer = headers.get("authorization");
  const headerToken = bearer ? /^Bearer (sk-ant-oat\S+)$/.exec(bearer)?.[1] : undefined;
  const token = options.apiKey ?? headerToken;
  if (typeof token !== "string" || !/^sk-ant-oat\S+$/.test(token) ||
      (bearer && headerToken !== token) || headers.has("x-api-key")) {
    throw new Error("Claude Compat requires OAuth only; use /login claude-compat. API keys and conflicting auth headers are blocked.");
  }
  return token;
}

// Local envelope checks, not a claim of server acceptance or Claude parity.
export function validateEnvelope(body, headers, { token, model, recipe, sessionId }) {
  if (headers.get("authorization") !== `Bearer ${token}` || headers.has("x-api-key")) {
    throw new Error("Claude Compat blocked unexpected wire authentication");
  }
  const payload = JSON.parse(body);
  let metadata;
  try { metadata = JSON.parse(payload.metadata?.user_id); } catch { /* rejected below */ }
  const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").map((x) => x.trim()));
  if (payload.model !== model.id || payload.stream !== true ||
      !Number.isInteger(payload.max_tokens) || payload.max_tokens < 1 || payload.max_tokens > recipe.maxOutputTokens ||
      !payload.system?.[0]?.text?.startsWith(`x-anthropic-billing-header: cc_version=${recipe.claudeVersion}.`) ||
      !/; cch=[0-9a-f]{5};$/.test(payload.system[0].text) ||
      payload.system?.[1]?.text !== "You are Claude Code, Anthropic's official CLI for Claude." ||
      !metadata?.device_id || metadata.session_id !== sessionId ||
      headers.get("x-claude-code-session-id") !== sessionId ||
      headers.get("x-app") !== "cli" || !betas.has("oauth-2025-04-20")) {
    throw new Error("Claude Compat blocked an incomplete or changed request envelope; update the extension");
  }
}
