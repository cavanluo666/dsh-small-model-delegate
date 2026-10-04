/**
 * 小模型委派（省 token）—— Host 半身。
 *
 * 主模型不再亲自读大文件、翻日志、反复试错，而是调用本插件注册的
 * `delegate_small` 工具，把一件边界清晰的子任务交给一个更便宜的小模型；
 * 小模型在**自己的会话**里完成工作，只有最终结论回到主模型上下文，
 * 它自己的中间步骤、文件读取、报错重试都不占用主模型的 token。
 *
 * 三件事：
 *   1. 注册 / 注销 `delegate_small` 工具（随配置变化即时生效）；
 *   2. 把配置持久化到 `$DSH_HOME/small-model-delegate/config.json`；
 *   3. 在 `/api/small-model-delegate/*` 上给「设置 → 小模型委派」页面提供 JSON 接口。
 *
 * 依赖策略：只把 `tools` 声明为硬依赖——没有工具注册表这个插件没有意义；
 * `subagents` / `llm` / `agents` / `webServer` 全部走 `ctx.get()` 或延迟
 * `ctx.inject()`，缺失时降级为一个可用但功能受限的插件，而不是整行不激活。
 *
 * 工具定义是手写的，不走 `@deepseek-ai/dsh-tools` 的 `defineTool()`：
 * profile 的 node_modules 里没有 `@deepseek-ai/*`，从本插件目录无法解析它。
 * 工具注册表本身只校验 `output`（见 ToolRuntime.register），`parameters`
 * 会作为普通 JSON Schema 原样投影给模型，所以手写定义是安全的。
 *
 * @module index.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'small-model-delegate'

/** 工具注册表是唯一不能缺的能力。 */
export const inject = ['tools']

/** 本插件的数据目录名，位于 DSH_HOME 之下。 */
const DATA_DIR_NAME = 'small-model-delegate'

/** 配置页使用的 HTTP 前缀。 */
const API_PREFIX = '/api/small-model-delegate'

/** 存储格式版本，便于以后迁移。 */
const STORE_VERSION = 1

/** 默认工具名。 */
const DEFAULT_TOOL_NAME = 'delegate_small'

const DEFAULT_PERSONA = [
  '你是被上级模型委派的执行者。只完成交给你的那一件事，不要扩大范围，不要反问无关问题。',
  '完成后用简洁的中文汇报：做了什么、关键结论、仍然不确定的地方。',
].join('')

const MAX_BODY_BYTES = 1024 * 1024

/**
 * 常驻系统提示段的注册名与排序位。
 *
 * 光靠工具描述不足以让模型主动委派——描述只有在模型翻工具列表时才会被读到。
 * 这一段每次请求都在系统提示里，是真正能改变"要不要委派"这个决定的杠杆。
 *
 * order 取 2850：dsh-system-prompt 的 SECTION_ORDERS 里 TOOL_SUBAGENT=2800、
 * TOOL_REPORT=2900，夹在两者之间即紧挨委派类工具自己的段落。
 */
const PROMPT_SECTION_NAME = 'plugin:small-model-delegate'
const PROMPT_SECTION_ORDER = 2850

/**
 * 默认提示文本。
 *
 * 刻意写成条件句（"当你有 delegate_small 工具时"）：提示段是全局注册的，
 * 连被委派出去的子任务也会收到它——而子任务那边这个工具正好被 toolDeny 挡掉了。
 * 条件句让它在子任务里自然失效，不需要额外的按作用域排除。
 */
const DEFAULT_PROMPT_HINT = [
  '当你有 delegate_small 工具时：只要一个子任务本身冗长或机械、而且能用一小段说明自包含地讲清楚，',
  '就优先用它交给更便宜的小模型去做，而不是自己动手——',
  '典型场景是批量改写/翻译、日志与报错归类、长文本摘要、按固定规则检查或扫描代码、从大文件里抽取信息。',
  '这样能显著降低本对话的 token 消耗。',
].join('')

