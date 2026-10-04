/**
 * 小模型委派（省 token）—— 浏览器半身。
 *
 * 只贡献一件事：`settings.section` 里 id 为 `small-model-delegate` 的配置页。
 * 页面数据走本插件自己的同源 JSON 接口 `/api/small-model-delegate/*`，
 * 不使用类型化 Remote —— 那些接口由同一个宿主进程提供，且不需要生成的 schema。
 *
 * 手写 ModuleLoader bundle：无构建步骤，除 shell 已经提供的 `react` 之外没有依赖。
 * 全部配色取自主题变量，因此切换明暗色仍然成立。
 */
window.__ModuleLoader__.load({
  id: 'dsh-small-model-delegate',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const API = '/api/small-model-delegate'
    const inject = ['slots']

    // ── 与宿主通信 ───────────────────────────────────────────────────────────
    async function api(pathname, options) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      try {
        const response = await fetch(`${API}${pathname}`, {
          ...options,
          redirect: 'error',
          signal: controller.signal,
        })
        const raw = await response.text()
        let payload
        try {
          payload = raw === '' ? {} : JSON.parse(raw)
        } catch {
          payload = { error: raw.slice(0, 200) }
        }
        if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (pathname, body) => api(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body === undefined ? {} : body),
    })

    // ── 样式（内联 + 主题变量） ──────────────────────────────────────────────
    const C = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    }

    const S = {
      root: { maxWidth: 780, padding: '4px 2px 28px', color: C.primary },
      title: { margin: '0 0 6px', fontSize: 18, fontWeight: 600 },
      h3: { margin: '24px 0 6px', fontSize: 15, fontWeight: 600 },
      desc: { margin: '0 0 16px', color: C.secondary, fontSize: 13, lineHeight: 1.65 },
      toggle: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
        border: `1px solid ${C.border}`, borderRadius: 8, background: C.layer2,
        fontSize: 13, marginBottom: 18,
      },
      warn: {
        margin: '14px 0 0', padding: '9px 11px', borderRadius: 6,
        border: `1px solid ${C.warn}`, background: C.layer2,
        fontSize: 12.5, lineHeight: 1.6,
      },
      grid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: '14px 18px', marginBottom: 14,
      },
      field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 },
      label: { fontWeight: 500 },
      hint: { color: C.secondary, fontSize: 12, lineHeight: 1.5 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 6,
        border: `1px solid ${C.border}`, background: C.layer1, color: C.primary,
        fontSize: 13, fontFamily: 'inherit',
      },
      textarea: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 6,
        border: `1px solid ${C.border}`, background: C.layer1, color: C.primary,
        fontSize: 13, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.55,
      },
      code: {
        fontFamily: C.mono, background: C.layer1, border: `1px solid ${C.border}`,
        borderRadius: 4, padding: '1px 5px', fontSize: 12,
      },
      actions: { display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0 8px' },
      button: {
        padding: '8px 16px', borderRadius: 6, border: 'none', background: C.brand,
        color: '#fff', fontSize: 13, cursor: 'pointer',
      },
      buttonBusy: {
        padding: '8px 16px', borderRadius: 6, border: 'none', background: C.brand,
        color: '#fff', fontSize: 13, cursor: 'default', opacity: 0.6,
      },
      notice: { margin: '8px 0 0', fontSize: 13, color: C.primary },
      stats: { margin: '14px 0 4px', fontSize: 12, color: C.secondary },
      path: { margin: '2px 0 0', fontSize: 11.5, color: C.secondary, fontFamily: C.mono, wordBreak: 'break-all' },
    }

    // ── 小组件 ──────────────────────────────────────────────────────────────
    function Field(props) {
      return h('div', { style: S.field },
        h('span', { style: S.label }, props.label),
        props.children,
        props.hint ? h('span', { style: S.hint }, props.hint) : null,
      )
    }

    function Select(props) {
      return h('select', {
        style: S.input,
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        onChange: event => props.onChange(event.target.value),
      },
        h('option', { value: '', key: '__none' }, props.placeholder),
        (props.options || []).map(option =>
          h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    function TextInput(props) {
      return h('input', {
        style: S.input,
        type: props.type === undefined ? 'text' : props.type,
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        onChange: event => props.onChange(event.target.value),
      })
    }

    // ── 配置页 ──────────────────────────────────────────────────────────────
    function SettingsPage() {
      const [state, setState] = useState(null)
      const [models, setModels] = useState([])
      const [modelsError, setModelsError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        api('/state').then(
          value => { if (alive) setState(value) },
          error => { if (alive) setNotice(`读取配置失败：${error.message}`) },
        )
        return () => { alive = false }
      }, [])

      const providerId = state && state.config ? state.config.llmProvider : ''

      useEffect(() => {
        let alive = true
        setModels([])
        setModelsError('')
        if (!providerId) return undefined
        api(`/models?provider=${encodeURIComponent(providerId)}`).then(
          value => {
            if (!alive) return
            setModels(value && Array.isArray(value.models) ? value.models : [])
            if (value && value.error) setModelsError(String(value.error))
          },
          error => { if (alive) setModelsError(error.message) },
        )
        return () => { alive = false }
      }, [providerId])

      if (!state || !state.config) {
        return h('div', { style: S.root }, h('div', { style: S.hint }, '正在读取配置…'))
      }

      const config = state.config
      const patch = next => setState(Object.assign({}, state, {
        config: Object.assign({}, config, next),
      }))

      const save = () => {
        setBusy(true)
        setNotice('')
        post('/save', config).then(
          value => {
            setBusy(false)
            setState(value)
            setNotice(value && value.registered
              ? `已保存，工具 ${config.toolName} 已注册（下一步即可被调用）。`
              : '已保存；当前未启用，工具不会被注册。')
          },
          error => {
            setBusy(false)
            setNotice(`保存失败：${error.message}`)
          },
        )
      }

      const subagentProviders = Array.isArray(state.subagentProviders) ? state.subagentProviders : []
      const llmProviders = Array.isArray(state.llmProviders) ? state.llmProviders : []
      const stats = state.stats || {}
      const routeMissing = !config.llmProvider || !config.model

      return h('div', { style: S.root },
        h('h2', { style: S.title }, '小模型委派（省 token）'),
        h('p', { style: S.desc },
          '主模型通过 delegate_small 工具把边界清晰的子任务交给你在下面选定的小模型执行，只把最终结论带回当前上下文；',
          '小模型自己的中间步骤、文件读取和试错过程都不会进入主模型的上下文，因此同样的活儿消耗的主模型 token 大幅下降。'),

        h('label', { style: S.toggle },
          h('input', {
            type: 'checkbox',
            checked: config.enabled === true,
            onChange: event => patch({ enabled: event.target.checked }),
          }),
          h('span', null, '启用委派工具'),
          h('code', { style: S.code }, config.toolName),
        ),

        routeMissing && config.enabled === true
          ? h('p', { style: S.warn },
            '还没有选定小模型路由，工具调用了也只会返回“未配置”。请选择「小模型 provider」和「小模型 model」，或直接关闭开关。')
          : null,

        h('section', { style: S.grid },
          h(Field, {
            label: '执行器 provider',
            hint: '真正运行子任务的后端；必须支持模型覆盖，否则无法指定小模型。',
          }, h(Select, {
            value: config.subagentProvider,
            placeholder: '自动（使用第一个）',
            options: subagentProviders.map(item => ({
              value: item.name,
              label: item.agentOptions === true ? item.name : `${item.name}（不支持模型覆盖）`,
            })),
            onChange: value => patch({ subagentProvider: value }),
          })),

          h(Field, {
            label: '小模型 provider',
            hint: modelsError ? `读取模型列表失败：${modelsError}` : '小模型所属的 LLM 路由。',
          }, h(Select, {
            value: config.llmProvider,
            placeholder: '选择 LLM provider',
            options: llmProviders.map(item => ({ value: item.id, label: `${item.name}  ·  ${item.id}` })),
            onChange: value => patch({ llmProvider: value, model: '' }),
          })),

          h(Field, {
            label: '小模型 model',
            hint: '选择价格最低、但足以完成你打算委派的那类任务的小模型。',
          }, h(Select, {
            value: config.model,
            placeholder: models.length > 0
              ? '选择 model'
              : (config.llmProvider ? '（该 provider 未返回模型，可在下方手填）' : '先选择 provider'),
            options: models.map(item => ({
              value: item.id,
              label: item.name === item.id ? item.id : `${item.name}  ·  ${item.id}`,
            })),
            onChange: value => patch({ model: value }),
          })),

          h(Field, {
            label: 'model id 手填',
            hint: '下拉列表没有时，直接填写准确的 model id。',
          }, h(TextInput, { value: config.model, onChange: value => patch({ model: value }) })),

          h(Field, {
            label: 'reasoning effort（可选）',
            hint: '留空使用 provider 默认；小模型一般留空即可。',
          }, h(TextInput, { value: config.reasoningEffort, onChange: value => patch({ reasoningEffort: value }) })),

          h(Field, {
            label: '最大输出 tokens（0 = 默认）',
            hint: '限制小模型单次回答长度，避免它长篇大论反而浪费。',
          }, h(TextInput, {
            type: 'number',
            value: config.maxTokens,
            onChange: value => patch({ maxTokens: Number(value) || 0 }),
          })),

          h(Field, {
            label: '工具名',
            hint: '主模型看到的工具名；改名后立即重新注册。',
          }, h(TextInput, { value: config.toolName, onChange: value => patch({ toolName: value }) })),

          h(Field, {
            label: '允许的工具（逗号分隔，留空 = 全部）',
            hint: '例如 read, grep, glob。限制小模型能用的工具，既省 token 也更安全。',
          }, h(TextInput, { value: config.toolAllow, onChange: value => patch({ toolAllow: value }) })),

          h(Field, {
            label: '禁止的工具（逗号分隔）',
            hint: '例如 pwsh, write, edit。想让它只读不改就填这几个。',
          }, h(TextInput, { value: config.toolDeny, onChange: value => patch({ toolDeny: value }) })),
        ),

        h(Field, {
          label: '小模型的人格 / 系统提示',
          hint: '会作为子任务的系统提示注入，用来约束它的输出风格与边界。',
        }, h('textarea', {
          style: S.textarea,
          rows: 4,
          value: String(config.persona),
          onChange: event => patch({ persona: event.target.value }),
        })),

        h('label', { style: S.toggle },
          h('input', {
            type: 'checkbox',
            checked: config.promptHintEnabled === true,
            onChange: event => patch({ promptHintEnabled: event.target.checked }),
          }),
          h('span', null, '在主模型的系统提示里常驻一段“优先委派”的说明'),
        ),

        h(Field, {
          label: '常驻提示文本',
          hint: '每个请求都会带上它——这才是让模型真正开始主动委派的那根杠杆。工具描述只在模型翻工具列表时才会被读到，这段不是。改这里保存即热生效，不用重启。',
        }, h('textarea', {
          style: S.textarea,
          rows: 4,
          value: String(config.promptHintText),
          onChange: event => patch({ promptHintText: event.target.value }),
        })),

        h('h3', { style: S.h3 }, '自动拦截（硬方案，不依赖模型自觉）'),
        h('p', { style: S.desc },
          '上面那段提示是"劝"模型委派，实测两次都劝不动。这一段是"替"它做：',
          '某个工具的结果超过阈值时，先交给小模型消化，只把摘要放进主上下文——原始输出根本不进来。',
          '任何一步出错（没配路由、小模型报错、超时）都会原样放行，不会吞掉工具调用。'),

        h('label', { style: S.toggle },
          h('input', {
            type: 'checkbox',
            checked: config.interceptEnabled === true,
            onChange: event => patch({ interceptEnabled: event.target.checked }),
          }),
          h('span', null, '启用自动拦截'),
        ),

        h('section', { style: S.grid },
          h(Field, {
            label: '拦截哪些工具（逗号分隔）',
            hint: '默认 read, grep, pwsh —— 这三类是产大结果的主力。',
          }, h(TextInput, { value: config.interceptTools, onChange: value => patch({ interceptTools: value }) })),

          h(Field, {
            label: '阈值（字节，超过才拦）',
            hint: '调小拦得更勤、省得更多，但也更容易把有用细节摘要掉。20000 约等于 400 行代码。',
          }, h(TextInput, {
            type: 'number',
            value: config.interceptThresholdBytes,
            onChange: value => patch({ interceptThresholdBytes: Number(value) || 0 }),
          })),

          h(Field, {
            label: '上限（字节，超过就放过）',
            hint: '太大的输出小模型也消化不了，直接原样放行，不冒风险。',
          }, h(TextInput, {
            type: 'number',
            value: config.interceptMaxBytes,
            onChange: value => patch({ interceptMaxBytes: Number(value) || 0 }),
          })),

          h(Field, {
            label: '单次摘要超时（毫秒）',
            hint: '免费模型偶尔很慢，超时就原样放行，绝不拖死整个回合。',
          }, h(TextInput, {
            type: 'number',
            value: config.interceptTimeoutMs,
            onChange: value => patch({ interceptTimeoutMs: Number(value) || 0 }),
          })),
        ),

        h(Field, {
          label: '摘要指令（发给小模型）',
          hint: '决定摘要保留什么、丢掉什么。这条最影响摘要质量，改完保存即热生效。',
        }, h('textarea', {
          style: S.textarea,
          rows: 4,
          value: String(config.interceptPrompt),
          onChange: event => patch({ interceptPrompt: event.target.value }),
        })),

        h('div', { style: S.actions },
          h('button', {
            style: busy ? S.buttonBusy : S.button,
            disabled: busy,
            onClick: save,
          }, busy ? '保存中…' : '保存并应用'),
        ),

        notice ? h('p', { style: S.notice }, notice) : null,

        h('p', { style: S.stats },
          `状态：${state.registered === true ? '工具已注册' : '工具未注册'}`
          + ` · 委派次数 ${stats.calls || 0}`
          + ` · 失败 ${stats.errors || 0}`
          + ` · 最近返回 ${stats.lastResultChars || 0} 字符`
          + ` · 最近路由 ${stats.lastModel || '—'}`),

        h('p', { style: S.stats },
          `自动拦截：${config.interceptEnabled === true ? '已开启' : '已关闭'}`
          + ` · 已拦截 ${stats.intercepts || 0} 次`
          + ` · 累计挡在上下文之外约 ${Math.round((stats.bytesSaved || 0) / 1024)} KB`),

        h('p', { style: S.path }, `配置持久化于 ${state.configFile || '(未知路径)'}`),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'small-model-delegate',
        order: 40,
        label: '小模型委派',
      }, () => h(SettingsPage, null)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'small-model-delegate'
    return module.exports
  },
})
