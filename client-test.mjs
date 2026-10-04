/**
 * dsh-small-model-delegate —— 浏览器半身冒烟测试。
 *
 * 宿主侧没有 React（它被打进浏览器产物里），所以这里用一个桩 React 把 bundle
 * 真正跑一遍：
 *   1. 以 `window.__ModuleLoader__.load` 的方式加载 client.js；
 *   2. 调 factory 拿到 exports；
 *   3. 调 apply()，检查它注册了哪个 settings.section；
 *   4. 直接调用配置页组件，用桩 useState 回放「加载中」与「已加载」两种初始状态，
 *      遍历返回的元素树，确认关键文案与下拉项都在。
 *
 * 这能抓住让设置页在重启后白屏的那一类错误：拼写、未定义引用、注册描述符写错。
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 相对本文件定位被测 bundle，避免把开发机的绝对路径写死进来。
const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js')

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── 桩 React ──────────────────────────────────────────────────────────────────
function makeReact(seedStates) {
  let cursor = 0
  return {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props)
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { __el: true, type, props: merged }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (index < seedStates.length) return [seedStates[index], () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    resetCursor() { cursor = 0 },
  }
}

/** 遍历元素树收集所有文本；函数组件就地渲染。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (node.__el) {
    if (typeof node.type === 'function') return collectText(node.type(node.props || {}), out)
    collectText(node.props ? node.props.children : undefined, out)
    return out
  }
  return out
}

/** 遍历元素树收集所有 option 的 (value, label)；函数组件就地渲染。 */
function collectOptions(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const child of node) collectOptions(child, out); return out }
  if (!node.__el) return out
  if (typeof node.type === 'function') return collectOptions(node.type(node.props || {}), out)
  if (node.type === 'option') {
    out.push({ value: node.props ? node.props.value : undefined, label: collectText(node.props ? node.props.children : undefined).join('') })
  }
  collectOptions(node.props ? node.props.children : undefined, out)
  return out
}

// ── 1. 加载 bundle ────────────────────────────────────────────────────────────
const code = fs.readFileSync(BUNDLE, 'utf8')
let captured
const sandboxWindow = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
vm.runInNewContext(code, { window: sandboxWindow, console }, { filename: 'client.js' })

console.log('bundle load:')
check('called window.__ModuleLoader__.load', captured !== undefined)
check('loader id', captured?.id === 'dsh-small-model-delegate', String(captured?.id))
check('factory is a function', typeof captured?.factory === 'function')

// ── 2. 取 exports ─────────────────────────────────────────────────────────────
const loadedState = {
  config: {
    enabled: true,
    toolName: 'delegate_small',
    subagentProvider: 'spawn',
    llmProvider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
    maxTokens: 4096,
    persona: '你是被委派的执行者。',
    toolAllow: 'read, grep',
    toolDeny: 'pwsh, write',
    promptHintEnabled: true,
    promptHintText: '自定义常驻提示文本。',
    interceptEnabled: true,
    interceptTools: 'read, grep, pwsh',
    interceptThresholdBytes: 20000,
    interceptMaxBytes: 400000,
    interceptTimeoutMs: 180000,
    interceptPrompt: '自定义摘要指令。',
  },
  stats: { calls: 7, errors: 1, lastResultChars: 123, lastModel: 'deepseek-official/deepseek-flash', intercepts: 3, bytesSaved: 123456 },
  registered: true,
  configFile: '$DSH_HOME/small-model-delegate/config.json',
  subagentProviders: [
    { name: 'spawn', agentOptions: true, persona: true, toolFilter: true },
    { name: 'fork', agentOptions: false, persona: false, toolFilter: false },
  ],
  llmProviders: [{ id: 'deepseek-official', name: 'DeepSeek' }],
}

