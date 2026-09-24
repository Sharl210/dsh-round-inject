/**
 * Browser half: the plugin's configuration page.
 *
 * DSH 0.1.7 derives settings *data* from an entry's volatile Config fields, but
 * it renders no page for them: every configurable plugin ships a client half
 * that registers a page and builds the form from the shared primitives. For a
 * bundle row that page goes into the keyed `plugins.row.config` slot, keyed by
 * `<package name>#<row id>` — the Plugins page then gives the row a configure
 * control headed by the plugin's own display title and description.
 *
 * Values are read through `ctx.configForms.get(entryId)`, so the page edits
 * exactly the Config the Host already holds: no separate namespace exists to
 * drift from the entry.
 *
 * @module dsh-round-inject/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-round-inject',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { SettingsForm, SettingsFormModel, SettingsValueField, settingsNumberField, settingsTextField } = primitives

    /** Bundle package name; half of the row-config slot key. */
    const BUNDLE = 'dsh-round-inject'
    /** Row id the bundle's patch declares; the other half of the key. */
    const ROW_ID = 'round-inject'
    /** Profile entry id holding this plugin's Config, i.e. the form key. */
    const ENTRY_ID = 'round-inject'
    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-round-inject'
    /** Config fields the page edits, in display order. */
    const FIELDS = ['enabled', 'interval', 'startPrompt', 'injectOnStart', 'prompt']

    const en = {
      nav: 'Prompt injection',
      description: 'Re-inject a prompt every N model invocations. Conversation turns and tool-call steps both count.',
      enabled: 'Enable injection',
      enabledHint: 'Turn injection off without uninstalling the plugin.',
      interval: 'Steps between injections',
      intervalHint:
        'Completed model calls between two injections (default 50). With the start prompt on, injections land on calls 1, 1+N, 1+2N…; with it off, on calls N, 2N, 3N…',
      startPrompt: 'Conversation-start prompt',
      startPromptHint: 'Injected once on the first model call of a conversation. Leave empty for none.',
      injectOnStart: 'Inject at conversation start',
      injectOnStartHint: 'Whether the conversation-start prompt is injected at all.',
      prompt: 'Periodic prompt',
      promptHint: 'Injected once every N steps after the interval elapses. Leave empty to disable periodic injection.',
      startTitle: 'Conversation start',
      periodicTitle: 'Periodic injection',
      on: 'On',
      off: 'Off',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalid: 'Enter a whole number of 1 or more.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    }

    const zh = {
      nav: '提示词注入',
      description: '每 N 次模型调用注入一次提示词。对话轮与工具调用轮都各计一次。',
      enabled: '启用注入',
      enabledHint: '无需卸载即可关闭注入。',
      interval: '两次注入之间的步数',
      intervalHint:
        '两次注入之间相隔的模型调用步数（默认 50）。开启「对话开始时注入」时，注入发生在第 1、1+N、1+2N… 次调用；关闭时发生在第 N、2N、3N… 次调用。',
      startPrompt: '对话开始提示词',
      startPromptHint: '在一次对话的第一次模型调用时注入一次。留空表示不注入。',
      injectOnStart: '对话开始时注入',
      injectOnStartHint: '是否注入「对话开始提示词」。',
      prompt: '周期性提示词',
      promptHint: '每满 N 步注入一次。留空表示关闭周期性注入。',
      startTitle: '对话开始',
      periodicTitle: '周期性注入',
      on: '开',
      off: '关',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalid: '请填 1 或更大的整数。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
    }

    /**
     * A whole-number field bounded below by 1 (the interval cannot be cleared:
     * its schema default is 50).
     * @param field - field name inside the entry's Config.
     * @returns the field's conversion spec.
     */
    function intervalField(field) {
      const base = settingsNumberField(field)
      return {
        field,
        format: base.format,
        parse: (text) => {
          const write = base.parse(text)
          if (write === undefined || write.kind === 'clear') return undefined
          return typeof write.value === 'number' && write.value >= 1 ? write : undefined
        },
      }
    }

    /**
     * The boolean Config fields have no shared primitive spec, so this page
     * stages them as the strings `true`/`false` and converts on save, riding the
     * same ordered mutation as the numeric and text fields.
     * @param field - field name inside the entry's Config.
     * @returns the field's conversion spec.
     */
    function booleanField(field) {
      return {
        field,
        format: (value) => (value === true ? 'true' : value === false ? 'false' : ''),
        parse: (text) => {
          const normalized = text.trim().toLowerCase()
          if (normalized === 'true') return { kind: 'set', value: true }
          if (normalized === 'false') return { kind: 'set', value: false }
          return undefined
        },
      }
    }

    /**
     * One staged text or number field.
     * @param props - the field's copy, staged state, and form actions.
     * @returns the labelled control.
     */
    function ValueField(props) {
      const { name, state, disabled, edit, resetField, t } = props
      const field = state.fields[name]
      return react.createElement(SettingsValueField, {
        id: `${NS}-${name}`,
        label: t(name),
        hint: t(`${name}Hint`),
        text: field.text,
        overridden: field.overridden,
        invalid: field.invalid,
        disabled,
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalid'),
        onEdit: (text) => edit(name, text),
        onReset: () => resetField(name),
      })
    }

    /**
     * A boolean field as an explicit two-state control.
     * @param props - the field's copy, staged state, and form actions.
     * @returns the labelled control.
     */
    function BooleanField(props) {
      const { name, state, disabled, edit, resetField, t } = props
      const field = state.fields[name]
      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          react.createElement('span', { style: { fontSize: 13 } }, t(name)),
          field.overridden ? react.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, `(${t('overridden')})`) : null,
          react.createElement(
            'select',
            {
              id: `${NS}-${name}`,
              disabled,
              value: field.text === 'true' ? 'true' : 'false',
              onChange: (event) => edit(name, event.target.value),
              style: { marginLeft: 'auto' },
            },
            react.createElement('option', { value: 'true' }, t('on')),
            react.createElement('option', { value: 'false' }, t('off')),
          ),
          field.overridden
            ? react.createElement('button', { type: 'button', disabled, onClick: () => resetField(name) }, t('reset'))
            : null,
        ),
        react.createElement('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, t(`${name}Hint`)),
      )
    }

    /**
     * The configuration page. The Plugins page asks for `view: 'summary'` while
     * drawing the row's one-liner and `view: 'page'` for the body; only the body
     * renders controls. Edits are staged and written by the save.
     * @param props - the requested view, the row's form, and the locale reader.
     * @returns the one-liner, or the staged form.
     */
    function RoundInjectRowConfig(props) {
      const t = props.t
      const state = props.useRoundInjectForm((snapshot) => snapshot)

      // The Plugins page asks for the row's one-liner first; the Settings
      // section always renders the body.
      if (props.view === 'summary') return t('description')

      const disabled = !state.writable
      const shared = { state, disabled, edit: props.edit, resetField: props.resetField, t }

      const controls = [
        react.createElement('p', { key: 'desc', style: { margin: 0, opacity: 0.75, fontSize: 13 } }, t('description')),
        react.createElement(BooleanField, { ...shared, key: 'enabled', name: 'enabled' }),
        react.createElement(ValueField, { ...shared, key: 'interval', name: 'interval' }),
        react.createElement('h3', { key: 'startTitle', style: { margin: '4px 0 0', fontSize: 14 } }, t('startTitle')),
        react.createElement(ValueField, { ...shared, key: 'startPrompt', name: 'startPrompt' }),
        react.createElement(BooleanField, { ...shared, key: 'injectOnStart', name: 'injectOnStart' }),
        react.createElement('h3', { key: 'periodicTitle', style: { margin: '4px 0 0', fontSize: 14 } }, t('periodicTitle')),
        react.createElement(ValueField, { ...shared, key: 'prompt', name: 'prompt' }),
      ]

      return react.createElement(SettingsForm, {
        labels: {
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: t('saveFailed'),
          save: t('save'),
          saving: t('saving'),
        },
        state: {
          available: state.available,
          writable: state.writable,
          dirty: state.dirty,
          invalid: state.invalid,
          saving: state.saving,
          failed: state.failed,
        },
        onSave: () => props.save(),
        onDiscard: () => props.discard(),
        children: controls,
      })
    }


    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the row's configuration page while the Host serves the entry.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'round-inject: dictionaries')

      const model = new SettingsFormModel(
        ctx.configForms.get(ENTRY_ID),
        [
          booleanField('enabled'),
          intervalField('interval'),
          settingsTextField('startPrompt'),
          booleanField('injectOnStart'),
          settingsTextField('prompt'),
        ],
      )
      const store = model.bind(() => {
        const shell = model.shell()
        return {
          writable: shell.writable,
          dirty: shell.dirty,
          invalid: shell.invalid,
          saving: shell.saving,
          failed: shell.failed,
          fields: Object.fromEntries(FIELDS.map((name) => [name, model.field(name)])),
        }
      })
      const actions = model.actions()
      ctx.effect(() => () => model.dispose(), 'round-inject: form subscription')

      const face = () => ({ hooks: { roundInjectForm: store }, ...actions, t })

      // Registered through whileServed, like every shipped configuration page:
      // the form reports `available: false` until the Host's describe mirror
      // carries this entry, so registering unconditionally shows the "not
      // loaded" notice on a perfectly loaded plugin.
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () => {
            const offSection = ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'round-inject',
                  order: 30,
                  label: () => t('nav'),
                  locale: NS,
                  inject: face,
                },
                RoundInjectRowConfig,
              ),
            )
            // The row's own configuration page on the Plugins page, so the same
            // form is reachable from the bundle's row as well.
            const offRow = ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                { name: 'plugins.row.config', key: `${BUNDLE}#${ROW_ID}`, locale: NS, inject: face },
                RoundInjectRowConfig,
              ),
            )
            return () => {
              offRow()
              offSection()
            }
          }),
        'round-inject: configuration page',
      )
    }

    exports.NS = NS
    exports.ENTRY_ID = ENTRY_ID
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
