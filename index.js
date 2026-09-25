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

/**
 * Services this plugin reads off the context. Cordis guards property access:
 * reading `ctx.sessionProjections` without declaring it throws
 * `cannot get property "sessionProjections" without inject` and the whole
 * plugin fails to mount. The built-in folds declare it the same way
 * (`dsh-agent-instructions`: `const inject = ["sessionProjections"]`).
 */
export const inject = ['sessionProjections']

/** Composition entry config; also the settings namespace base layer. */
export const Config = z.object({
  /** Master switch: when false the plugin counts nothing and injects nothing. */
  enabled: z.boolean().default(true).volatile(),
  /**
   * How many completed model calls between two injections (conversation turns
   * and tool-call steps both count, exactly like the built-in "steps"
   * figure). With a start prompt the first injection is the session's first
   * call and the periodic counter starts from that call; without one the
   * periodic prompt first rides the `interval`-th call.
   */
  interval: z.number().step(1).min(1).max(100000).default(50).volatile(),
  /**
   * Periodic prompt: injected every `interval` model invocations (the second
   * input box). Empty ⇒ periodic injection is disabled (only the
   * conversation-start prompt, if any, is used).
   */
  prompt: z.string().default('').volatile(),
  /**
   * Conversation-start prompt: injected once at the start of a new
   * conversation (the first input box). Empty ⇒ no start injection.
   * Independent from `prompt`: the start injection uses ONLY this text, the
   * periodic injection uses ONLY `prompt`.
   */
  startPrompt: z.string().default('').volatile(),
  /** Whether the conversation-start injection happens at all. */
  injectOnStart: z.boolean().default(true).volatile(),
})

/** The producer kind stamped on every injected message. */
const PRODUCER_KIND = 'plugin:round-inject'

/**
 * Source stamped on every injected message. DSH's session format v4 requires a
 * producer-owned kind: the released `{ kind: 'plugin', plugin: '<name>' }`
 * wrapper is refused outright ("format v4 message requires a producer-owned
 * source kind"), and the framework's own converter maps a third-party plugin
 * name to `plugin:<name>` — so the flat kind is both the accepted spelling and
 * the one old sessions are rewritten to.
 */
const PLUGIN_SOURCE = Object.freeze({ kind: PRODUCER_KIND })

/** True when an event is one of this plugin's own injected user messages. */
function isInjectedMessage(event) {
  if (event.type !== 'user/message') return false
  const source = event.data?.source
  if (source?.kind === PRODUCER_KIND) return true
  // Sessions written by earlier releases carry the retired wrapper; keep
  // recognising them so an existing conversation's bookmark still folds.
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
 *                       "steps" figure. Counted unconditionally: the
 *                       counter must advance even before the first injection,
 *                       which is what makes the first periodic injection land
 *                       on the `interval`-th call.
 *   - `lastInjectSeq` — seq of the last injected user message; -1 = this
 *                       session has never injected.
 *   - `lastInjectStep`— `totalSteps` at the moment of the last injection; -1 =
 *                       never. This is the scheduling origin for the periodic
 *                       prompt, stored as a STEP COUNT rather than a boolean,
 *                       so the interval arithmetic works from the very first
 *                       call instead of only after an injection has happened.
 *   - `sinceInject`   — completed model calls since `lastInjectStep`, i.e.
 *                       `totalSteps - lastInjectStep` (maintained
 *                       incrementally; kept as its own field because the
 *                       checkpoint schema is additive).
 */
const projectionDefinition = {
  key: 'round-inject',
  stateVersion: 3,
  init: () => ({ totalSteps: 0, lastInjectSeq: -1, lastInjectStep: -1, sinceInject: 0 }),
  apply: (state, event) => {
    switch (event.type) {
      case 'step/end': {
        const totalSteps = state.totalSteps + 1
        return {
          totalSteps,
          lastInjectSeq: state.lastInjectSeq,
          lastInjectStep: state.lastInjectStep,
          // Distance from the origin, counted in completed steps. Before any
          // injection the origin is -1 ("one step before the first call"), so
          // this reads `totalSteps + 1` and the first periodic prompt rides
          // the `interval`-th call; afterwards it is the plain distance from
          // the last injection, keeping later injections exactly `interval`
          // steps apart. One arithmetic, no special case, no stalling.
          sinceInject: totalSteps - state.lastInjectStep,
        }
      }
      case 'user/message':
        if (!isInjectedMessage(event)) return state
        // The injected message is followed by its own step/end; anchoring the
        // origin on the steps completed so far makes that step the first of
        // the next interval.
        return {
          totalSteps: state.totalSteps,
          lastInjectSeq: event.seq,
          lastInjectStep: state.totalSteps,
          sinceInject: 0,
        }
      default:
        return state
    }
  },
}

export function apply(ctx, config) {
  // Config fields are declared `.volatile()`, so each one parses into a stable
  // reference read with `.get()`: DSH 0.1.7's settings document updates the
  // reference in place, giving live edits without re-applying the plugin. The
  // old `settings.register()` / `settingsScope` pair no longer exists, and the
  // plugin registers no settings namespace of its own — the framework projects
  // every volatile field of a live entry into a form, read by entry id.
  const readConfig = () => ({
    enabled: config?.enabled?.get?.() ?? config?.enabled ?? true,
    interval: config?.interval?.get?.() ?? config?.interval ?? 50,
    prompt: config?.prompt?.get?.() ?? config?.prompt ?? '',
    startPrompt: config?.startPrompt?.get?.() ?? config?.startPrompt ?? '',
    injectOnStart: config?.injectOnStart?.get?.() ?? config?.injectOnStart ?? true,
  })

  // This plugin ships its own page (the browser half), so it opts out of the
  // schema-generated page policy. `autoGenerate` defaults to true for clients
  // that build pages from the schema, but none ships yet, so the policy is
  // declared explicitly and the page itself handles `auto`-less deployments:
  // the registration is wrapped in an optional Settings child so the plugin
  // still runs when Settings is absent.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(
      () => sctx.settings.configure({ auto: false }, sctx.fiber),
      'round-inject: page policy',
    )
  })

  // The projection registry is a plain service in 0.1.7, used exactly like the
  // built-in folds (`ctx.sessionProjections.register(...)` in agent-loop and
  // agent-preset-registry). Registration is itself an effect on this plugin's
  // fiber, so unloading removes the key — no extra `ctx.effect` wrapper and no
  // `ctx.inject(['sessionProjections'])` indirection.
  ctx.sessionProjections.register(projectionDefinition)

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
      if (state.lastInjectSeq < 0 && hasStart) {
        // Conversation-start prompt rides the very first model call.
        text = cfg.startPrompt
      } else if (hasPeriodic && state.sinceInject >= cfg.interval) {
        // Periodic: this call is exactly `interval` completed steps after the
        // previous injection — or, before any injection has happened, the
        // `interval`-th call of the session. `sinceInject` advances on every
        // `step/end` from the session's first step, so the same test covers
        // both cases and the schedule can never stall.
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
    if (session !== undefined) {
      const state = ctx.sessionProjections.stateOf(session, 'round-inject')
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