const react = makeReact([loadedState, [], '', '', false])
const hostRequire = (name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require(${JSON.stringify(name)}) — the shell only provides react`)
}
const mod = captured.factory(hostRequire)

console.log('\nexports:')
check('exports.name', mod.name === 'small-model-delegate', String(mod.name))
check('exports.apply is a function', typeof mod.apply === 'function')
check('exports.inject declares slots', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject))

// ── 3. apply 注册 ─────────────────────────────────────────────────────────────
let registered
const injectedKeys = []
const fakeCtx = {
  slots: {
    inject(key, callback) {
      injectedKeys.push(key)
      callback()
      return () => {}
    },
    register(descriptor, component) {
      registered = { descriptor, component }
      return () => {}
    },
  },
}

console.log('\napply(ctx):')
mod.apply(fakeCtx)
check('injected settings.section', injectedKeys.includes('settings.section'), JSON.stringify(injectedKeys))
check('registered exactly one entry', registered !== undefined)
check('descriptor.name', registered?.descriptor?.name === 'settings.section', String(registered?.descriptor?.name))
check('descriptor.id is fresh and stable', registered?.descriptor?.id === 'small-model-delegate', String(registered?.descriptor?.id))
check('descriptor.order', registered?.descriptor?.order === 40, String(registered?.descriptor?.order))
check('descriptor.label', registered?.descriptor?.label === '小模型委派', String(registered?.descriptor?.label))
check('component is a function', typeof registered?.component === 'function')

// ── 4. 渲染「已加载」状态 ──────────────────────────────────────────────────────
console.log('\nrender (loaded):')
const tree = registered.component()
// 桩 React 没有真正的 memo，遍历两次就会把 useState 游标推过种子值；
// 每次遍历前手动归零，等价于 React 的一次新渲染。
react.resetCursor()
const allText = collectText(tree).join(' ')
check('renders without throwing', tree !== undefined)
check('mentions the tool name', allText.includes('delegate_small'), allText.slice(0, 200))
check('has the page title', allText.includes('小模型委派'), allText.slice(0, 200))
check('explains the token saving', allText.includes('token'), allText.slice(0, 200))
check('shows the tool as registered', allText.includes('工具已注册'), allText.slice(-300))
check('shows the delegation stats', allText.includes('委派次数 7') && allText.includes('失败 1'), allText.slice(-300))
check('shows the persisted config path', allText.includes('small-model-delegate\\config.json') || allText.includes('config.json'), allText.slice(-300))
check('has a save button label', allText.includes('保存并应用'), allText.slice(-300))

react.resetCursor()
const options = collectOptions(tree)
const optionValues = options.map(option => option.value)
check('subagent providers offered', optionValues.includes('spawn') && optionValues.includes('fork'), JSON.stringify(optionValues))
check('llm providers offered', optionValues.includes('deepseek-official'), JSON.stringify(optionValues))
check(
  'provider that cannot override models is labelled',
  options.some(option => option.value === 'fork' && option.label.includes('不支持模型覆盖')),
  JSON.stringify(options.filter(option => option.value === 'fork')),
)
check('allow/deny text reflects config', allText.includes('read, grep') && allText.includes('pwsh, write'), allText.slice(0, 400))

// 常驻提示段的新控件
check('renders the standing-prompt toggle', allText.includes('常驻一段'), allText.slice(0, 400))
// 注意：textarea 的值是 prop 不是子文本，collectText 看不到它——下面用 flat 遍历查。
check('renders the prompt-hint field label', allText.includes('常驻提示文本'), allText.slice(0, 400))
{
  const flat = []
  const walkFlat = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) { for (const child of node) walkFlat(child); return }
    if (!node.__el) return
    if (typeof node.type === 'function') { walkFlat(node.type(node.props || {})); return }
    if (node.type === 'textarea' || node.type === 'input') flat.push(node)
    walkFlat(node.props ? node.props.children : undefined)
  }
  react.resetCursor()
  walkFlat(tree)
  const hintBox = flat.find(node => node.type === 'textarea' && String(node.props.value).includes('自定义常驻提示文本'))
  check('prompt hint textarea is bound to the config value', hintBox !== undefined)
  check('prompt hint textarea is editable (has onChange)', typeof hintBox?.props?.onChange === 'function')
  const hintToggle = flat.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === true)
  check('standing-prompt checkbox reflects config', hintToggle !== undefined)

  // 自动拦截的新控件
  const promptBox = flat.find(node => node.type === 'textarea' && String(node.props.value).includes('自定义摘要指令'))
  check('intercept prompt textarea is bound to the config value', promptBox !== undefined)
  const toolsBox = flat.find(node => node.type === 'input' && String(node.props.value).includes('read, grep, pwsh'))
  check('intercept tool list input is bound to the config value', toolsBox !== undefined)
  const thresholdBox = flat.find(node => node.type === 'input' && node.props.type === 'number' && String(node.props.value) === '20000')
  check('intercept threshold input is bound to the config value', thresholdBox !== undefined)
}

check('renders the interception section', allText.includes('自动拦截'), allText.slice(0, 400))
check('interception stats line shows the counters', allText.includes('已拦截 3 次') && allText.includes('121 KB'), allText.slice(-400))
check('interception section warns it does not rely on the model', allText.includes('不依赖模型自觉'), allText.slice(0, 500))

// ── 5. 渲染「未配置」告警 ─────────────────────────────────────────────────────
console.log('\nrender (unconfigured):')
{
  const bare = Object.assign({}, loadedState, {
    config: Object.assign({}, loadedState.config, { llmProvider: '', model: '' }),
  })
  const react2 = makeReact([bare, [], '', '', false])
  const mod2 = captured.factory((name) => {
    if (name === 'react') return react2
    throw new Error(`unexpected require(${name})`)
  })
  let captured2
  mod2.apply({
    slots: {
      inject(_key, callback) { callback(); return () => {} },
      register(_descriptor, component) { captured2 = component; return () => {} },
    },
  })
  const text2 = collectText(captured2()).join(' ')
  check('warns that no route is selected', text2.includes('还没有选定小模型路由'), text2.slice(0, 300))
}

// ── 6. 渲染「加载中」状态 ─────────────────────────────────────────────────────
console.log('\nrender (loading):')
{
  const react3 = makeReact([null])
  const mod3 = captured.factory((name) => {
    if (name === 'react') return react3
    throw new Error(`unexpected require(${name})`)
  })
  let captured3
  mod3.apply({
    slots: {
      inject(_key, callback) { callback(); return () => {} },
      register(_descriptor, component) { captured3 = component; return () => {} },
    },
  })
  const text3 = collectText(captured3()).join(' ')
  check('shows a loading hint before data arrives', text3.includes('正在读取配置'), text3)
}

console.log(`\nresults: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`}`)
if (failures.length > 0) console.log('failed:', failures.join(' | '))
process.exit(failures.length === 0 ? 0 : 1)
