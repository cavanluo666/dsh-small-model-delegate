# dsh-small-model-delegate

让大模型指挥小模型干活，省 token。

主模型不再亲自读大文件、翻日志、反复试错，而是调用本插件注册的
`delegate_small` 工具，把一件边界清晰的子任务交给一个更便宜的小模型。
小模型在**自己的会话**里完成工作，只有最终结论回到主模型上下文——它自己的
中间步骤、文件读取、报错重试都不占用主模型的 token。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半身：注册/注销 `delegate_small` 工具，持久化配置，提供 `/api/small-model-delegate/*` JSON 接口 |
| `client.js` | 浏览器半身：注册「设置 → 小模型委派」配置页（ModuleLoader bundle，无构建步骤） |
| `cordis.patch.yml` | bundle patch：把 Host 行插进 profile 的配置树 |
| `smoke-test.mjs` | Host 半身冒烟测试：用桩 ctx 真正调用 `apply()`、跑一次委派、并验证提示段的热改，69 项断言 |
| `client-test.mjs` | 浏览器半身冒烟测试：桩 React + 桩 ModuleLoader 把设置页真渲染一遍，32 项断言 |

## 安装

```sh
git clone https://github.com/cavanluo666/dsh-small-model-delegate.git
dsh plugin --profile web add link:./dsh-small-model-delegate
```

这一条命令同时做两件事：把依赖写进 `~/.dsh/profiles/web/package.json`，
并把 `dsh-small-model-delegate` 追加进 `dsh.profile.bundles`。

装好后**重启 dsh**（新增 bundle 需要重新解析组合层）。验证组合层已经吃进去：

```sh
dsh --profile web --dump-config | Select-String -Context 0,2 'small-model-delegate'
```

## 配置

打开 **设置 → 小模型委派**：

- **启用委派工具** —— 关掉即注销工具；
- **执行器 provider** —— 真正跑子任务的后端，只列出支持模型覆盖的；留空 = 自动用第一个；
- **小模型 provider / model** —— 小模型的路由，下拉选择或手填；
- **reasoning effort / 最大输出 tokens** —— 限制它别长篇大论；
- **允许 / 禁止的工具** —— 例如只允许 `read,grep,glob`、禁止 `pwsh,write,edit`，
  既省 token 也更安全；
- **人格 / 系统提示** —— 约束小模型的边界与汇报格式；
- **常驻提示开关 + 文本** —— 在主模型的系统提示里常驻一段「优先委派」的说明。
  文本可随时改，保存即热生效，不用重启。
- **自动拦截开关 + 工具名单 + 阈值/上限/超时 + 摘要指令** —— 见下一节。

配置持久化在 `$DSH_HOME/small-model-delegate/config.json`，重启后仍然有效。

## 自动拦截：不依赖模型自觉的那条路

先说为什么需要它。

**靠措辞劝模型主动委派，试过两次都失败了。** 工具描述里写了「主动使用」，系统提示里也
常驻了一段「优先委派」，但遇到「读取整个工作区」这种教科书级的委派场景（28,194 个文件、
10.8 GB），模型依然自己规划一路读下去。模型「我自己来」的先验太强，而它还得**在规划的
中途想起来**有这条路。

所以这里换一条路：不问模型，直接在 `tools/post-execute` 这个 waterfall 上拦截。
某个工具的结果超过阈值时，先交给小模型消化，**只把摘要放进主上下文**——原始输出
根本不进来。

三条纪律：

1. **fail open** —— 没配路由、小模型报错、超时、形状不对，任何一步出问题都原样放行。
   拦截器自己坏掉，也绝不吞掉一次工具调用。
2. **防递归** —— 我们自己派出去的子任务，它的工具调用一律不拦（`childDepth` 计数 +
   子会话 id 集合两道闸）。
3. **留退路** —— 摘要里写明「要精确原文就用更窄的范围重调」，模型有路可走。

有意不拦的几种情况：嵌套调用（`run_code` 内部，改写会破坏程序数据流）、失败结果
（错误信息正是模型最需要的）、超过上限的超大输出（小模型也消化不了）。

代价：每个被拦的结果多一次小模型调用（免费，但变慢）。阈值默认 20000 字节，
约等于 400 行代码。

首次运行时插件会自动挑一条默认路由：优先用部署里
`subagent-model-selection` 设置允许的路由，其次用 `agent-default-model`；
拿到路由就默认开启，拿不到就留一个空配置等你在页面上选。

### 什么能热改、什么要重启

| 改什么 | 怎么生效 |
| --- | --- |
| **配置**（开关、模型路由、工具限制、人格、提示段文本） | 走 `POST /api/small-model-delegate/save`，**热生效，所有对话立刻适用** |
| **代码**（工具描述、行为逻辑、加新配置字段） | **必须重启**。`patchReload: live` 只监听 patch YAML（`hmr` 的 `root` 是空的），不监听插件代码 |

## 测试

```sh
node smoke-test.mjs     # Host 半身，94 项
node client-test.mjs    # 浏览器半身，38 项
```

两个测试都在隔离的临时环境下运行，不会碰你的真实配置，也不会联网。
`client-test.mjs` 用一个桩 React 把 `client.js` 真正加载、`apply()`、并把设置页
渲染成元素树再遍历——用来在重启前抓住「设置页白屏」那一类错误。

## 排查：其它对话不调用它

先看 `stats`（`$DSH_HOME/small-model-delegate/config.json`），它是全进程累计的：

- `calls` 不涨 → 根本没人调用。工具是**全局注册**的（profile 根 ctx →
  `ScopedLayers` 的 global 层，`ToolRuntime.view()` 对每个 scope 都从这里起步），
  所以这属于"模型没想到用"，不是不可见——去调常驻提示段。
- `calls` 涨但 `errors` 也涨 → 调用发生了但失败，看返回文本里的原因。

PTC 模式下另有一步：所有工具都被折叠进 `run_code`，模型必须写
`return await tools.delegate_small({ task })` 才调得到，界面上不会有独立的调用卡片。

## 它和内置 `subagent` 工具的区别

内置 `subagent` 是通用的委派原语，每次调用由主模型自己决定要不要选模型。
本插件提供一个**固定的、由你在 GUI 里钉死的小模型路由**，主模型只需描述任务，
不用（也不能）改路由——更适合「日常杂活一律丢给最便宜的那个模型」这种用法。

## 注意

若本目录位于 exFAT 卷上，请注意 exFAT 不支持硬链接，因此基于原子硬链接写入的工具
无法在此创建或修改文件；请用普通编辑器编辑，或把源码放到 NTFS 卷上再以
`link:` 方式安装。

## 许可证

本项目以 **GNU General Public License v3.0 or later** 发布，
完整条款见 [`LICENSE`](LICENSE)。

```
Copyright (C) 2026 LCH
```

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.
