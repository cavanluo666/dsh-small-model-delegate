/**
 * dsh-small-model-delegate —— Host 半身冒烟测试。
 *
 * 在隔离的 DSH_HOME 下用一个桩 ctx 真正调用 apply()，验证：
 *   1. 首次运行从 agentDefaultModel 兜底出一条路由并默认开启；
 *   2. 工具被注册，名字/参数/输出声明正确；
 *   3. 配置落盘；
 *   4. /api/small-model-delegate 的 state / models / save / 404 接口可用；
 *   5. save 关闭后工具真的被注销；
 *   6. 真正调一次工具：provider 兜底、agentOptions、persona、返回值、dispose 都正确。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 相对本文件定位被测插件，避免把开发机的绝对路径写死进来。
const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-test-'))
process.env.DSH_HOME = tmpHome

const mod = await import(pathToFileURL(PLUGIN).href)

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── 桩环境 ────────────────────────────────────────────────────────────────────
const registered = []
const routes = []
const started = []
const sections = []
const postExecute = []
let toolDisposers = 0
let disposeCalls = 0
let sectionDisposers = 0
let failNextStart = false

const provider = { capabilities: { agentOptions: true, persona: true, toolFilter: true, outputSchema: true } }

const subagentsStub = {
  list: () => ['spawn', 'fork'],
  getProvider: () => provider,
  async start(name, request) {
    started.push({ name, request })
    if (failNextStart) {
      failNextStart = false
      throw new Error('stub: provider exploded')
    }
    return {
      id: `child-${started.length}`,
      localAgent: undefined,
      result: Promise.resolve({
        output: [{ type: 'text', text: request.prompt[0].text.includes('--- 工具输出开始 ---') ? '摘要：这里是小模型消化后的结论。' : '小模型的结论：共 3 个文件。' }],
        stopReason: 'completed',
      }),
      async dispose() { disposeCalls += 1 },
    }
  },
}

const ctx = {
  get(name) {
    if (name === 'subagents') return subagentsStub
    if (name === 'llm') {
      return {
        listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
        listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-pro', name: 'Pro' }],
      }
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }) }
    }
    if (name === 'subagentModelSelection') return { current: () => ({ enabled: false, allowedModels: [] }) }
    if (name === 'agents') return { currentInitiator: () => undefined }
    return undefined
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  inject(_deps, callback) {
    callback({
      webServer: { register(route) { routes.push(route); return () => {} } },
      systemPrompt: {
        section(definition) {
          sections.push(definition)
          return () => { sectionDisposers += 1 }
        },
      },
      effect(callback2) {
        const disposer = callback2()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      get: ctx.get,
    })
  },
  on(event, listener) {
    if (event === 'tools/post-execute') postExecute.push(listener)
    return () => {}
  },
  tools: {
    register(definition) {
      registered.push(definition)
      return () => { toolDisposers += 1 }
    },
  },
}

console.log('module exports:')
check('name export', mod.name === 'small-model-delegate', String(mod.name))
check('inject declares tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))

console.log('\napply(ctx, {}):')
mod.apply(ctx, {})

const configPath = path.join(tmpHome, 'small-model-delegate', 'config.json')
check('config file written', fs.existsSync(configPath), configPath)

const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'))
check('seeded llmProvider from agentDefaultModel', stored.config?.llmProvider === 'deepseek-official', JSON.stringify(stored.config?.llmProvider))
check('seeded model from agentDefaultModel', stored.config?.model === 'deepseek-flash', JSON.stringify(stored.config?.model))
check('auto-enabled because a route was seeded', stored.config?.enabled === true, JSON.stringify(stored.config?.enabled))
check('subagentProvider left empty = "auto (first)"', stored.config?.subagentProvider === '', JSON.stringify(stored.config?.subagentProvider))
check('default toolName', stored.config?.toolName === 'delegate_small', JSON.stringify(stored.config?.toolName))
check('store records a version', stored.version === 1, JSON.stringify(stored.version))

console.log('\ntool registration:')
check('exactly one tool registered', registered.length === 1, String(registered.length))
const tool = registered[0] || {}
check('tool name', tool.name === 'delegate_small', String(tool.name))
check('description names the route', typeof tool.description === 'string' && tool.description.includes('deepseek-official/deepseek-flash'))
check('description tells the model to use it proactively', tool.description.includes('主动使用'), String(tool.description).slice(0, 120))
check('description carries the PTC call form', tool.description.includes('tools.delegate_small'), String(tool.description).slice(-160))
check('parameters is an object root schema', tool.parameters?.type === 'object')
check('task is required', tool.parameters?.required?.includes('task') === true, JSON.stringify(tool.parameters?.required))
check('output schema is string', tool.output?.schema?.type === 'string')
check('output.render returns content blocks', JSON.stringify(tool.output.render({}, 'hi')) === '[{"type":"text","text":"hi"}]')

console.log('\nhttp route:')
check('one route registered', routes.length === 1, String(routes.length))
check('route kind is prefix', routes[0]?.kind === 'prefix', String(routes[0]?.kind))
check('route path', routes[0]?.path === '/api/small-model-delegate', String(routes[0]?.path))

console.log('\nprompt section:')
check('exactly one section registered', sections.length === 1, String(sections.length))
check('section name', sections[0]?.name === 'plugin:small-model-delegate', String(sections[0]?.name))
check('section order sits next to TOOL_SUBAGENT (2800)', sections[0]?.order === 2850, String(sections[0]?.order))
check('section text tells the model to delegate', typeof sections[0]?.text === 'string' && sections[0].text.includes('优先用它交给更便宜的小模型'), String(sections[0]?.text).slice(0, 80))
check('section text is phrased conditionally for children', sections[0]?.text.includes('当你有 delegate_small 工具时'), String(sections[0]?.text).slice(0, 40))

const handler = routes[0].handler

function fakeRes() {
  const out = { status: 0, body: undefined, headers: undefined }
  return {
    get status() { return out.status },
    get body() { return out.body },
    get headers() { return out.headers },
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body },
  }
}

const get = async (url) => {
  const res = fakeRes()
  await handler({ method: 'GET', url }, res)
  return { status: res.status, payload: res.body === undefined ? undefined : JSON.parse(res.body) }
}

const post = async (url, body) => {
  const raw = JSON.stringify(body)
  const res = fakeRes()
  await handler({
    method: 'POST',
    url,
    on(event, callback) {
      if (event === 'data') callback(Buffer.from(raw, 'utf8'))
      if (event === 'end') callback()
    },
  }, res)
  return { status: res.status, payload: res.body === undefined ? undefined : JSON.parse(res.body) }
}

console.log('\nGET /state:')
{
  const { status, payload } = await get('/api/small-model-delegate/state')
  check('status 200', status === 200, String(status))
  check('registered true', payload?.registered === true, JSON.stringify(payload?.registered))
  check('llm providers listed', payload?.llmProviders?.[0]?.id === 'deepseek-official', JSON.stringify(payload?.llmProviders))
  check('subagent providers listed with capability flags', payload?.subagentProviders?.[0]?.agentOptions === true, JSON.stringify(payload?.subagentProviders))
  check('configFile reported', payload?.configFile === configPath, String(payload?.configFile))
}

console.log('\nGET /models:')
{
  const { status, payload } = await get('/api/small-model-delegate/models?provider=deepseek-official')
  check('status 200', status === 200, String(status))
  check('two models', payload?.models?.length === 2, JSON.stringify(payload?.models))
}

console.log('\nGET unknown route:')
{
  const { status } = await get('/api/small-model-delegate/nope')
  check('status 404', status === 404, String(status))
}

console.log('\ndelegation:')
{
  const result = await tool.execute(
    { task: '数一数工作区里有多少个 .md 文件', context: '只数顶层目录' },
    { agent: { id: 'session-parent' }, signal: new AbortController().signal },
  )
  check('returns the small model text', result === '小模型的结论：共 3 个文件。', JSON.stringify(result))
  check('started exactly one subagent', started.length === 1, String(started.length))
  check('used the first provider as the auto fallback', started[0]?.name === 'spawn', String(started[0]?.name))
  const req = started[0]?.request || {}
  check('agentOptions carries the configured route', req.agentOptions?.provider === 'deepseek-official' && req.agentOptions?.model === 'deepseek-flash', JSON.stringify(req.agentOptions))
  check('agentOptions carries the seeded reasoning effort', req.agentOptions?.reasoningEffort === 'low', JSON.stringify(req.agentOptions))
  check('parent agent forwarded', req.parent?.id === 'session-parent', JSON.stringify(req.parent))
  check('signal forwarded', req.signal !== undefined)
  check('persona injected (provider supports it)', typeof req.persona === 'string' && req.persona.length > 0)
  check('prompt merges task and context', req.prompt?.[0]?.text?.includes('补充信息') === true, JSON.stringify(req.prompt?.[0]?.text))
  check('child disposed after the result', disposeCalls === 1, String(disposeCalls))

  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  check('stats.calls persisted', after.stats?.calls === 1, JSON.stringify(after.stats))
  check('stats.lastResultChars persisted', after.stats?.lastResultChars === 15, JSON.stringify(after.stats))
}

console.log('\ntool filter:')
{
  started.length = 0
  await post('/api/small-model-delegate/save', { toolDeny: 'pwsh, write' })
  await tool.execute({ task: 'x' }, { agent: { id: 'p' }, signal: new AbortController().signal })
  check('toolFilter.deny applied', JSON.stringify(started[0]?.request?.toolFilter) === '{"deny":["pwsh","write"]}', JSON.stringify(started[0]?.request?.toolFilter))
}

console.log('\ninterception of large tool results:')
{
  check('listener registered on tools/post-execute', postExecute.length === 1, String(postExecute.length))
  await post('/api/small-model-delegate/save', { toolDeny: '', interceptEnabled: true, interceptThresholdBytes: 100, interceptMaxBytes: 100000 })

  const listener = postExecute[0]
  const big = 'x'.repeat(500)
  const runPost = async (exec, result) => {
    const nextDecision = { kind: 'accept', content: [{ type: 'text', text: result.content?.[0]?.text ?? '' }] }
    return await listener(exec, result, async () => nextDecision)
  }
  const okResult = (text) => ({ isError: false, content: [{ type: 'text', text }] })
  const agent = { id: 'parent-session' }
  const baseExec = { name: 'read', agent, signal: new AbortController().signal, arguments: { file_path: 'big.js' } }

  // 1. 超过阈值且在白名单里 → 替换
  started.length = 0
  const replaced = await runPost(baseExec, okResult(big))
  check('large read result is replaced', replaced.kind === 'accept' && Array.isArray(replaced.content), JSON.stringify(replaced).slice(0, 120))
  const replacedText = replaced.content?.[0]?.text ?? ''
  check('replacement is marked as digested', replacedText.includes('[已由小模型消化]'), replacedText.slice(0, 120))
  check('replacement carries the summary', replacedText.includes('摘要：这里是小模型消化后的结论。'), replacedText.slice(-160))
  check('replacement explains how to get the original back', replacedText.includes('offset/limit'), replacedText.slice(-200))
  check('the raw 500 chars did not survive', !replacedText.includes(big), replacedText.slice(0, 80))
  check('exactly one digest subagent was started', started.length === 1, String(started.length))
  check('the digest prompt embeds the raw output', started[0]?.request?.prompt?.[0]?.text?.includes(big) === true)
  check('digest label names the tool', started[0]?.request?.label === 'digest:read', String(started[0]?.request?.label))

  let stored = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  check('intercepts counted', stored.stats.intercepts === 1, JSON.stringify(stored.stats))
  check('bytesSaved counted', stored.stats.bytesSaved > 0, JSON.stringify(stored.stats.bytesSaved))

  // 2. 小于阈值 → 原样放行
  started.length = 0
  const small = await runPost(baseExec, okResult('tiny'))
  check('small result passes through', small.content?.[0]?.text === 'tiny', JSON.stringify(small).slice(0, 80))
  check('no subagent started for a small result', started.length === 0, String(started.length))

  // 3. 不在白名单里的工具 → 放行
  started.length = 0
  const other = await runPost({ ...baseExec, name: 'todo_write' }, okResult(big))
  check('tool outside the list passes through', other.content?.[0]?.text === big)
  check('no subagent started for a listed-out tool', started.length === 0, String(started.length))

  // 4. 嵌套调用（run_code 内部）→ 必须放行，改写会破坏程序数据流
  started.length = 0
  const nested = await runPost({ ...baseExec, parent: Symbol('root') }, okResult(big))
  check('nested call passes through untouched', nested.content?.[0]?.text === big)
  check('no subagent started for a nested call', started.length === 0, String(started.length))

  // 5. 失败结果 → 放行（错误信息正是模型最需要的）
  started.length = 0
  const errored = await runPost(baseExec, { isError: true, content: [{ type: 'text', text: big }] })
  check('error result passes through untouched', errored.content?.[0]?.text === big)
  check('no subagent started for an error result', started.length === 0, String(started.length))

  // 6. 超过上限 → 放行，不冒险
  started.length = 0
  const huge = await runPost(baseExec, okResult('y'.repeat(200000)))
  check('oversized result passes through', huge.content?.[0]?.text.length === 200000)
  check('no subagent started for an oversized result', started.length === 0, String(started.length))

  // 7. fail open：小模型起不来时，原始结果必须原样到达模型
  started.length = 0
  failNextStart = true
  const beforeErrors = JSON.parse(fs.readFileSync(configPath, 'utf8')).stats.errors
  const failed = await runPost(baseExec, okResult(big))
  check('fail open: original content survives a digest failure', failed.content?.[0]?.text === big)
  const afterErrors = JSON.parse(fs.readFileSync(configPath, 'utf8')).stats.errors
  check('the failed digest is counted as an error', afterErrors === beforeErrors + 1, `${beforeErrors} → ${afterErrors}`)

  // 8. 关闭拦截 → 放行
  await post('/api/small-model-delegate/save', { interceptEnabled: false })
  started.length = 0
  const off = await runPost(baseExec, okResult(big))
  check('disabled interception passes everything through', off.content?.[0]?.text === big)
  check('no subagent started while disabled', started.length === 0, String(started.length))
  await post('/api/small-model-delegate/save', { interceptEnabled: true })
}

console.log('\nprompt hint is hot-editable via /save:')
{
  const { status, payload } = await post('/api/small-model-delegate/save', { promptHintText: '自定义提示：能委派就委派。' })
  check('save → 200', status === 200, String(status))
  check('config echoes the new text', payload?.config?.promptHintText === '自定义提示：能委派就委派。', JSON.stringify(payload?.config?.promptHintText))
  check('old section disposed', sectionDisposers === 1, String(sectionDisposers))
  check('new section registered', sections.length === 2, String(sections.length))
  check('new section carries the new text', sections[1]?.text === '自定义提示：能委派就委派。', String(sections[1]?.text))
  check('section name is stable across re-registration', sections[1]?.name === 'plugin:small-model-delegate', String(sections[1]?.name))

  const off = await post('/api/small-model-delegate/save', { promptHintEnabled: false })
  check('disable → 200', off.status === 200, String(off.status))
  check('section disposed on disable', sectionDisposers === 2, String(sectionDisposers))
  check('no further section registered', sections.length === 2, String(sections.length))

  const on = await post('/api/small-model-delegate/save', { promptHintEnabled: true })
  check('re-enable re-registers the section', on.status === 200 && sections.length === 3, String(sections.length))
  check('re-enabled section uses the stored text', sections[2]?.text === '自定义提示：能委派就委派。', String(sections[2]?.text))
}

console.log('\nunrelated saves do not churn the tool registration:')
{
  // 到目前为为止所有 save 都没动过 enabled/toolName/llmProvider/model，
  // 所以工具定义没变，注册表不该被反复摘挂。
  const before = { disposers: toolDisposers, registrations: registered.length }
  await post('/api/small-model-delegate/save', { persona: '换个说法。', maxTokens: 1024 })
  check('no dispose on an unrelated save', toolDisposers === before.disposers, `${before.disposers} → ${toolDisposers}`)
  check('no re-registration on an unrelated save', registered.length === before.registrations, `${before.registrations} → ${registered.length}`)

  // 但改名必须重新注册——这是工具定义真的变了。
  await post('/api/small-model-delegate/save', { toolName: 'delegate_task' })
  check('renaming re-registers', toolDisposers === before.disposers + 1 && registered.length === before.registrations + 1, `${toolDisposers}/${registered.length}`)
  check('the re-registered tool carries the new name', registered[registered.length - 1]?.name === 'delegate_task', String(registered[registered.length - 1]?.name))
  await post('/api/small-model-delegate/save', { toolName: 'delegate_small' })
}

console.log('\ndisable path:')
{
  const { status, payload } = await post('/api/small-model-delegate/save', { enabled: false })
  check('save → 200', status === 200, String(status))
  check('patch applied', payload?.config?.enabled === false, JSON.stringify(payload?.config?.enabled))
  check('reports unregistered', payload?.registered === false, JSON.stringify(payload?.registered))
  check('previous registration disposed exactly once', toolDisposers === 3, String(toolDisposers))
  check('no tool registered while disabled', registered.length === 3, String(registered.length))
  check('persisted enabled=false', JSON.parse(fs.readFileSync(configPath, 'utf8')).config.enabled === false)

  const blocked = await tool.execute({ task: 'x' }, { agent: { id: 'p' }, signal: new AbortController().signal })
  check('disabled tool refuses to delegate', typeof blocked === 'string' && blocked.includes('未启用'), JSON.stringify(blocked))
}

console.log(`\nresults: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`}`)
if (failures.length > 0) console.log('failed:', failures.join(' | '))

fs.rmSync(tmpHome, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
