# pi-claude-request-compat

[![npm version](https://img.shields.io/npm/v/pi-claude-request-compat?logo=npm)](https://www.npmjs.com/package/pi-claude-request-compat)
[![CI](https://github.com/vazzma/pi-claude-request-compat/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vazzma/pi-claude-request-compat/actions/workflows/ci.yml)
[![Security audit](https://github.com/vazzma/pi-claude-request-compat/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/vazzma/pi-claude-request-compat/actions/workflows/security.yml)
[![CodeQL](https://github.com/vazzma/pi-claude-request-compat/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/vazzma/pi-claude-request-compat/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/github/license/vazzma/pi-claude-request-compat)](LICENSE)

Use Anthropic OAuth in Pi through an explicit **Claude Compat** model selection. Keep Pi's tools and workflow—no Claude Code installation needed.

## Why this exists

A valid login is only part of the story: Claude Code's OAuth requests also carry specific headers, billing information, session metadata, and tool names. This extension adds those details using Pi's Anthropic transport. The dedicated provider rejects API keys, custom endpoints, redirects, and invalid request envelopes before sending a Messages request. Errors never retry through the ordinary Anthropic provider.

The idea and request behavior came from **oh-my-pi (omp)**—credit where it's due ([NOTICE](NOTICE)). This project builds on that work as a small extension for stock Pi, with automatic setup, a bundled compatibility profile that doesn't depend on your installed Claude version, and tests through the real Pi SDK. A separate comparison tool checks captured Claude requests and reports differences rather than assuming they match.

## Get started

```sh
pi install npm:pi-claude-request-compat
```

Requires Pi **0.87.1** and Node **22.19+**. Run `/login claude-compat` in Pi, then use `/model` to choose a **[Compat]** model. Pi manages this separate OAuth login and token refresh using its built-in Anthropic login flow.

**Upgrading from 0.1.3:** ordinary `anthropic` models are no longer patched. Select Claude Compat and log in once; existing Anthropic credentials are not copied.

Setup is automatic, including migration of older profiles. The credential-free profile lives at `~/.pi/agent/claude-request-compat/profile.json` (or under `PI_CODING_AGENT_DIR`).

The footer shows `Compat active`, the profile, and the last local validation state. If Anthropic rejects a Compat Messages request with HTTP 4xx, Pi immediately shows an error notification with the status and keeps `failed` in the footer—even if the transport later retries. Local validation and other provider errors also trigger an error notification. Review the failure before retrying; `/claude-compat-status` repeats the last reason. User cancellations do not trigger this alert. `pi-claude-request-compat doctor` checks the local profile.

### Prevent missing-plugin fallback

Pi can fall back to another provider when a saved model disappears. For a startup that fails if Compat is unavailable, use explicit selection:

```sh
pi --provider claude-compat --model claude-opus-4-8
# Equivalent convenience launcher (CLI must be on PATH):
pi-claude-request-compat run
pi-claude-request-compat run --model claude-opus-4-8 -- --continue
```

This pins the startup model, including resumed sessions. Starting plain `pi` with only a saved default does **not** provide missing-plugin protection. You can still deliberately select another provider during a session. Requests still consume subscription usage; this is not a spending cap.

## Proxy mode (cartwmic fork)

This fork adds a second, separate provider, **Claude Compat Proxy** (`claude-compat-proxy`), for a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub that holds the Anthropic OAuth logins. The default `claude-compat` provider is unchanged.

- The request is the same validated Claude Code request, so the hub sees a native Claude Code client and passes it through.
- Pi authenticates to the hub with a CLIProxyAPI client key (`cpa_…`). Anthropic tokens and API keys are rejected.
- Only the configured origin is accepted: HTTPS, or HTTP on loopback (an SSH tunnel). No redirects.
- The Anthropic account bootstrap call is skipped, because the hub owns the account. `metadata.user_id` has no `account_uuid`.
- Pi still builds the OAuth request layout. It receives an inert marker token for that, and the fetch wrapper swaps in the proxy key. The marker never leaves the process.

The proxy provider is not loaded by default. Call it from your own extension:

```js
import { claudeCompatProxy } from "pi-claude-request-compat/src/extension.js";
export default (pi) => claudeCompatProxy(pi, { origin: "https://cliproxy.example.internal" });
```

The key comes from a stored credential (`/login claude-compat-proxy`), a `models.json` `apiKey` for `claude-compat-proxy`, or `PI_CLAUDE_COMPAT_PROXY_KEY`. The origin can also come from `PI_CLAUDE_COMPAT_PROXY_URL`. `/claude-compat-proxy-status` shows the last local validation.


## Developer checks

```sh
npm ci
npm test
# Compare with a specific Claude executable:
npm run compat:check -- --claude-version 2.1.282 --claude /path/to/claude
```

See [the comparison guide](https://github.com/vazzma/pi-claude-request-compat/blob/main/compat/README.md) for offline replay and capture details. The checked-in Claude 2.1.156 reference currently reports **DIFF**; passing unit tests does not mean matching Claude requests.

## Security and transparency

- CodeQL, weekly dependency audits, signature checks, and Dependabot update PRs.
- Commit-pinned workflow actions and [npm releases with signed provenance](https://www.npmjs.com/package/pi-claude-request-compat).
- Pi manages your login. The extension uses your token in memory for Anthropic requests and account lookup; it stores no credentials in its profile and has no telemetry endpoint of its own.

[Security policy](https://github.com/vazzma/pi-claude-request-compat/blob/main/SECURITY.md) · [Report a vulnerability privately](https://github.com/vazzma/pi-claude-request-compat/security/advisories/new). Badges show check results, not a security certification.

## Limits

The bundled profile (`oauth-wire-v1`, reference **2.1.282**) follows request behavior studied from omp. It is not proven 1:1 Claude Code compatibility. Tests use the real Pi SDK, but Claude captures use synthetic credentials and a local gateway—not live Anthropic acceptance.

Pi keeps its own prompts and agent behavior. If Anthropic rejects the bundled version, the extension needs an update. Subscription use remains subject to Anthropic's terms.
