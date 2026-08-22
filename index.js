/**
 * dsh-round-inject — Host half.
 *
 * Counts model invocations per session (every step that actually calls the
 * model counts once — user turns and tool-call steps alike) and periodically
 * injects a user-configured prompt as a model-visible user message.
 *
 * Counting rides the durable `sessionProjections` seam (the same mechanism
 * the built-in `session-stats` plugin uses for its "N 轮 · M 步" line):
 *
 *   - the `round-inject` projection is a pure fold that counts every
 *     `step/end` event (each complete model call) into `totalSteps`. The
 *     registry checkpoints that state into `<root>/session_projcache.json`,
 *     so the count survives compaction, paging, session resume and even a
 *     host restart — unlike an in-memory WeakMap, which a compact/resume
 *     could silently reset (the "只注入一次" bug).
 *   - injection is a side effect on `agent/pre-step`: it reads the projected
 *     `totalSteps` and compares it against the last injected step number,
 *     which is persisted in the `round-inject` settings namespace, so the
 *     interval restarts from the durable position, not from zero.
 *
 * The injected message becomes part of that step's durable user messages —
 * model-visible, source-attributed (`plugin: round-inject`), and
 * reconstructable from the session log.
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
   * `injectOnStart`; afterwards the durable step counter restarts from the
   * last injected step.
   */
  interval: z.number().step(1).min(1).max(100000).default(80),
  /** The prompt text injected as a user message. Empty ⇒ nothing is injected. */
  prompt: z.string().default(''),
  /** Whether the first injection happens at conversation start. */
  injectOnStart: z.boolean().default(true),
  /**
   * Durable bookmark: the `totalSteps` value at the last injection. Stored in
   * the settings namespace (hidden from the UI form) so the interval restarts
   * from a position that survives compaction/resume/restart. Reset to null on
   * conversation start (injectOnStart) or by the user via the UI.
   */
  lastInjectStep: z.number().int().min(0).nullable().default(null),
})

/** The `{kind:'plugin'}` source stamped on every injected message. */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'round-inject' })

/**
 * Projection definition: a pure fold over the session event stream that
 * counts completed model calls. Persisted by the sessionProjections registry
 * (durable checkpoint), so compaction/resume cannot reset it.
 */
const projectionDefinition = {
  key: 'round-inject',
  stateVersion: 1,
  init: () => ({ totalSteps: 0 }),
  apply: (state, event) => {
    // A step/end marks one completed model call — the same event the
    // built-in session-stats fold uses for its "steps" figure.
    if (event.type !== 'step/end') return state
    return { totalSteps: state.totalSteps + 1 }
  },
}

export function apply(ctx, config) {
  // ── settings ─────────────────────────────────────────────────────────────
  // Register the namespace when the settings service is mounted. The scope
  // holds the live config AND the durable lastInjectStep bookmark. Without
  // the settings service (headless), fall back to the entry config alone and
  // keep the bookmark in-memory per process.
  let readConfig = () => config ?? {}
  let persistBookmark = (step) => {}
  let readBookmark = () => config?.lastInjectStep ?? null
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('round-inject', Config, { base: config })
    readConfig = () => scope.get() ?? {}
    readBookmark = () => scope.get()?.lastInjectStep ?? null
    persistBookmark = (step) => {
      const current = scope.get() ?? {}
      if (current.lastInjectStep === step) return
      void scope.update({ lastInjectStep: step })
    }
  })

  // ── projection registry ──────────────────────────────────────────────────
  // Register the durable step counter. The registry drives it over every
  // committed session event and checkpoints the state; headless assemblies
  // without the registry are simply skipped.
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

    // Read the durable total-step counter from the projection (compaction and
    // resume cannot reset it). Without a projection registry, fall back to
    // the in-memory count so the plugin still works on minimal assemblies.
    let totalSteps
    if (projections !== null && agent.session !== undefined) {
      const state = projections.stateOf(agent.session, 'round-inject')
      totalSteps = state?.totalSteps ?? 0
    } else {
      totalSteps = memorySteps(agent)
    }

    const lastInjectStep = readBookmark()

    // Conversation start: inject once when enabled, and restart the interval
    // from this step so the durable counter takes over from here.
    if (lastInjectStep === null) {
      if (cfg.injectOnStart && !signal.aborted) {
        persistBookmark(totalSteps)
        return { ...decision, messages: [...decision.messages, makeInjected(cfg.prompt)] }
      }
      persistBookmark(totalSteps)
      return decision
    }

    // Periodic: inject when `interval` model calls have elapsed since the
    // last injection.
    if (totalSteps - lastInjectStep >= cfg.interval) {
      if (!signal.aborted) {
        persistBookmark(totalSteps)
        return { ...decision, messages: [...decision.messages, makeInjected(cfg.prompt)] }
      }
      persistBookmark(totalSteps)
      return decision
    }

    return decision
  })

  // ── helpers ──────────────────────────────────────────────────────────────
  // Fallback in-memory step counter (used only when sessionProjections is
  // absent). Keyed per agent object; not durable, but keeps headless/minimal
  // assemblies functional.
  const memoryCounts = new WeakMap()
  function memorySteps(agent) {
    const n = (memoryCounts.get(agent) ?? 0) + 1
    memoryCounts.set(agent, n)
    return n
  }

  function makeInjected(prompt) {
    return createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: PLUGIN_SOURCE,
    })
  }
}
