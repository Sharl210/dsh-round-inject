# dsh-round-inject

Periodic prompt injection for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

Every N model invocations — **conversation turns and tool-call steps each count as one** — the plugin injects a user-configured prompt into the model context as a model-visible, source-attributed user message. The first injection happens at conversation start.

| | |
| --- | --- |
| Host | `agent/pre-step` waterfall (counts every entering step, appends the injected message to that step's request) |
| Client | one Settings page with an input box + round interval (default **80**) |
| Config | `round-inject` settings namespace, persisted by the DSH settings provider |

## Features

- **Round counting** — every model invocation counts once, including steps triggered by tool results (a tool call is followed by another model call = another step). Counting rides the durable `sessionProjections` seam (the same mechanism the built-in "N 轮 · M 步" stats line uses): the counter is a persisted projection per session, so **compaction, paging, session resume and host restarts cannot reset it**.
- **Periodic injection** — when the durable counter reaches the configured interval (default **80**), the periodic prompt is appended to that step's messages. The injected message carries `source: { kind: 'plugin', plugin: 'round-inject' }`, is persisted to the session log, and is visible to the model.
- **Two independent prompts** — the conversation-start prompt (first input box) and the periodic prompt (second input box) are separate: the start injection uses only the start prompt, the periodic injection uses only the periodic prompt. Either can be left empty to disable that side.
- **Inject at conversation start** — when enabled and the start prompt is non-empty, each new conversation injects the start prompt once (does not consume a round), then the interval restarts.
- **Settings UI with Save button** — Settings → **提示词注入**: enable switch, interval (number input, default 80), conversation-start prompt (first textarea), periodic prompt (second textarea), and an "inject at conversation start" switch. All edits are draft-only; a **Save** button (bottom-right) commits the whole form to the settings namespace at once. Nothing is written until the user clicks Save. IME composition is protected (Chinese input never pollutes the form).
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

The plugin uses two halves that share one durable counter:

1. **Durable counting (projection)** — the plugin registers a `round-inject`
   projection on the `sessionProjections` seam. The projection is a pure fold
   over the session event stream: every `step/end` (one completed model call,
   the same event the built-in "N 轮 · M 步" line counts) increments
   `totalSteps`. The registry checkpoints the state into
   `<root>/session_projcache.json`, so the count survives compaction, paging,
   session resume and host restarts — this is what makes the interval
   reliable over long agent runs (the 0.1.8 and earlier in-memory WeakMap
   counter could be silently reset by a compact/resume, causing "injected
   only once").
2. **Injection (side effect)** — the plugin listens to the `agent/pre-step`
   waterfall (one event per proposed step). After `next()` yields the loop's
   own decision, it:
   - ignores `reject` decisions and steps with an empty message set (those never call the model);
   - reads the latest config from the `round-inject` namespace;
   - reads the projected `totalSteps` and compares it against the last
     injected step number, which is persisted as `lastInjectStep` in the
     settings namespace (hidden from the UI form);
   - on conversation start (`lastInjectStep` unset) injects once when
     `injectOnStart` is on and records the current step as the bookmark;
   - otherwise, when `totalSteps - lastInjectStep >= interval`, appends
     `createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'round-inject' } })` to the step's messages and advances the bookmark.

Because the injected message becomes part of the step's durable user messages, it is model-visible, audit-able in the session log, and works with any model route.

### KV cache note

An injection changes the request content at the injected step, so provider KV/prefix cache is invalidated from that request onward for one turn's worth of steps. With the default interval of 80 this is negligible; lowering the interval increases invalidation frequency.

### IME input: pinyin/kana never pollute settings, Chinese typing works (0.1.8)

The settings inputs (prompt textarea, interval number) use a **local draft** plus a composition gate:

- `onChange` always updates the local draft, so the controlled field keeps
  following the user's keystrokes — typing is never swallowed, committed
  Chinese characters stay on screen.
- Settings writes are skipped while the IME is composing
  (`onCompositionStart` … `onCompositionEnd`, plus `nativeEvent.isComposing`),
  so uncommitted pinyin/kana never reach the settings namespace (the original
  "输入法拼音被记录" bug).
- `onCompositionEnd` writes the final committed value (the DOM value at that
  moment, i.e. the selected hanzi/kana) once.

Version history:
- 0.1.7 regressed: `onChange` was fully ignored during composition, which froze
  the React controlled value at the stale snapshot; the next render then reset
  the field and swallowed the committed Chinese characters ("选完字上不了屏").
- 0.1.8 (current) fixes this with the local-draft approach above.

Related upstream DSH issue (chat composer): clicking the Send button while composing submitted the uncommitted pinyin — the Enter path already guarded, the button path did not. See `docs/dsh-composer-ime-patch.md` for the one-line upstream patch.

## Troubleshooting

### DSH shared host packages are `peerDependencies` (0.1.6)

The plugin declares every DSH-provided runtime package (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/schemastery`) as `peerDependencies` — **not** `dependencies`. DSH installs a shared host-package directory (`~/.dsh/profiles/node_modules/@deepseek-ai/`) with symlinks to the exact host versions, so plugins must resolve those packages through the host, never via a self-installed copy.

Before 0.1.6 the plugin shipped `dsh-llm` in `dependencies`, which made pnpm hoist a separate `dsh-llm@0.1.0-rc.8` into the profile root. Node resolution then picked that copy over the host's shared symlink, so the plugin ran against a **different `dsh-llm` instance** than the host (host: `0.1.1-rc.2`). The two versions had identical `createUserMessage` signatures, so it worked by luck — but any API drift would break silently. Symptom to look for: `require.resolve('@deepseek-ai/dsh-llm/package.json')` from the profile resolves to `profiles/web/node_modules/...` instead of the host install. After updating to 0.1.6, run `pnpm install` in the profile so the stale hoisted copy is pruned, then verify it resolves to the host:

```sh
cd ~/.dsh/profiles/web
pnpm add "dsh-round-inject@0.1.6"   # prunes the old hoisted dsh-llm copy
node -p "require.resolve('@deepseek-ai/dsh-llm/package.json')"  # → host path, not profiles/web/node_modules
```

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
