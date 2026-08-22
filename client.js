/**
 * dsh-round-inject — Browser half.
 *
 * Renders one settings page ("提示词注入") inside the Settings panel with:
 *   - an enabled switch,
 *   - the injection interval (rounds between two injections, default 80),
 *   - the injected prompt text (multi-line input),
 *   - a "inject at conversation start" switch.
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

    /** Schema defaults mirroring the Host Config, shown before first load. */
    const DEFAULTS = Object.freeze({ enabled: true, interval: 80, prompt: '', injectOnStart: true })

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
     * Settings page bound to the round-inject namespace scope. Uses
     * useSyncExternalStore so the page tracks the mirror and stays in sync
     * with other surfaces writing the same namespace.
     */
    function RoundInjectSettings(props) {
      const scope = props.scope
      const snapshot = React.useSyncExternalStore(
        React.useCallback((cb) => scope.subscribe(cb), [scope]),
        React.useCallback(() => scope.getSnapshot(), [scope]),
      )
      const value = { ...DEFAULTS, ...(snapshot.value ?? {}) }
      const ready = snapshot.status === 'ready'

      const setField = (field, next) => {
        if (!snapshot.writable) return
        void scope.set(field, next)
      }

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
              checked: Boolean(value.enabled),
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
            value: value.interval,
            disabled: !ready,
            onChange: (e) => {
              const n = Number(e.target.value)
              if (Number.isSafeInteger(n) && n >= 1 && n <= 100000) setField('interval', n)
            },
            style: { ...inputStyle, maxWidth: 160 },
          }),
        }),
        h(Row, {
          label: '注入提示词',
          hint: '达到触发轮次时作为一条用户消息注入给模型。留空则不注入。',
          children: h('textarea', {
            rows: 6,
            value: value.prompt,
            disabled: !ready,
            placeholder: '在这里输入每 N 轮注入给模型的提示词…',
            onChange: (e) => setField('prompt', e.target.value),
            style: inputStyle,
          }),
        }),
        h(Row, {
          label: '对话开始时注入',
          hint: '每次会话开始时注入一次(不计入轮次)。',
          children: h(
            'label',
            { style: toggleStyle },
            h('input', {
              type: 'checkbox',
              checked: Boolean(value.injectOnStart),
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
