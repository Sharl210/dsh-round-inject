/**
 * dsh-round-inject — Host half.
 *
 * Counts model invocations per session (every step that actually calls the
 * model counts once — user turns and tool-call steps alike) and periodically
 * injects a user-configured prompt as a model-visible user message.
 *
 * Counting and the injection bookmark both ride the durable
 * `sessionProjections` seam — the same mechanism the built-in
 * `session-stats` plugin uses for its "N 轮 · M 步" line:
 *
 *   - the `round-inject` projection is a pure fold over the session event
 *     stream. `step/end` (each completed model call) increments
 *     `totalSteps`; a plugin-appended `round-inject/committed` event records
 *     `lastInjectStep`. The registry checkpoints that state into
 *     `<root>/session_projcache.json`, so BOTH values survive compaction,
 *     paging, session resume and host restarts.
 *   - Both values are per-session (the projection cell is keyed by session),
 *     so two sessions never share a bookmark — the 0.1.9 bug stored
 *     `lastInjectStep` in the global settings namespace, so a long session's
 *     bookmark (e.g. 315) leaked into every other session and their counters
 *     (e.g. 11) could never reach it, silently disabling injection.
 *
 * Injection is a side effect on `agent/pre-step`: it reads the projected
 * `totalSteps` and `lastInjectStep`, and on a fire appends the prompt as a
 * user message and records the bookmark via `round-inject/committed`.
 */
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'round-inject'

/** Composition entry config; also the settings namespace base layer. */
export const Config = z.object({
  /** Master switch: when false the plugin counts nothing and injects nothing. */
  enabled: z.boolean().default(true),
  /**
   * How many model invocations between two injections. Every completed step
   * counts (conversation turns and tool-call steps alike), exactly like the
   * built-in "steps" figure. The first injection is governed by
   * `injectOnStart`; afterwards the durable per-session step counter
   * restarts from the last injected step.
   */
  interval: z.number().step(1).min(1).max(100000).default(80),
  /** The prompt text injected as a user message. Empty ⇒ nothing is injected. */
  prompt: z.string().default(''),
  /** Whether the first injection happens at conversation start. */
  injectOnStart: z.boolean().default(true),
})

/** The `{kind:'plugin'}` source stamped on every injected message. */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'round-inject' })

/** Session event type the plugin appends to record an injection. */
const COMMITTED_EVENT = 'round-inject/committed'

/**
 * Projection definition: a pure fold over the session event stream.
 * State is per-session (the registry keys cells by session), so different
 * sessions never share a bookmark. Persisted by the sessionProjections
 * registry, so compaction/resume cannot reset it.
 */
const projectionDefinition = {
  key: 'round-inject',
  stateVersion: 2,
  init: () => ({ totalSteps: 0, lastInjectStep: null }),
  apply: (state, event) => {
    // A step/end marks one completed model call — the same event the
    // built-in session-stats fold uses for its "steps" figure.
    if (event.type === 'step/end') {
      return { ...state, totalSteps: state.totalSteps + 1 }
    }
    // The plugin appends this after an injection to persist the bookmark
    // durably (per session). Unknown events pass through untouched.
    if (event.type === COMMITTED_EVENT) {
      const step = event.data?.totalSteps
      if (typeof step !== 'number' || !Number.isFinite(step)) return state
      return { ...state, lastInjectStep: step }
    }
    return state
  },
}

export function apply(ctx, config) {
  // ── settings ─────────────────────────────────────────────────────────────
  // User-facing config only (enabled / interval / prompt / injectOnStart).
  // The injection bookmark lives in the per-session projection, NOT here —
  // a global bookmark leaks across sessions and disables injection in every
  // session whose counter has not caught up (0.1.9 bug).
  let readConfig = () => config ?? {}
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('round-inject', Config, { base: config })
    readConfig = () => scope.get() ?? {}
  })

  // ── projection registry ──────────────────────────────────────────────────
  // Register the durable per-session counter + bookmark. The registry drives
  // it over every committed session event and checkpoints the state; headless
  // assemblies without the registry fall back to in-memory counting.
  let projections = null
  ctx.inject(['sessionProjections'], (sctx) => {
    projections = sctx.sessionProjections
    sctx.sessionProjections.register(projectionDefinition)
  })

  // ── injection ────────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision

    // A step that does not actually call the model never injects (an empty
    // message set closes the turn without a model call).
    if (decision.messages.length === 0) return decision

    const cfg = readConfig()
    if (!cfg.enabled || !cfg.prompt) return decision

    const session = agent.session

    // Read the durable per-session counter from the projection. Without a
    // projection registry, fall back to an in-memory per-agent counter so
    // the plugin still works on minimal assemblies.
    let totalSteps, lastInjectStep
    if (projections !== null && session !== undefined) {
      const state = projections.stateOf(session, 'round-inject')
      totalSteps = state?.totalSteps ?? 0
      lastInjectStep = state?.lastInjectStep ?? null
    } else {
      totalSteps = memorySteps(agent)
      lastInjectStep = memoryBookmark(agent)
    }

    // Conversation start: inject once when enabled, and record the bookmark
    // so the durable counter takes over from here.
    if (lastInjectStep === null) {
      if (cfg.injectOnStart && !signal.aborted) {
        commit(agent, session, totalSteps)
        return { ...decision, messages: [...decision.messages, makeInjected(cfg.prompt)] }
      }
      commit(agent, session, totalSteps)
      return decision
    }

    // Periodic: inject when `interval` model calls have elapsed since the
    // last injection.
    if (totalSteps - lastInjectStep >= cfg.interval) {
      if (!signal.aborted) {
        commit(agent, session, totalSteps)
        return { ...decision, messages: [...decision.messages, makeInjected(cfg.prompt)] }
      }
      commit(agent, session, totalSteps)
      return decision
    }

    return decision
  })

  // ── helpers ──────────────────────────────────────────────────────────────
  // Fallback in-memory counter/bookmark (used only when sessionProjections is
  // absent). Not durable, but keeps headless/minimal assemblies functional.
  const memoryCounts = new WeakMap()
  const memoryMarks = new WeakMap()
  function memorySteps(agent) {
    const n = (memoryCounts.get(agent) ?? 0) + 1
    memoryCounts.set(agent, n)
    return n
  }
  function memoryBookmark(agent) {
    return memoryMarks.get(agent) ?? null
  }

  /** Record an injection's bookmark (projection event or in-memory fallback). */
  function commit(agent, session, totalSteps) {
    if (projections !== null && session !== undefined) {
      // Append a custom session event; the projection's apply folds it into
      // the per-session bookmark and the registry persists the checkpoint.
      session.append(COMMITTED_EVENT, { totalSteps })
    } else {
      memoryMarks.set(agent, totalSteps)
    }
  }

  function makeInjected(prompt) {
    return createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: PLUGIN_SOURCE,
    })
  }
}
