import { createOAuthRequestMiddleware } from "./request.js";
import { createProfile } from "./profile.js";
import { DEFAULT_RECIPE } from "./recipes.js";
import {
  COMPAT_API, COMPAT_PROVIDER, PROXY_API, PROXY_PROVIDER,
  assertEndpointUrl, normalizeProxyOrigin, requireOAuth, requireProxyKey
} from "./strict.js";

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
  strict = false, onState = () => {}, onFailure = () => {}, proxyOrigin
} = {}) {
  const proxy = proxyOrigin === undefined ? undefined : normalizeProxyOrigin(proxyOrigin);
  if (proxy && !strict) throw new Error("Claude Compat proxy mode requires the strict route");
  const providerId = proxy ? PROXY_PROVIDER : COMPAT_PROVIDER;
  const apiId = proxy ? PROXY_API : COMPAT_API;
  return (model, context, options) => {
    if (!strict && !isAnthropicOAuth(model, options)) return streamSimpleAnthropic(model, context, options);
    const output = createStream();
    void (async () => {
      let rejectionReported = false;
      try {
        if (strict) {
          onState("checking");
          if (model.provider !== providerId || model.api !== apiId) {
            throw new Error("Claude Compat blocked unexpected provider routing");
          }
          assertEndpointUrl(model.baseUrl, proxy);
          if (proxy) requireProxyKey(options, model.headers);
          else requireOAuth(options, model.headers);
        }
        const profile = await loadProfile();
        const middleware = createOAuthRequestMiddleware(profile, {
          strict,
          proxyOrigin: proxy,
          onValidated: () => { if (!rejectionReported) onState("validated"); },
          onRejected: (status) => {
            if (rejectionReported || options?.signal?.aborted) return;
            rejectionReported = true;
            onState("error");
            onFailure(`Anthropic rejected the Claude Compat request (HTTP ${status})`);
          }
        });
        const names = new Map();
        for (const message of context.messages ?? []) {
          for (const tool of message.toolsAdded ?? []) {
            if (typeof tool.name === "string") names.set(tool.name.toLowerCase(), tool.name);
          }
        }
        const wireModel = strict ? { ...model, provider: "anthropic", api: "anthropic-messages" } : model;
        const wireContext = strict ? { ...context, messages: context.messages.map((message) =>
          message.role === "assistant" && message.provider === providerId
            ? { ...message, provider: "anthropic", api: "anthropic-messages" } : message) } : context;
        const source = streamSimpleAnthropic(wireModel, wireContext, middleware(wireModel, wireContext, options));
        for await (const event of source) {
          if (strict) {
            for (const message of [event.partial, event.message, event.error]) {
              if (message) { message.provider = providerId; message.api = apiId; }
            }
            if (event.type === "error" && event.reason !== "aborted" &&
                event.error?.stopReason !== "aborted" && !options?.signal?.aborted) {
              if (!rejectionReported) {
                onState("error");
                onFailure(event.error?.errorMessage);
              }
            }
          }
          output.push(decodeToolCalls(event, names));
        }
        output.end();
      } catch (error) {
        if (strict && !options?.signal?.aborted) {
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

export default async function claudeCompat(pi) {
  await registerCompat(pi, {
    id: COMPAT_PROVIDER, api: COMPAT_API, label: "Claude Compat", modelSuffix: "[Compat]",
    authPolicy: "OAuth only",
    auth: (base) => ({ oauth: { ...base.auth.oauth, name: "Claude Compat (Anthropic OAuth)" } })
  });
}

const PROXY_KEY_ENV = "PI_CLAUDE_COMPAT_PROXY_KEY";
const PROXY_URL_ENV = "PI_CLAUDE_COMPAT_PROXY_URL";

// Proxy mode: the same validated Claude Code request, sent to a CLIProxyAPI hub
// that holds the Anthropic OAuth logins. Pi authenticates with a cpa_ client key.
export async function claudeCompatProxy(pi, { origin = process.env[PROXY_URL_ENV] } = {}) {
  const proxyOrigin = normalizeProxyOrigin(origin);
  await registerCompat(pi, {
    id: PROXY_PROVIDER, api: PROXY_API, label: "Claude Compat Proxy", modelSuffix: "[Compat Proxy]",
    authPolicy: `CLIProxyAPI key only (${proxyOrigin})`, proxyOrigin,
    auth: () => ({ apiKey: {
      name: "Claude Compat proxy key (cpa_…)",
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
    } })
  });
}

async function registerCompat(pi, { id, api, label, modelSuffix, authPolicy, auth, proxyOrigin }) {
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
  let uiContext;
  const showStatus = () => {
    uiContext?.ui.setStatus(statusKey, uiContext.model?.provider === id
      ? `${label.replace("Claude ", "")} active · ${DEFAULT_RECIPE.id} · ${state}` : `${label.replace("Claude ", "")} inactive — select ${label}`);
  };
  const wrap = (stream) => createFallbackStream(stream, createAssistantMessageEventStream, {
    strict: true,
    proxyOrigin,
    onState(value) {
      state = value;
      if (value === "checking") lastFailure = undefined;
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
  pi.on("session_start", (_event, ctx) => { state = "not sent"; lastFailure = undefined; update(_event, ctx); });
  pi.on("model_select", update);
  pi.registerCommand(command, {
    description: `Show ${label} routing and local validation status (no network request)`,
    handler: async (_args, ctx) => {
      update(undefined, ctx);
      ctx.ui.notify(`${label}: ${ctx.model?.provider === id ? "selected" : "not selected"}. ` +
        `Auth policy: ${authPolicy}. Profile: ${DEFAULT_RECIPE.id}. Last request: ${state}. ` +
        (lastFailure ? `Last failure: ${lastFailure}. ` : "") +
        "Local validation does not prove server acceptance. For missing-plugin protection launch with pi-claude-request-compat run.",
      lastFailure ? "error" : "info");
    }
  });
}
