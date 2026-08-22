/**
 * dsh-round-inject — Host half.
 *
 * Counts model invocations per session (every step that actually calls the
 * model counts once — user turns and tool-call steps alike) and periodically
 * injects a user-configured prompt as a model-visible user message.
 *
 * Two durable, log-safe mechanisms work together:
 *
 *   - Counting rides the `sessionProjections` seam (the same mechanism the
 *     built-in `session-stats` plugin uses): the `round-inject` projection is
 *     a pure fold that counts every `step/end` into `totalSteps`, and the
 *     registry checkpoints it into `<root>/session_projcache.json`. The count
 *     therefore survives compaction, paging, session resume and restarts.
 *
 *   - The injection bookmark is DERIVED FROM THE SESSION LOG, never written
 *     as a custom event: every injected prompt is itself a durable
 *     `user/message` event carrying `source: { kind: 'plugin', plugin:
 *     'round-inject' }` (a known, persistable event type). "Steps since the
 *     last injection" = the number of `step/end` events after the last such
 *     injected message. This is per-session by construction (each session
 *     has its own log), survives compaction/resume/restart, and never
 *     touches the event-type vocabulary — the 0.1.11 bug appended a custom
 *     `round-inject/committed` event, which the persistence layer rejects on
 *     restore (`assertEventsSupported`: unknown type, not ignorable, whole
 *     log refused), so a restart bricked every session that had injected.
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
   * `injectOnStart`; afterwards the per-session log-derived counter restarts
   * from the last injected step.
   */
  interval: z.number().step(1).min(1).max(100000).default(80),
  /**
   * Periodic prompt: injected every `interval` model invocations (the second
   * input box). Empty ⇒ periodic injection is disabled (only the
   * conversation-start prompt, if any, is used).
   */
  prompt: z.string().default(''),
  /**
   * Conversation-start prompt: injected once at the start of a new
   * conversation (the first input box). Empty ⇒ no start injection.
   * Independent from `prompt`: the start injection uses ONLY this text, the
   * periodic injection uses ONLY `prompt`.
   */
  startPrompt: z.string().default(''),
  /** Whether the conversation-start injection happens at all. */
  injectOnStart: z.boolean().default(true),
})

/** The `{kind:'plugin'}` source stamped on every injected message. */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'round-inject' })

/**
 * Projection definition: a pure fold over the session event stream that
 * counts completed model calls. No custom event types are ever appended —
 * the fold only consumes built-in `step/end` events, so restoring a session
 * can never fail on this plugin's vocabulary.
 */
const projectionDefinition = {
  key: 'round-inject',
  stateVersion: 1,
  init: () => ({ totalSteps: 0 }),
  apply: (state, event) => {
    if (event.type !== 'step/end') return state
    return { totalSteps: state.totalSteps + 1 }
  },
}

export function apply(ctx, config) {
  let readConfig = () => config ?? {}
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('round-inject', Config, { base: config })
    readConfig = () => scope.get() ?? {}
  })

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
    if (!cfg.enabled) return decision
    // Nothing to inject: both prompts empty (or start disabled and periodic empty).
    const hasStart = cfg.injectOnStart && cfg.startPrompt
    const hasPeriodic = cfg.prompt
    if (!hasStart && !hasPeriodic) return decision

    const session = agent.session

    // Current completed model calls from the durable projection (fallback to
    // an in-memory count when the projection registry is absent).
    let totalSteps
    if (projections !== null && session !== undefined) {
      totalSteps = projections.stateOf(session, 'round-inject')?.totalSteps ?? 0
    } else {
      totalSteps = memorySteps(agent)
    }

    // Steps since the last injection, derived from the session log: find the
    // last injected user message and count the step/end events after it.
    // `null` means no injection has happened in this session yet.
    const since = stepsSinceLastInject(session)

    let text = null
    if (since === null) {
      // No injection yet in this session → conversation-start prompt.
      if (hasStart) {
        text = cfg.startPrompt
      } else if (hasPeriodic) {
        // start disabled/empty: fire the first periodic one once `interval`
        // calls elapsed from the start of the session.
        if (totalSteps >= cfg.interval) text = cfg.prompt
      }
    } else {
      // Periodic: inject when `interval` model calls have elapsed since the
      // last injection.
      if (hasPeriodic && since >= cfg.interval) text = cfg.prompt
    }

    if (text === null || signal.aborted) return decision

    return { ...decision, messages: [...decision.messages, makeInjected(text)] }
  })

  // ── helpers ──────────────────────────────────────────────────────────────
  const memoryCounts = new WeakMap()
  function memorySteps(agent) {
    const n = (memoryCounts.get(agent) ?? 0) + 1
    memoryCounts.set(agent, n)
    return n
  }

  /**
   * Log-derived bookmark: count `step/end` events after the last injected
   * user message in this session's log. The injected messages are durable
   * `user/message` events with the plugin source marker — a built-in,
   * persistable vocabulary — so this never writes custom events and survives
   * compaction/resume/restart (the log and its sources are replayed).
   * Returns null when no injection has happened yet in this session.
   */
  function stepsSinceLastInject(session) {
    if (session === undefined) return null
    let lastInjectSeq = -1
    for (const ev of session.events) {
      if (ev.type !== 'user/message') continue
      const src = ev.data?.source
      if (src?.kind === 'plugin' && src?.plugin === 'round-inject') lastInjectSeq = ev.seq
    }
    if (lastInjectSeq === -1) return null

    let steps = 0
    for (const ev of session.events) {
      if (ev.seq <= lastInjectSeq) continue
      if (ev.type === 'step/end') steps += 1
    }
    return steps
  }

  function makeInjected(prompt) {
    return createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: PLUGIN_SOURCE,
    })
  }
}
