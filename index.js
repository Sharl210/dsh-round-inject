/**
 * dsh-round-inject — Host half.
 *
 * Counts model invocations per agent (every step that actually calls the
 * model counts once — user turns and tool-call steps alike) and periodically
 * injects a user-configured prompt as a model-visible user message.
 *
 * - The first injection happens at conversation start (per agent session).
 * - Afterwards one injection fires every `interval` model invocations.
 * - Config lives in the `round-inject` settings namespace (persisted by the
 *   settings provider), layered over the composition entry config.
 *
 * Injection rides the `agent/pre-step` waterfall: the returned messages are
 * persisted as user messages and enter that step's model request, so the
 * injected text is model-visible, source-attributed (`plugin: round-inject`),
 * and reconstructable from the session log — the same channel the shipped
 * repeat-tool-reminder guard uses for its reminders.
 */
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'round-inject'

/** Composition entry config; also the settings namespace base layer. */
export const Config = z.object({
  /** Master switch: when false the plugin counts nothing and injects nothing. */
  enabled: z.boolean().default(true),
  /**
   * How many model invocations between two injections. The first injection is
   * not counted (it belongs to conversation start); after it, the counter
   * counts every entering step and fires when it reaches `interval`.
   */
  interval: z.number().step(1).min(1).max(100000).default(80),
  /** The prompt text injected as a user message. Empty ⇒ nothing is injected. */
  prompt: z.string().default(''),
  /** Whether the first injection happens at conversation start. */
  injectOnStart: z.boolean().default(true),
})

/** The `{kind:'plugin'}` source stamped on every injected message. */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'round-inject' })

/** One agent's counting state. */
function createState() {
  return { started: false, count: 0 }
}

export function apply(ctx) {
  /** Per-agent counting state, keyed by the live agent object. */
  const states = new WeakMap()

  // ── settings ─────────────────────────────────────────────────────────────
  // Register the namespace when the settings service is mounted, waiting for
  // it via ctx.inject (the settings service may not exist yet at apply time).
  // Without the service, fall back to the entry config alone.
  let readConfig = () => ctx.config ?? {}
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('round-inject', Config, { base: ctx.config })
    readConfig = () => scope.get() ?? {}
  })

  // ── conversation start ───────────────────────────────────────────────────
  // Reset the agent's counter so the first entering step can inject once.
  ctx.on('agent/session-start', ({ agent }) => {
    states.set(agent, createState())
  })

  // ── per-step counting + injection ────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    // Preserve the loop's own decision (messages, rejection) untouched.
    const decision = await next()
    if (decision.kind !== 'enter') return decision

    // Only a step that actually calls the model counts. An empty message set
    // closes the turn without a model call, so counting it would drift the
    // interval; injecting into it would manufacture a model call.
    if (decision.messages.length === 0) return decision

    const config = readConfig()
    if (!config.enabled || !config.prompt) return decision

    let state = states.get(agent)
    if (state === undefined) {
      // An agent that never observed session-start (edge case): start fresh.
      state = createState()
      states.set(agent, state)
    }

    let shouldInject = false
    if (!state.started) {
      state.started = true
      state.count = 0
      shouldInject = config.injectOnStart
    } else {
      state.count += 1
      if (state.count >= config.interval) {
        state.count = 0
        shouldInject = true
      }
    }

    if (!shouldInject || signal.aborted) return decision

    const injected = createUserMessage({
      content: [{ type: 'text', text: config.prompt }],
      source: PLUGIN_SOURCE,
    })

    return { ...decision, messages: [...decision.messages, injected] }
  })
}