/**
 * 自动拦截（省 token 的硬方案）。
 *
 * 事实依据：靠措辞劝模型主动委派，试过两次都失败了——工具描述里写了"主动使用"，
 * 系统提示里也常驻了一段"优先委派"，但遇到"读取整个工作区"这种教科书级的委派场景，
 * 模型依然自己规划一路读下去。模型"我自己来"的先验太强。
 *
 * 所以这里换一条路：不问模型，直接在 `tools/post-execute` 上拦截。
 * 某个工具的结果超过阈值时，先交给小模型消化，只把摘要放进主上下文。
 *
 * 三条纪律：
 *   1. **fail open**——任何一步出问题（没配路由、小模型报错、超时、形状不对）
 *      都原样放行，绝不因为拦截器自己坏掉而毁掉一次工具调用；
 *   2. **防递归**——我们自己派出去的子任务，它们的工具调用一律不拦；
 *   3. **留退路**——摘要里必须写明"要精确原文就缩小范围重调"，让模型有路可走。
 */
const DEFAULT_INTERCEPT_TOOLS = 'read, grep, pwsh'
const DEFAULT_INTERCEPT_THRESHOLD_BYTES = 20000
const DEFAULT_INTERCEPT_MAX_BYTES = 400000
const DEFAULT_INTERCEPT_TIMEOUT_MS = 180000

const DEFAULT_INTERCEPT_PROMPT = [
  '下面是一次工具调用的完整输出，请把它压缩成给上级模型看的摘要。',
  '保留：结论、关键数据、错误信息、文件名与行号等定位线索、以及任何"下一步该做什么"的暗示。',
  '去掉：重复内容、无关上下文、大段原文。',
  '不要复述原文，不要评价这次调用，不要添加原文没有的信息。',
].join('')


/** 解析 DSH 主目录，与其它插件保持一致。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 全新安装时的配置。 */
function defaultConfig() {
  return {
    enabled: false,
    toolName: DEFAULT_TOOL_NAME,
    subagentProvider: '',
    llmProvider: '',
    model: '',
    reasoningEffort: '',
    maxTokens: 0,
    persona: DEFAULT_PERSONA,
    toolAllow: '',
    toolDeny: '',
    promptHintEnabled: true,
    promptHintText: DEFAULT_PROMPT_HINT,
    interceptEnabled: true,
    interceptTools: DEFAULT_INTERCEPT_TOOLS,
    interceptThresholdBytes: DEFAULT_INTERCEPT_THRESHOLD_BYTES,
    interceptMaxBytes: DEFAULT_INTERCEPT_MAX_BYTES,
    interceptTimeoutMs: DEFAULT_INTERCEPT_TIMEOUT_MS,
    interceptPrompt: DEFAULT_INTERCEPT_PROMPT,
  }
}

const EMPTY_STATS = { calls: 0, errors: 0, lastResultChars: 0, lastModel: '', intercepts: 0, bytesSaved: 0 }

/** 把任意异常压成一行可读文本。 */
function textOf(error) {
  if (error === undefined || error === null) return 'unknown error'
  return String(error.message !== undefined ? error.message : error)
}

/** 逗号/空白分隔的列表 → 去空后的数组。 */
function splitList(value) {
  if (typeof value !== 'string' || value.length === 0) return []
  const out = []
  for (const part of value.split(/[,，;；\s]+/)) {
    const trimmed = part.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/** 从内容块数组里取出纯文本。 */
function collectText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读取并解析 JSON 请求体，带大小上限。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', fail)
  })
}

