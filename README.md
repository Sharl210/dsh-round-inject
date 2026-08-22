# dsh-round-inject

Periodic prompt injection for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

Every N model invocations — **conversation turns and tool-call steps each count as one** — the plugin injects a user-configured prompt into the model context as a model-visible, source-attributed user message. The first injection happens at conversation start.

| | |
| --- | --- |
| Host | `agent/pre-step` waterfall (counts every entering step, appends the injected message to that step's request) |
| Client | one Settings page with an input box + round interval (default **80**) |
| Config | `round-inject` settings namespace, persisted by the DSH settings provider |

## Features

- **Round counting** — every model invocation counts once, including steps triggered by tool results (a tool call is followed by another model call = another step). The counter is per agent (main session and subagents are isolated).
- **Periodic injection** — when the counter reaches the configured interval (default **80**), the configured prompt is appended to that step's messages. The injected message carries `source: { kind: 'plugin', plugin: 'round-inject' }`, is persisted to the session log, and is visible to the model.
- **Inject at conversation start** — each new conversation injects once immediately (does not consume a round), then the interval restarts.
- **Settings UI** — Settings → **提示词注入**: enable switch, interval (number input, default 80), prompt text (multi-line input), and an "inject at conversation start" switch. Writes go through the standard `settingsScope` service to the `round-inject` namespace (persisted in the DSH settings document).
- **Safe by default** — empty prompt ⇒ nothing is injected; disabled ⇒ no counting and no injection; a step that does not actually call the model is never counted.

## Install

The package is a DSH plugin published to npm. From a DSH profile directory:

```sh
dsh plugin --profile web add dsh-round-inject
```

or add it manually to the profile's `package.json` dependencies and append `"dsh-round-inject"` to `dsh.profile.bundles`, then restart the profile.

### Configuration

The composition row (also the settings namespace base layer):

```yaml
- id: round-inject
  name: 'dsh-round-inject'
  config:
    enabled: true        # master switch
    interval: 80         # model invocations between two injections
    prompt: ''           # injected prompt text (empty ⇒ no injection)
    injectOnStart: true  # inject once at conversation start
```

All values can be changed live from Settings → 提示词注入 without a restart.

## How it works

The plugin listens to the `agent/pre-step` waterfall (one event per proposed step = one model call). After `next()` yields the loop's own decision, the plugin:

1. ignores `reject` decisions and steps with an empty message set (those never call the model);
2. reads the latest config from the `round-inject` namespace;
3. counts: the first step of a conversation injects once when `injectOnStart` is on; afterwards the counter increments per entering step and fires when it reaches `interval`;
4. on a fire, appends `createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'round-inject' } })` to the step's messages.

Because the injected message becomes part of the step's durable user messages, it is model-visible, audit-able in the session log, and works with any model route.

### KV cache note

An injection changes the request content at the injected step, so provider KV/prefix cache is invalidated from that request onward for one turn's worth of steps. With the default interval of 80 this is negligible; lowering the interval increases invalidation frequency.

## Troubleshooting

### "设置服务不可用" / settings inputs not editable / namespace missing

Symptom: the Settings page renders but shows "设置服务不可用,当前仅使用组合配置默认值", or the inputs are disabled/unfocusable, or `settings.describe` does not list the `round-inject` namespace.

Root cause (fixed in **0.1.5**): the host plugin read its composition config via `ctx.config`. Cordis 4 guards property access on the context — reading `ctx.config` without declaring `inject: ['config']` throws (`cannot get property "config" without inject`), so the host `apply()` failed on load. The client page still rendered independently (it is a separate bundle), which made the failure look like a settings-service issue. The fix reads config from the second `apply(ctx, config)` argument (the loader passes the resolved entry config there), and registers the settings namespace with that config as its base layer.

If you still see the symptom after updating to 0.1.5, verify:

```sh
# 1. the profile actually resolved 0.1.5 (pnpm autoInstallPeers=false can leave stale peers)
cd ~/.dsh/profiles/web && node -p "require('dsh-round-inject/package.json').version"
# 2. the namespace is registered (from the running instance)
#    settings.describe should include round-inject
# 3. restart the profile after the upgrade — host plugins load at startup
```

### "loaded without registering \"dsh-round-inject\" via __ModuleLoader__.load"

The client bundle must register the exact npm package name (`dsh-round-inject`) as its module id — client-modules serves `/plugins/<pkg>/client.js` and verifies the bundle registers that exact id. Current `client.js` uses `id: 'dsh-round-inject'`. Reinstall and hard-refresh the page (the client bundle is cache-busted by a `?rev=` query).

## Development

```
├── index.js       # Host half (ESM; settings registration + session-start reset + pre-step counting/injection)
├── client.js      # Browser half (Settings page; __ModuleLoader__.load factory, no build step)
├── cordis.patch.yml
└── package.json
```

No build step — both halves are hand-authored ESM/browser factories (same pattern as `dsh-strata`). Publish with:

```sh
npm publish
```

## License

MIT
