import { createOAuthRequestMiddleware, withoutAuthorization } from "./request.js";
import { createProfile } from "./profile.js";
import { DEFAULT_RECIPE } from "./recipes.js";
import {
  COMPAT_API, COMPAT_PROVIDER, PROXY_API, PROXY_PROVIDER,
  assertEndpointUrl, assertOfficialUrl, normalizeProxyOrigin, requireOAuth, requireProxyKey
} from "./strict.js";

const OFFICIAL_ORIGIN = "https://api.anthropic.com";

async function loadProfile() {
  return (await createProfile()).profile;
}

function isAnthropicOAuth(model, options) {
  const authorization = Object.entries(options?.headers ?? {})
    .find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const token = options?.apiKey ?? /^Bearer\s+(sk-ant-oat\S*)$/i.exec(authorization ?? "")?.[1];
  return model.provider === "anthropic" && token?.toLowerCase().includes("sk-ant-oat") &&
    new URL(model.baseUrl).hostname === "api.anthropic.com";
}

function decodeToolCalls(event, names) {
  const message = event.partial ?? event.message ?? event.error;
  for (const block of message?.content ?? []) {
    if (block.type !== "toolCall" || !block.name?.startsWith("_")) continue;
    const original = names.get(block.name.slice(1).toLowerCase());
    if (original) block.name = original;
  }
  return event;
}

