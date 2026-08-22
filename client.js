/**
 * dsh-round-inject — Browser half.
 *
 * Renders one settings page ("提示词注入") inside the Settings panel with:
 *   - an enabled switch,
 *   - the injection interval (rounds between two injections, default 80),
 *   - the conversation-start prompt (first input box, injected once at the
 *     start of a new conversation),
 *   - the periodic prompt (second input box, injected every N model calls),
 *   - a "inject at conversation start" switch.
 *
 * Editing is DRAFT-based: every change lands in the local draft only; a
 * Save button (bottom-right) writes the whole draft to the settings
 * namespace in one batch. Nothing is written until the user confirms.
 *
 * Data channel: the standard `settingsScope` service bound to the
 * `round-inject` namespace (hosted by dsh-client-ui-settings). No custom RPC.
 */
window.__ModuleLoader__.load({
  // Must equal the npm package name: client-modules serves /plugins/<pkg>/client.js
  // and verifies the bundle registers that exact id.
  id: 'dsh-round-inject',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NAMESPACE = 'round-inject'

    /**
     * Schema defaults mirroring the Host Config, shown before first load.
     * UI-editable fields only (host-side internals like a bookmark are never
     * rendered and deliberately excluded).
     */
    const DEFAULTS = Object.freeze({
      enabled: true,
      interval: 80,
      startPrompt: '',
      prompt: '',
      injectOnStart: true,
    })
    const UI_FIELDS = Object.keys(DEFAULTS)

    /** Pick the UI-editable fields out of a settings snapshot. */
    const uiValue = (snapshotValue) => {
      const out = {}
      for (const key of UI_FIELDS) {
        if (key in snapshotValue) out[key] = snapshotValue[key]
      }
      return out
    }

    const rowStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '10px 0',
      borderBottom: '1px solid var(--dsh-color-border, rgba(128,128,128,.25))',
    }
    const labelStyle = { fontSize: 13, fontWeight: 600, color: 'var(--dsh-color-text, inherit)' }
    const hintStyle = { fontSize: 12, color: 'var(--dsh-color-text-secondary, rgba(128,128,128,.9))' }
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      fontSize: 13,
      borderRadius: 6,
      border: '1px solid var(--dsh-color-border, rgba(128,128,128,.4))',
      background: 'var(--dsh-color-input-bg, transparent)',
      color: 'var(--dsh-color-text, inherit)',
      fontFamily: 'inherit',
      resize: 'vertical',
    }
    const toggleStyle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }
    const saveBtnStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 12,
      padding: '8px 18px',
      fontSize: 13,
      fontWeight: 600,
      borderRadius: 6,
      border: '1px solid var(--dsh-color-border, rgba(128,128,128,.5))',
      background: 'var(--dsh-color-accent, #4f8cff)',
      color: '#fff',
      cursor: 'pointer',
      opacity: 1,
    }
    const saveBtnDisabled = { ...saveBtnStyle, opacity: 0.5, cursor: 'not-allowed' }

    /** One row: label + optional hint + control. */
    const Row = (props) =>
      h(
        'div',
        { style: rowStyle },
        h('label', { style: labelStyle }, props.label),
        props.hint ? h('div', { style: hintStyle }, props.hint) : null,
        props.children,
      )

    /**
     * Settings page bound to the round-inject namespace scope. All edits live
     * in a local draft; the Save button commits them to the settings
     * namespace. IME composition is protected: while composing, the draft
     * still tracks keystrokes (so Chinese input is never swallowed), but no
     * write is attempted anyway (writes only happen on Save).
     */
    function RoundInjectSettings(props) {
      const scope = props.scope
      const snapshot = React.useSyncExternalStore(
        React.useCallback((cb) => scope.subscribe(cb), [scope]),
        React.useCallback(() => scope.getSnapshot(), [scope]),
      )
      const ready = snapshot.status === 'ready'
      const writable = Boolean(snapshot.writable)
      const settingsValue = snapshot.value ?? {}

      // Draft holds the edited form. Init from the current settings.
      const [draft, setDraft] = React.useState(() => ({ ...DEFAULTS, ...uiValue(settingsValue) }))
      // Save-state feedback: 'saved' | 'dirty' | 'saving' | 'error'
      const [saveState, setSaveState] = React.useState('saved')

      const composingRef = React.useRef(false)

      // Sync the draft when the settings change from outside, but never while
      // the user is composing or after they started editing (dirty).
      React.useEffect(() => {
        if (composingRef.current) return
        setDraft((d) => ({ ...d, ...uiValue(settingsValue) }))
        if (saveState !== 'saving') setSaveState('saved')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [settingsValue])

      // Field setter: update draft only, mark dirty. Nothing is written yet.
      const setField = (field, next) => {
        setDraft((d) => ({ ...d, [field]: next }))
        setSaveState('dirty')
      }

      /**
       * IME-safe props: value from the draft, onChange always updates the
       * draft (typing is never swallowed, Chinese commits stay on screen),
       * composition flag guards the draft-sync effect only.
       */
      const textFieldProps = (field, normalize) => ({
        disabled: !ready,
        value: draft[field],
        onCompositionStart: () => {
          composingRef.current = true
        },
        onCompositionEnd: (e) => {
          composingRef.current = false
          const final = e.target.value
          setDraft((d) => ({ ...d, [field]: normalize ? normalize(final) : final }))
          setSaveState('dirty')
        },
        onChange: (e) => {
          const next = e.target.value
          setDraft((d) => ({ ...d, [field]: normalize ? normalize(next) : next }))
          setSaveState('dirty')
        },
      })

      /** Persist the whole draft to the settings namespace in one batch. */
      const onSave = () => {
        if (!writable || !ready) return
        setSaveState('saving')
        // Queue every UI field; the scope serializes writes on one chain.
        const writes = UI_FIELDS.map((field) => scope.set(field, draft[field]))
        Promise.all(writes)
          .then(() => setSaveState('saved'))
          .catch(() => setSaveState('error'))
      }

      const dirty = saveState === 'dirty'
      const saving = saveState === 'saving'
      const saveLabel = saving ? '保存中…' : dirty ? '保存' : '已保存 ✓'
      const saveDisabled = !writable || !ready || !dirty || saving

      return h(
        'div',
        { style: { width: '100%', maxWidth: 560 } },
        h(Row, {
          label: '启用注入',
          hint: '关闭后停止计数与注入。',
          children: h(
            'label',
            { style: toggleStyle },
            h('input', {
              type: 'checkbox',
              checked: Boolean(draft.enabled),
              disabled: !ready,
              onChange: (e) => setField('enabled', e.target.checked),
            }),
            '启用',
          ),
        }),
        h(Row, {
          label: '触发轮次',
          hint: '每多少次模型调用注入一次(对话轮与工具调用轮都计一次),默认 80。',
          children: h('input', {
            type: 'number',
            min: 1,
            max: 100000,
            step: 1,
            ...textFieldProps('interval', (raw) => {
              const n = Number(raw)
              return Number.isSafeInteger(n) && n >= 1 && n <= 100000 ? n : draft.interval
            }),
            style: { ...inputStyle, maxWidth: 160 },
          }),
        }),
        h(Row, {
          label: '会话开始提示词',
          hint: '每次新会话开始时作为一条用户消息注入一次(不计入轮次)。留空则不注入。',
          children: h('textarea', {
            rows: 3,
            ...textFieldProps('startPrompt'),
            placeholder: '在这里输入会话开始时注入给模型的提示词…',
            style: inputStyle,
          }),
        }),
        h(Row, {
          label: '周期注入提示词',
          hint: '达到触发轮次时作为一条用户消息注入给模型。留空则只做会话开始注入。',
          children: h('textarea', {
            rows: 6,
            ...textFieldProps('prompt'),
            placeholder: '在这里输入每 N 轮注入给模型的提示词…',
            style: inputStyle,
          }),
        }),
        h(Row, {
          label: '对话开始时注入',
          hint: '控制"会话开始提示词"是否在会话开始时注入。',
          children: h(
            'label',
            { style: toggleStyle },
            h('input', {
              type: 'checkbox',
              checked: Boolean(draft.injectOnStart),
              disabled: !ready,
              onChange: (e) => setField('injectOnStart', e.target.checked),
            }),
            '开启',
          ),
        }),
        snapshot.status === 'loading'
          ? h('div', { style: { ...hintStyle, marginTop: 8 } }, '正在加载设置…')
          : snapshot.mode === 'memory'
            ? h(
                'div',
                { style: { ...hintStyle, marginTop: 8 } },
                '当前通过远程地址访问,DSH 设置仅对本机(localhost)可写。请在测试机本机用 http://127.0.0.1:3080 打开后再修改设置。',
              )
            : snapshot.status === 'unavailable'
              ? h('div', { style: { ...hintStyle, marginTop: 8 } }, '设置服务不可用,当前仅使用组合配置默认值。')
              : null,
        writable && ready
          ? h(
              'button',
              {
                type: 'button',
                style: saveDisabled ? saveBtnDisabled : saveBtnStyle,
                disabled: saveDisabled,
                onClick: onSave,
              },
              saveLabel,
            )
          : null,
        saveState === 'error'
          ? h('div', { style: { ...hintStyle, marginTop: 8, color: '#e06060' } }, '保存失败,请重试。')
          : dirty
            ? h('div', { style: { ...hintStyle, marginTop: 8 } }, '有未保存的修改,点击"保存"生效。')
            : null,
      )
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })

      ctx.effect(() =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: NAMESPACE,
              order: 30,
              label: () => '提示词注入',
            },
            (props) => h(RoundInjectSettings, { ...props, scope }),
          ),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots']
    return module.exports
  },
})
