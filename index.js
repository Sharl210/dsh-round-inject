/**
 * dsh-round-inject — Host half.
 *
 * Counts model invocations per session (every step that actually calls the
 * model counts once — user turns and tool-call steps alike) and periodically
 * injects a user-configured prompt as a model-visible user message.
 *
 * Two durable, log-safe mechanisms work together:
 *
 *   - Counting AND the injection bookmark ride the `sessionProjections` seam
 *     (the same mechanism the built-in `session-stats` plugin uses): the
 *     `round-inject` projection is a pure fold over the session event stream
 *     that derives {totalSteps, lastInjectSeq, sinceInject} from built-in
 *     events only — `step/end` advances the counters, and an injected
 *     `user/message` (identifiable by its `source: {kind:'plugin',
 *     plugin:'round-inject'}` marker) resets the "since last injection"
 *     counter. The registry checkpoints the fold into
 *     `<root>/session_projcache/`, so every value survives compaction,
 *     paging, session resume and host restarts.
 *
 *   - The bookmark is DERIVED STATE, never a custom log event: no
 *     round-inject-specific event type is ever appended, so restoring a
 *     session can never fail on this plugin's vocabulary (the 0.1.11 bug
 *     appended a custom `round-inject/committed` event, which the
 *     persistence layer rejects on restore — `assertEventsSupported`:
 *     unknown type, not ignorable, whole log refused).
 *
 * Injection timing (measured in completed model calls, the same "steps"
 * figure the GUI shows):
 *
 *   - with `injectOnStart` + `startPrompt`: the very first model call of a
 *     session carries the start prompt;
 *   - afterwards a periodic prompt is attached to the model call that comes
 *     exactly `interval` completed steps after the previous injection, i.e.
 *     injected calls sit at steps 1, 1+interval, 1+2·interval, …;
 *   - without a start prompt the periodic prompt rides steps interval,
 *     2·interval, 3·interval, …
 *
 * Because the bookmark lives inside the projection state (one O(1) fold per
 * event), the counter can never drift from the log and there is no full-log
 * scan on every step (the 0.1.13 crash was a per-step scan of
 * `session.events`, which is not an API of the session object — the public
 * surface is `session.snapshotEvents()`).
 */
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'round-inject'

/** Composition entry config; also the settings namespace base layer. */
export const Config = z.object({
  /** Master switch: when false the plugin counts nothing and injects nothing. */
  enabled: z.boolean().default(true),
  /**
   * How many completed model calls between two injections (conversation turns
   * and tool-call steps both count, exactly like the built-in "steps"
   * figure). With a start prompt the first injection is the session's first
   * call and the periodic counter starts from that call; without one the
   * periodic prompt first rides the `interval`-th call.
   */
  interval: z.number().step(1).min(1).max(100000).default(50),
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

/** True when an event is one of this plugin's own injected user messages. */
function isInjectedMessage(event) {
  if (event.type !== 'user/message') return false
  const source = event.data?.source
  return source?.kind === 'plugin' && source?.plugin === 'round-inject'
}

/**
 * Projection definition: a pure fold over the session event stream. It never
 * appends a custom event — it only consumes the built-in `step/end` and
 * `user/message` events, so restoring a session can never fail on this
 * plugin's vocabulary, and the registry's durable checkpoint keeps the state
 * across compaction/resume/restart.
 *
 * State:
 *   - `totalSteps`    — completed model calls (`step/end` count), the GUI
 *                       "steps" figure.
 *   - `lastInjectSeq` — seq of the last injected user message; -1 = this
 *                       session has never injected. Set when an injected
 *                       message is folded (its seq lands between the
 *                       injected step's `step/start` and `step/end`).
 *   - `sinceInject`   — completed model calls after `lastInjectSeq`
 *                       (the injected step's own completion counts as 1, so
 *                       the next injection fires on the call exactly
 *                       `interval` steps after the previous one).
 */
const projectionDefinition = {
  key: 'round-inject',
  stateVersion: 2,
  init: () => ({ totalSteps: 0, lastInjectSeq: -1, sinceInject: 0 }),
  apply: (state, event) => {
    switch (event.type) {
      case 'step/end':
        return {
          totalSteps: state.totalSteps + 1,
          lastInjectSeq: state.lastInjectSeq,
          sinceInject: state.lastInjectSeq >= 0 ? state.sinceInject + 1 : state.sinceInject,
        }
      case 'user/message':
        if (!isInjectedMessage(event)) return state
        // This injected message will itself be followed by its step/end, so
        // resetting sinceInject here makes that step the new counting origin.
        return { totalSteps: state.totalSteps, lastInjectSeq: event.seq, sinceInject: 0 }
      default:
        return state
    }
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

    // Decide inside a guard: an injection-decision bug must never take down
    // the whole agent step (the 0.1.13 regression surfaced as a per-step
    // "session.events is not iterable" and killed every turn).
    let text = null
    try {
      const session = agent.session
      const state = readProjectionState(session)
      if (state.lastInjectSeq < 0) {
        // No injection has happened in this session yet.
        if (hasStart) {
          // Conversation-start prompt rides the very first model call.
          text = cfg.startPrompt
        } else if (hasPeriodic && state.totalSteps + 1 >= cfg.interval) {
          // Start disabled/empty: the first periodic call is the
          // `interval`-th model call of the session.
          text = cfg.prompt
        }
      } else if (hasPeriodic && state.sinceInject >= cfg.interval) {
        // Periodic: the next model call is exactly `interval` completed
        // steps after the previous injection.
        text = cfg.prompt
      }
    } catch (error) {
      console.warn('[round-inject] injection decision failed; skipping injection', error)
      return decision
    }

    if (!text || signal.aborted) return decision

    return { ...decision, messages: [...decision.messages, makeInjected(text)] }
  })

  // ── helpers ──────────────────────────────────────────────────────────────
  /**
   * Current fold state for the agent's session. Primary source is the
   * projection registry (live fold, already driven to the log tail — cheap,
   * durable and consistent). When the registry is unavailable (minimal /
   * headless assemblies, or a session that predates the registry), fall back
   * to folding an immutable snapshot of the session log once. The snapshot
   * API is `session.snapshotEvents()` — `session.events` does not exist on
   * the session object (0.1.13 crashed on it).
   */
  function readProjectionState(session) {
    if (projections !== null && session !== undefined) {
      const state = projections.stateOf(session, 'round-inject')
      if (state !== undefined) return state
    }
    if (session === undefined || typeof session.snapshotEvents !== 'function') {
      return projectionDefinition.init()
    }
    let state = projectionDefinition.init()
    for (const event of session.snapshotEvents()) state = projectionDefinition.apply(state, event)
    return state
  }

  function makeInjected(prompt) {
    return createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: PLUGIN_SOURCE,
    })
  }
}