export function apply(ctx, config) {
  const home = resolveDshHome()
  const dataDir = path.join(home, DATA_DIR_NAME)
  const configFile = path.join(dataDir, 'config.json')

  // ── 存储 ────────────────────────────────────────────────────────────────────
  let cfg = defaultConfig()
  let stats = Object.assign({}, EMPTY_STATS)
  let seeded = false

  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    console.error(`small-model-delegate: cannot create ${dataDir}: ${textOf(error)}`)
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      if (parsed.config !== null && typeof parsed.config === 'object') {
        for (const key of Object.keys(cfg)) {
          const value = parsed.config[key]
          if (value === undefined || value === null) continue
          if (typeof value === typeof cfg[key]) cfg[key] = value
        }
      }
      if (parsed.stats !== null && typeof parsed.stats === 'object') {
        stats = Object.assign({}, EMPTY_STATS, parsed.stats)
      }
      seeded = true
    }
  } catch {
    // 首次运行：文件不存在，或内容损坏 —— 都从默认值开始。
  }

  /** 把当前配置与统计落盘。写失败只记录，不影响运行。 */
  function persist() {
    const payload = { version: STORE_VERSION, config: cfg, stats }
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(configFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.error(`small-model-delegate: cannot persist ${configFile}: ${textOf(error)}`)
    }
  }

  // ── 首次运行：给一个能立刻工作的默认路由 ───────────────────────────────────
  if (!seeded) {
    const choice = Object.assign({}, cfg)
    try {
      const selection = ctx.get('subagentModelSelection')
      const current = selection !== undefined ? selection.current() : undefined
      const routes = current && Array.isArray(current.allowedModels) ? current.allowedModels : []
      if (current && current.enabled === true && routes.length > 0) {
        const route = routes[0]
        if (route && typeof route.provider === 'string' && typeof route.model === 'string') {
          choice.llmProvider = route.provider
          choice.model = route.model
        }
      }
    } catch {
      // 该设置不存在或形状不符：继续走下一个兜底。
    }
    if (choice.llmProvider === '' || choice.model === '') {
      try {
        const fallback = ctx.get('agentDefaultModel')
        const current = fallback !== undefined ? fallback.currentSelection() : undefined
        if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
          choice.llmProvider = current.provider
          choice.model = current.model
          if (typeof current.reasoningEffort === 'string') choice.reasoningEffort = current.reasoningEffort
        }
      } catch {
        // 没有默认模型：留给设置在页面里手选。
      }
    }
    cfg = choice
    // 只有真的拿到一条路由才默认开启，否则留一个干净的“未配置”状态给页面。
    cfg.enabled = cfg.llmProvider !== '' && cfg.model !== ''
    persist()
  }

  // ── 能力查询 ────────────────────────────────────────────────────────────────
  const subagents = () => ctx.get('subagents')

  function providerNames() {
    const service = subagents()
    if (service === undefined) return []
    try {
      const names = service.list()
      return Array.isArray(names) ? names.map((value) => String(value)) : []
    } catch {
      return []
    }
  }

  function providerDirectory() {
    const service = subagents()
    const out = []
    for (const providerName of providerNames()) {
      let provider
      try {
        provider = service.getProvider(providerName)
      } catch {
        provider = undefined
      }
      const capabilities = provider && typeof provider === 'object' && provider.capabilities
        ? provider.capabilities
        : {}
      out.push({
        name: providerName,
        agentOptions: capabilities.agentOptions === true,
        persona: capabilities.persona === true,
        toolFilter: capabilities.toolFilter === true,
      })
    }
    return out
  }

  async function llmDirectory() {
    const service = ctx.get('llm')
    if (service === undefined) return []
    let raw
    try {
      raw = await Promise.resolve(service.listProviders())
    } catch {
      return []
    }
    const out = []
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item.id === 'string') {
          out.push({ id: item.id, name: typeof item.name === 'string' ? item.name : item.id })
        }
      }
    }
    return out
  }

  async function listModels(provider) {
    const service = ctx.get('llm')
    if (service === undefined || provider === '') return { models: [] }
    let raw
    try {
      raw = await service.listModels(provider)
    } catch (error) {
      return { models: [], error: textOf(error) }
    }
    const models = []
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item.id === 'string') {
          models.push({ id: item.id, name: typeof item.name === 'string' ? item.name : item.id })
        }
      }
    }
    return { models }
  }

  // ── 模型可见的工具 ──────────────────────────────────────────────────────────
  function describeTool() {
    const route = cfg.llmProvider !== '' && cfg.model !== ''
      ? `${cfg.llmProvider}/${cfg.model}`
      : '（未配置）'
    return [
      `把一件边界清晰、可以自包含描述的子任务交给一个更便宜的小模型(${route})去执行，`,
      '只把它最终的结论带回当前上下文，中间步骤不占用主模型的 token。',
      // 下面这段是"要不要用"的触发条件。在 PTC 模式下它渲染成 SDK 里的文档注释，
      // 是模型能看到的唯一说明，所以写得直白些。
      '主动使用：只要一个子任务能用一小段说明讲清楚，而且它本身冗长或机械，就应当委派而不是自己动手——',
      '例如批量改写/翻译、日志与报错归类、长文本摘要、按固定规则检查或扫描代码、生成样板代码、从大文件里抽取信息。',
      '不适合：需要与用户确认的决策，或必须依赖当前对话大量原文才能说清的任务。',
      'task 必须自包含：小模型看不到当前对话，请把已知的文件路径、约束、验收标准写进 task 或 context。',
      '返回值是小模型的最终回答文本；若结果不合格，可改写 task 后再次调用。',
      // PTC 模式下所有工具都被折叠进 run_code，没有独立的 delegate_small 条目。
      '在 PTC 模式下它不会作为独立工具出现：请在 run_code 里用 return await tools.delegate_small({ task, context }) 调用它。',
    ].join(' ')
  }

  /** 我们自己派出去的子会话 id；它们的工具调用绝不能再被拦截。 */
  const childIds = new Set()
  /** 正在跑子任务的重入计数。拦截器一旦在子任务里再触发，就会自我递归。 */
  let childDepth = 0

  /** 解析一次委派需要的全部前提；失败时给出给模型看的原因。 */
  function resolveDelegation() {
    if (cfg.enabled !== true) {
      return { ok: false, reason: '小模型委派当前未启用：请在「设置 → 小模型委派」中打开开关并选择小模型。' }
    }
    const service = subagents()
    if (service === undefined) return { ok: false, reason: '委派失败：本进程没有 subagents 服务。' }

    const providerName = cfg.subagentProvider !== '' ? cfg.subagentProvider : providerNames()[0]
    if (providerName === undefined || providerName === '') {
      return { ok: false, reason: '委派失败：没有已注册的 subagent provider。' }
    }
    const provider = service.getProvider(providerName)
    if (provider === undefined) {
      const known = providerNames().join(', ') || '(无)'
      return { ok: false, reason: `委派失败：subagent provider "${providerName}" 未注册。已注册：${known}` }
    }
    if (cfg.llmProvider === '' || cfg.model === '') {
      return { ok: false, reason: '委派失败：尚未配置小模型路由（provider + model），请在「设置 → 小模型委派」中选择。' }
    }
    const capabilities = provider.capabilities ? provider.capabilities : {}
    if (capabilities.agentOptions !== true) {
      return {
        ok: false,
        reason: `委派失败：provider "${providerName}" 不支持模型覆盖(agentOptions)，无法指定小模型，请换一个 provider。`,
      }
    }
    return { ok: true, service, providerName, capabilities }
  }

  /** 找出发起这次工具调用的 Agent。 */
  function callerAgent(exec) {
    let parent = exec ? exec.agent : undefined
    if (parent === undefined) {
      const agents = ctx.get('agents')
      if (agents !== undefined) {
        try {
          parent = agents.currentInitiator()
        } catch {
          parent = undefined
        }
      }
    }
    return parent
  }

  /** 给等待小模型加上限，避免一个卡住的免费模型拖死整个回合。 */
  function withTimeout(promise, timeoutMs) {
    const timer = ctx.get('timer')
    if (timer === undefined || !(timeoutMs > 0)) return promise
    return Promise.race([
      promise,
      timer.timeout(timeoutMs).then(() => {
        throw new Error(`等待小模型超时（${timeoutMs}ms）`)
      }),
    ])
  }

  /**
   * 跑一次子任务。
   *
   * 返回 `{ ok: true, output, stopReason }` 或 `{ ok: false, error }`——
   * 由调用方决定是把它当错误报给模型，还是 fail open 原样放行。
   * `timeoutMs` 为 0 表示不限时（模型可见的 delegate_small 走这条路，
   * 因为它本来就是一次有意的、用户可中断的调用）。
   */
  async function runChild(resolved, promptText, signal, parent, label, timeoutMs) {
    const agentOptions = { provider: cfg.llmProvider, model: cfg.model }
    if (cfg.reasoningEffort !== '') agentOptions.reasoningEffort = cfg.reasoningEffort
    if (cfg.maxTokens > 0) agentOptions.maxTokens = cfg.maxTokens

    const request = {
      label,
      prompt: [{ type: 'text', text: promptText }],
      parent,
      signal,
      agentOptions,
    }
    if (cfg.persona !== '' && resolved.capabilities.persona === true) request.persona = cfg.persona

    const allow = splitList(cfg.toolAllow)
    const deny = splitList(cfg.toolDeny)
    if ((allow.length > 0 || deny.length > 0) && resolved.capabilities.toolFilter === true) {
      const filter = {}
      if (allow.length > 0) filter.allow = allow
      if (deny.length > 0) filter.deny = deny
      request.toolFilter = filter
    }

    childDepth += 1
    let run
    try {
      run = await resolved.service.start(resolved.providerName, request)
    } catch (error) {
      childDepth -= 1
      return { ok: false, error: `委派启动失败：${textOf(error)}` }
    }

    if (run !== undefined && run !== null && run.id !== undefined) childIds.add(String(run.id))

    try {
      const result = await withTimeout(run.result, timeoutMs)
      const output = collectText(result ? result.output : undefined)
      const stopReason = result && result.stopReason !== undefined ? String(result.stopReason) : 'unknown'
      if (output === '') {
        const diagnostic = result && result.diagnostic !== undefined ? `；诊断：${String(result.diagnostic)}` : ''
        return { ok: false, error: `小模型没有返回文本结果（stopReason=${stopReason}${diagnostic}）。` }
      }
      return { ok: true, output, stopReason }
    } catch (error) {
      return { ok: false, error: `委派执行失败：${textOf(error)}` }
    } finally {
      if (run !== undefined && run !== null && typeof run.dispose === 'function') {
        try {
          await run.dispose()
        } catch (error) {
          console.error(`small-model-delegate: subagent dispose failed: ${textOf(error)}`)
        }
      }
      if (run !== undefined && run !== null && run.id !== undefined) childIds.delete(String(run.id))
      childDepth -= 1
    }
  }

  async function delegate(args, exec) {
    const resolved = resolveDelegation()
    if (!resolved.ok) return resolved.reason

    const signal = exec ? exec.signal : undefined
    if (signal === undefined || signal === null) {
      return '委派失败：当前工具调用没有取消信号，无法安全地创建子任务。'
    }

    const parent = callerAgent(exec)
    if (parent === undefined) return '委派失败：当前调用没有可用的 Agent 身份。'

    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (task === '') return '委派失败：task 不能为空。'
    const extra = typeof args.context === 'string' ? args.context.trim() : ''
    const promptText = extra !== '' ? `${task}\n\n--- 补充信息 ---\n${extra}` : task

    stats = Object.assign({}, stats, {
      calls: (stats.calls || 0) + 1,
      lastModel: `${cfg.llmProvider}/${cfg.model}`,
    })
    persist()

    const outcome = await runChild(resolved, promptText, signal, parent, 'small-model', 0)
    if (!outcome.ok) {
      stats = Object.assign({}, stats, { errors: (stats.errors || 0) + 1 })
      persist()
      return outcome.error
    }

    stats = Object.assign({}, stats, { lastResultChars: outcome.output.length })
    persist()
    const head = outcome.stopReason === 'completed' ? '' : `（注意：小模型提前结束，stopReason=${outcome.stopReason}）\n`
    return head + outcome.output
  }

  // ── 自动拦截：大结果先交小模型消化，只把摘要放进主上下文 ──────────────────
  function interceptToolNames() {
    return splitList(cfg.interceptTools)
  }

  /** 只读结果内容里的叶子字段，不碰任何活对象。 */
  function resultText(result) {
    const content = result !== undefined && result !== null && Array.isArray(result.content) ? result.content : []
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  }

  /** 返回拦截计划，或 undefined 表示放行。任何疑问都放行。 */
  function planInterception(exec, result) {
    if (cfg.interceptEnabled !== true) return undefined
    if (cfg.enabled !== true) return undefined
    if (exec === undefined || exec === null || result === undefined || result === null) return undefined

    // 嵌套调用（run_code 内部）的结果要回给程序本身，改写它就是破坏数据流。
    if (exec.parent !== undefined) return undefined
    if (result.isError === true) return undefined

    const name = typeof exec.name === 'string' ? exec.name : ''
    if (name === '' || !interceptToolNames().includes(name)) return undefined

    // 防递归：正在跑子任务时一律不拦（子任务自己的工具调用、以及它内部再委派）。
    if (childDepth > 0) return undefined
    const agent = callerAgent(exec)
    if (agent === undefined) return undefined
    if (childIds.has(String(agent.id))) return undefined

    const text = resultText(result)
    if (text.length < cfg.interceptThresholdBytes) return undefined
    if (text.length > cfg.interceptMaxBytes) return undefined

    return { name, text, agent }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()

    let plan
    try {
      plan = planInterception(exec, result)
    } catch (error) {
      console.error(`small-model-delegate: 拦截判定失败，原样放行: ${textOf(error)}`)
      return decision
    }
    if (plan === undefined) return decision
    if (decision === undefined || decision === null || decision.kind !== 'accept') return decision

    const resolved = resolveDelegation()
    if (!resolved.ok) return decision
    const signal = exec.signal
    if (signal === undefined || signal === null) return decision

    const prompt = [
      cfg.interceptPrompt,
      '',
      `触发工具：${plan.name}`,
      `原始输出长度：${plan.text.length} 字符。`,
      '',
      '--- 工具输出开始 ---',
      plan.text,
      '--- 工具输出结束 ---',
    ].join('\n')

    let outcome
    try {
      outcome = await runChild(resolved, prompt, signal, plan.agent, `digest:${plan.name}`, cfg.interceptTimeoutMs)
    } catch (error) {
      console.error(`small-model-delegate: 拦截执行异常，原样放行: ${textOf(error)}`)
      return decision
    }

    if (!outcome.ok) {
      // fail open：摘要没拿到就把原始结果原样交给模型，绝不吞掉一次工具调用。
      stats = Object.assign({}, stats, { errors: (stats.errors || 0) + 1 })
      persist()
      console.error(`small-model-delegate: 摘要失败，原样放行（${plan.name}）: ${outcome.error}`)
      return decision
    }

    const saved = plan.text.length - outcome.output.length
    stats = Object.assign({}, stats, {
      calls: (stats.calls || 0) + 1,
      lastModel: `${cfg.llmProvider}/${cfg.model}`,
      lastResultChars: outcome.output.length,
      intercepts: (stats.intercepts || 0) + 1,
      bytesSaved: (stats.bytesSaved || 0) + (saved > 0 ? saved : 0),
    })
    persist()

    const replacement = [
      `[已由小模型消化] 工具 ${plan.name} 的原始输出共 ${plan.text.length} 字符，未进入你的上下文。`,
      '下面是摘要。如果你需要精确原文或精确行号，请用更窄的范围重新调用该工具'
      + '（例如 read 的 offset/limit、grep 的 include/path）。',
      '',
      outcome.output,
    ].join('\n')

    return { kind: 'accept', content: [{ type: 'text', text: replacement }] }
  })

  function buildTool() {
    return {
      name: cfg.toolName,
      description: describeTool(),
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '自包含的任务说明：要做什么、在哪个文件/目录做、验收标准是什么。',
          },
          context: {
            type: 'string',
            description: '可选补充：已知事实、约束、期望输出格式。',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      execute(args, exec) {
        return delegate(args === null || typeof args !== 'object' ? {} : args, exec)
      },
    }
  }

  let toolDispose
  /** 决定工具定义内容的那几个字段；只有它们变了才值得注销重注册。 */
  let toolSignature

  function currentToolSignature() {
    return [cfg.enabled === true ? '1' : '0', cfg.toolName, cfg.llmProvider, cfg.model].join('\u0000')
  }

  function rebuildTool() {
    const signature = currentToolSignature()
    const wantRegistered = cfg.enabled === true

    // 已经就是要的状态：什么都不做。改 persona、toolDeny、提示文本这些
    // 不影响工具定义的字段时，不该把工具从注册表里摘掉再放回去。
    if (toolDispose !== undefined && toolSignature === signature) return
    if (toolDispose === undefined && !wantRegistered) return

    if (toolDispose !== undefined) {
      try {
        toolDispose()
      } catch (error) {
        console.error(`small-model-delegate: tool dispose failed: ${textOf(error)}`)
      }
      toolDispose = undefined
    }
    toolSignature = undefined

    if (!wantRegistered) return
    try {
      toolDispose = ctx.tools.register(buildTool())
      toolSignature = signature
    } catch (error) {
      toolDispose = undefined
      toolSignature = undefined
      console.error(`small-model-delegate: tool registration failed: ${textOf(error)}`)
    }
  }

  // ── 常驻系统提示段 ──────────────────────────────────────────────────────────
  // systemPrompt 可能比本行更晚发布，所以走 ctx.inject 延迟获取，拿到之后再注册；
  // 配置变化时由 rebuildPromptHint() 注销旧的、注册新的。
  let promptDispose
  let systemPromptService
  /** 当前真正注册着的那段文本；'' 表示没有注册。用来避免无谓的重复注册。 */
  let promptTextLive = ''

  function rebuildPromptHint() {
    const wanted = cfg.promptHintEnabled === true && typeof cfg.promptHintText === 'string'
      ? cfg.promptHintText.trim()
      : ''

    // 已经就是要的状态：什么都不做。注册/注销会发 system-prompt/change，
    // 不能因为用户改了别的字段就把整个提示重新装配一遍。
    if (promptDispose !== undefined && promptTextLive === wanted) return
    if (promptDispose === undefined && wanted === '') return

    if (promptDispose !== undefined) {
      try {
        promptDispose()
      } catch (error) {
        console.error(`small-model-delegate: prompt section dispose failed: ${textOf(error)}`)
      }
      promptDispose = undefined
    }
    promptTextLive = ''

    if (systemPromptService === undefined || wanted === '') return
    try {
      promptDispose = systemPromptService.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        text: wanted,
      })
      promptTextLive = wanted
    } catch (error) {
      promptDispose = undefined
      promptTextLive = ''
      console.error(`small-model-delegate: prompt section registration failed: ${textOf(error)}`)
    }
  }

  ctx.inject(['systemPrompt'], (scoped) => {
    systemPromptService = scoped.systemPrompt
    scoped.effect(() => () => {
      if (promptDispose !== undefined) {
        try {
          promptDispose()
        } catch {
          // scope teardown
        }
        promptDispose = undefined
      }
      promptTextLive = ''
    })
    rebuildPromptHint()
  })

  ctx.effect(() => () => {
    if (toolDispose !== undefined) {
      try {
        toolDispose()
      } catch {
        // fiber teardown
      }
      toolDispose = undefined
    }
    toolSignature = undefined
    if (promptDispose !== undefined) {
      try {
        promptDispose()
      } catch {
        // fiber teardown
      }
      promptDispose = undefined
    }
    promptTextLive = ''
  })

  // ── 配置页接口 ──────────────────────────────────────────────────────────────
  async function snapshot() {
    return {
      config: Object.assign({}, cfg),
      stats: Object.assign({}, stats),
      registered: toolDispose !== undefined,
      configFile,
      subagentProviders: providerDirectory(),
      llmProviders: await llmDirectory(),
    }
  }

  /** 只接受已知键与匹配的类型，避免页面把垃圾写进配置。 */
  function applyPatch(patch) {
    const stringKeys = [
      'subagentProvider', 'llmProvider', 'model', 'reasoningEffort',
      'persona', 'toolAllow', 'toolDeny', 'toolName', 'promptHintText',
      'interceptTools', 'interceptPrompt',
    ]
    for (const key of stringKeys) {
      if (typeof patch[key] === 'string') cfg[key] = patch[key]
    }
    if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled
    if (typeof patch.promptHintEnabled === 'boolean') cfg.promptHintEnabled = patch.promptHintEnabled
    if (typeof patch.interceptEnabled === 'boolean') cfg.interceptEnabled = patch.interceptEnabled
    if (typeof patch.maxTokens === 'number' && Number.isFinite(patch.maxTokens) && patch.maxTokens >= 0) {
      cfg.maxTokens = Math.floor(patch.maxTokens)
    }
    const numberKeys = ['interceptThresholdBytes', 'interceptMaxBytes', 'interceptTimeoutMs']
    for (const key of numberKeys) {
      if (typeof patch[key] === 'number' && Number.isFinite(patch[key]) && patch[key] >= 0) {
        cfg[key] = Math.floor(patch[key])
      }
    }
    // 上限低于阈值等于永远不拦，那是配置错误而不是意图，纠正它。
    if (cfg.interceptMaxBytes < cfg.interceptThresholdBytes) {
      cfg.interceptMaxBytes = cfg.interceptThresholdBytes
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.toolName)) cfg.toolName = DEFAULT_TOOL_NAME
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.model) && cfg.model !== '') {
      // provider 自有的 model id 通常更长也更自由，只在长度失控时兜底。
      if (cfg.model.length > 200) cfg.model = ''
    }
  }

  async function handleApi(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rest = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
      if (req.method === 'GET' && rest === '/state') {
        sendJson(res, 200, await snapshot())
        return
      }
      if (req.method === 'GET' && rest === '/models') {
        sendJson(res, 200, await listModels(url.searchParams.get('provider') ?? ''))
        return
      }
      if (req.method === 'POST' && rest === '/save') {
        const patch = await readJsonBody(req)
        applyPatch(patch !== null && typeof patch === 'object' ? patch : {})
        persist()
        rebuildTool()
        rebuildPromptHint()
        sendJson(res, 200, await snapshot())
        return
      }
      sendJson(res, 404, { error: `unknown route ${rest}` })
    } catch (error) {
      sendJson(res, 500, { error: textOf(error) })
    }
  }

  // webServer 在插件加载时可能还没发布，用延迟注入等待它出现。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi }),
      'small-model-delegate: settings API',
    )
    console.log(`small-model-delegate: settings API mounted at ${API_PREFIX}`)
  })

  rebuildTool()
  // 如果 systemPrompt 在 apply 时已经可用，ctx.inject 的回调可能尚未跑；
  // 这里先试一次，回调里还会再调一次（rebuildPromptHint 自身幂等）。
  rebuildPromptHint()

  // 组合层传入的 config 保留给以后扩展；当前所有配置都由配置页拥有。
  void config
}