export function createFallbackStream(streamSimpleAnthropic, createStream, {
  strict = false, onState = () => {}, onFailure = () => {}, proxyOrigin,
  providerId: providerOverride, apiId: apiOverride, directAuth, onFallback = () => {}
} = {}) {
  const proxy = proxyOrigin === undefined ? undefined : normalizeProxyOrigin(proxyOrigin);
  if (proxy && !strict) throw new Error("Claude Compat proxy mode requires the strict route");
  const providerId = providerOverride ?? (proxy ? PROXY_PROVIDER : COMPAT_PROVIDER);
  const apiId = apiOverride ?? (proxy ? PROXY_API : COMPAT_API);
  // Hub mode: claude-compat itself goes to the hub. Its models may still carry the
  // official base URL; the route, not the model, picks the endpoint.
  const hubMode = Boolean(proxy) && providerId === COMPAT_PROVIDER;
  if (directAuth !== undefined && (!hubMode || typeof directAuth !== "function")) {
    throw new Error("Claude Compat direct fallback needs hub mode and a directAuth function");
  }
  return (model, context, options) => {
    if (!strict && !isAnthropicOAuth(model, options)) return streamSimpleAnthropic(model, context, options);
    const output = createStream();
    void (async () => {
      let rejectionReported = false;
      let emitted = false;
      const aborted = () => Boolean(options?.signal?.aborted);
      // Sends one request on one route. Returns the unreachable code when the hub
      // gave no HTTP response at all and a direct fallback is allowed; else undefined.
      const send = async (route, profile, names) => {
        let unreachable;
        let responded = false;
        const middleware = createOAuthRequestMiddleware(profile, {
          strict,
          proxyOrigin: route.proxy,
          onValidated: () => { if (!rejectionReported) onState("validated"); },
          onRejected: (status) => {
            if (rejectionReported || aborted()) return;
            rejectionReported = true;
            onState("error");
            onFailure(`${route.proxy ? "The hub" : "Anthropic"} rejected the Claude Compat request (HTTP ${status})`);
          },
          onResponse: () => { responded = true; },
          onUnreachable: (code) => { unreachable = code; }
        });
        const wireModel = strict ? { ...route.model, provider: "anthropic", api: "anthropic-messages" } : route.model;
        const wireContext = strict ? { ...context, messages: context.messages.map((message) =>
          message.role === "assistant" && message.provider === providerId
            ? { ...message, provider: "anthropic", api: "anthropic-messages" } : message) } : context;
        const wireOptions = middleware(wireModel, wireContext, route.options);
        // The SDK merges model headers over its own auth header. In proxy mode the
        // key was validated above; the fetch wrapper alone puts it on the wire.
        const sendModel = route.proxy ? { ...wireModel, headers: withoutAuthorization(wireModel.headers) } : wireModel;
        const source = streamSimpleAnthropic(sendModel, wireContext, wireOptions);
        for await (const event of source) {
          // Decision 441: fall back only when the hub never answered (DNS, connect,
          // connect timeout). Any HTTP response from the hub is final.
          if (route.proxy && directAuth && !emitted && event.type === "error" &&
              unreachable && !responded && !aborted()) {
            return unreachable;
          }
          if (strict) {
            for (const message of [event.partial, event.message, event.error]) {
              if (message) { message.provider = providerId; message.api = apiId; }
            }
            if (event.type === "error" && event.reason !== "aborted" &&
                event.error?.stopReason !== "aborted" && !aborted()) {
              if (!rejectionReported) {
                onState("error");
                onFailure(event.error?.errorMessage);
              }
            }
          }
          emitted = true;
          output.push(decodeToolCalls(event, names));
        }
        return undefined;
      };
      try {
        if (strict) {
          onState("checking");
          if (model.provider !== providerId || model.api !== apiId) {
            throw new Error("Claude Compat blocked unexpected provider routing");
          }
          if (hubMode) {
            try { assertOfficialUrl(model.baseUrl); } catch { assertEndpointUrl(model.baseUrl, proxy); }
          } else {
            assertEndpointUrl(model.baseUrl, proxy);
          }
          if (proxy) requireProxyKey(options, model.headers);
          else requireOAuth(options, model.headers);
        }
        const profile = await loadProfile();
        const names = new Map();
        for (const message of context.messages ?? []) {
          for (const tool of message.toolsAdded ?? []) {
            if (typeof tool.name === "string") names.set(tool.name.toLowerCase(), tool.name);
          }
        }
        const code = await send({ proxy, model: hubMode ? { ...model, baseUrl: proxy } : model, options }, profile, names);
        if (code) {
          // The cpa_ key never leaves this branch: auth headers are dropped and the
          // apiKey is replaced by the direct OAuth token before anything is sent.
          onState(`fallback · ${code}`);
          onFallback(code);
          let auth;
          try {
            auth = await directAuth(options?.signal);
          } catch (error) {
            throw new Error(`Claude Compat hub unreachable (${code}); direct fallback unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
          const directModel = { ...model, baseUrl: OFFICIAL_ORIGIN, headers: withoutAuthorization(model.headers) };
          const directOptions = { ...options, headers: withoutAuthorization(options?.headers), ...auth };
          if (directOptions.headers) directOptions.headers = withoutAuthorization(directOptions.headers);
          assertOfficialUrl(directModel.baseUrl);
          requireOAuth(directOptions, directModel.headers);
          await send({ proxy: undefined, model: directModel, options: directOptions }, profile, names);
        }
        output.end();
      } catch (error) {
        if (strict && !aborted()) {
          if (!rejectionReported) {
            onState("error");
            onFailure(error instanceof Error ? error.message : String(error));
          }
        }
        output.push({ type: "error", error: {
          role: "assistant", provider: model.provider, api: model.api, model: model.id,
          timestamp: Date.now(), content: [], stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        } });
        output.end();
      }
    })();
    return output;
  };
}

export const MODE_ENV = "PI_CLAUDE_COMPAT_MODE";
const PROXY_KEY_ENV = "PI_CLAUDE_COMPAT_PROXY_KEY";
const PROXY_URL_ENV = "PI_CLAUDE_COMPAT_PROXY_URL";

// proxy (the default when unset) or direct. Anything else fails closed: the
// provider does not load, rather than guessing a route.
export function compatMode(value = process.env[MODE_ENV]) {
  if (value === undefined) return "proxy";
  if (value === "proxy" || value === "direct") return value;
  throw new Error(`${MODE_ENV} must be "proxy" or "direct" (got ${JSON.stringify(value)}); Claude Compat did not load`);
}

const proxyKeyAuth = {
  name: "Claude Compat hub key (cpa_…)",
  login: async (interaction) => ({
    type: "api_key",
    key: await interaction.prompt({ type: "secret", message: "Enter the CLIProxyAPI client key (cpa_…)" })
  }),
  resolve: async ({ ctx, credential, signal }) => {
    signal?.throwIfAborted();
    if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
    const value = await ctx?.env?.(PROXY_KEY_ENV);
    return value ? { auth: { apiKey: value }, source: PROXY_KEY_ENV } : undefined;
  }
};

// Mode is read once, at load. proxy: the same provider and API ids, sent to a
// CLIProxyAPI hub with a cpa_ key; directAuth(signal) -> { apiKey: sk-ant-oat… }
// is used only when the hub is unreachable. direct: upstream behaviour.
export default async function claudeCompat(pi, {
  mode = compatMode(), origin = process.env[PROXY_URL_ENV], directAuth
} = {}) {
  if (compatMode(mode) === "direct") {
    await registerCompat(pi, {
      id: COMPAT_PROVIDER, api: COMPAT_API, label: "Claude Compat", modelSuffix: "[Compat]",
      authPolicy: "OAuth only",
      auth: (base) => ({ oauth: { ...base.auth.oauth, name: "Claude Compat (Anthropic OAuth)" } })
    });
    return;
  }
  if (origin === undefined) {
    throw new Error(`Claude Compat proxy mode needs a hub origin (${PROXY_URL_ENV}); set ${MODE_ENV}=direct to skip the hub`);
  }
  const proxyOrigin = normalizeProxyOrigin(origin);
  await registerCompat(pi, {
    id: COMPAT_PROVIDER, api: COMPAT_API, label: "Claude Compat", modelSuffix: "[Compat]",
    authPolicy: `hub key only (${proxyOrigin}); ` +
      (directAuth ? "direct Anthropic OAuth only when the hub is unreachable" : "no direct fallback"),
    proxyOrigin, directAuth, route: "hub",
    auth: () => ({ apiKey: proxyKeyAuth })
  });
}

// Proxy mode: the same validated Claude Code request, sent to a CLIProxyAPI hub
// that holds the Anthropic OAuth logins. Pi authenticates with a cpa_ client key.
export async function claudeCompatProxy(pi, { origin = process.env[PROXY_URL_ENV] } = {}) {
  const proxyOrigin = normalizeProxyOrigin(origin);
  await registerCompat(pi, {
    id: PROXY_PROVIDER, api: PROXY_API, label: "Claude Compat Proxy", modelSuffix: "[Compat Proxy]",
    authPolicy: `CLIProxyAPI key only (${proxyOrigin})`, proxyOrigin,
    auth: () => ({ apiKey: { ...proxyKeyAuth, name: "Claude Compat proxy key (cpa_…)" } })
  });
}

async function registerCompat(pi, { id, api, label, modelSuffix, authPolicy, auth, proxyOrigin, directAuth, route }) {
  if (typeof pi.registerProvider !== "function") {
    throw new Error("pi-claude-request-compat requires Pi provider registration support");
  }
  const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
  const { streamSimpleAnthropic, streamAnthropic, createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/compat");
  const base = anthropicProvider();
  const statusKey = id;
  const command = `${id}-status`;
  let state = "not sent";
  let lastFailure;
  let lastFallback;
  let uiContext;
  const short = label.replace("Claude ", "");
  const showStatus = () => {
    const via = route ? ` · ${lastFallback ? `direct (hub unreachable: ${lastFallback})` : route}` : "";
    uiContext?.ui.setStatus(statusKey, uiContext.model?.provider === id
      ? `${short} active${via} · ${DEFAULT_RECIPE.id} · ${state}` : `${short} inactive — select ${label}`);
  };
  const wrap = (stream) => createFallbackStream(stream, createAssistantMessageEventStream, {
    strict: true,
    proxyOrigin,
    providerId: id,
    apiId: api,
    ...(directAuth ? { directAuth } : {}),
    onFallback(code) {
      lastFallback = code;
      try {
        showStatus();
        uiContext?.ui.notify(`${label}: hub unreachable (${code}); this request used the direct Anthropic login.`, "warning");
      } catch { /* UI errors must not break the fallback request. */ }
    },
    onState(value) {
      state = value;
      if (value === "checking") { lastFailure = undefined; lastFallback = undefined; }
      showStatus();
    },
    onFailure(reason) {
      lastFailure = String(reason || "Unknown request error").replace(/\s+/g, " ").slice(0, 300);
      state = `failed · /${command}`;
      try {
        showStatus();
        uiContext?.ui.notify(`${label} failed: ${lastFailure}. Resolve this before retrying.`, "error");
      } catch { /* UI errors must not replace the original stream error. */ }
    }
  });
  pi.registerProvider({
    id,
    name: label,
    baseUrl: proxyOrigin ?? base.baseUrl,
    auth: auth(base),
    getModels: () => base.getModels().map((model) => ({
      ...model, provider: id, api, name: `${model.name} ${modelSuffix}`,
      ...(proxyOrigin ? { baseUrl: proxyOrigin } : {})
    })),
    stream: wrap(streamAnthropic),
    streamSimple: wrap(streamSimpleAnthropic)
  });
  const update = (_event, ctx) => { uiContext = ctx; showStatus(); };
  pi.on("session_start", (_event, ctx) => { state = "not sent"; lastFailure = undefined; lastFallback = undefined; update(_event, ctx); });
  pi.on("model_select", update);
  pi.registerCommand(command, {
    description: `Show ${label} routing and local validation status (no network request)`,
    handler: async (_args, ctx) => {
      update(undefined, ctx);
      ctx.ui.notify(`${label}: ${ctx.model?.provider === id ? "selected" : "not selected"}. ` +
        (route ? `Mode: ${route}${lastFallback ? `; last request fell back to direct (hub unreachable: ${lastFallback})` : ""}. ` : "") +
        `Auth policy: ${authPolicy}. Profile: ${DEFAULT_RECIPE.id}. Last request: ${state}. ` +
        (lastFailure ? `Last failure: ${lastFailure}. ` : "") +
        "Local validation does not prove server acceptance. For missing-plugin protection launch with pi-claude-request-compat run.",
      lastFailure ? "error" : "info");
    }
  });
}
