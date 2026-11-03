# dsh-auto-continue v2

重写版。目标只有一个：**轮次不能在「话没说完」或「只写了下一步计划」的时候关闭。**

## 为什么重写

v1 能用，但踩了六个坑，v2 把它们写成设计约束：

1. **括号收尾标记会诱发退化**。v1 用 `[DONE: …]`，结果模型（就是我们自己）在长回合末尾反复输出 `]]]`。v2 用 fenced block，块内一行清单，没有需要配对的括号。
2. **`systemPrompt.section()` 返回清理函数，必须注册**。v1 忽略了它，每次插件重载都往在线会话里追加一条系统提示词节点（实测累积到 8 条）。v2 用 `ctx.effect` 注册，重载后始终只有一条。
3. **服务键是 `systemPrompt`，不是 `system-prompt`**。后者是事件名。v1 写错，导致协议段从未注入，日志里只有一条 `no systemPrompt service is mounted`，而且**不报错**。
4. **不能把开局 prompt 当成人类接管**。它会出现在每个 turn 的窗口里，若用它清零计数，`maxNudges` 与指纹去重会双双失效。
5. **`maxNudges` 必须从持久日志推导**。取本 turn 里已有几条 `source.kind = auto-continue` 的 user/message，这样多实例、重载、重启都封得住。
6. **损坏流的清理不能 await**。上游卡死时，`await iterator.return()` 会把重试一起卡住。v2 改成事后触发、不等待。

## 三层防护

### 1. 请求层：`llm/stream` guard

```
adapter 流 → guardStream → 逐 chunk 透传（UI 照常实时输出）
                ├─ streamIdleMs 内无 chunk      → error finish (STREAM_STALL)
                ├─ 上游没 finish 就断           → error finish (STREAM_TRUNCATED)
                └─ finish=stop 但正文未收尾     → error finish (STREAM_TRUNCATED)
                                    ↓ loop 判为本次尝试失败 → agent/request-error
                                    ↓ 本插件返回 {kind:'retry'} → 同一步内重发
```

- 默认对所有路由生效（`allowModels` 为空数组）；配了白名单则只对名单内路由生效。跳过 `purpose` 为标题/压缩的辅助请求。
- 截断改判每会话最多 `maxGuardRetries` 次；一条干净收尾的流会把额度还回来。
- 每个 `(agent,turn,step)` 的 guard 重试也封顶，用尽后交给正常重试策略。
- 判定前先剥离协议块，否则每一条健康的 ```` ```done ```` 收尾都会被当成「没说完」而无限重试。

### 2. 协议层：收尾声明（默认开）

插件用 `SystemPrompt.section()` 注入一段要求（order 9500，**不改全局提示词**，卸载即撤）：

```
```done
✅ 已完成：<一句话结果摘要>
```
或
```ask
❓ 待确认：<需要用户拍板的具体问题>
```
```

判定是确定性的：

| 收尾 | 动作 |
|---|---|
| `done` 且摘要非空 | 放行（`protocol-done`） |
| `ask` 且问题非空 | 放行（`protocol-ask`） |
| 无块 / 摘要为空 | 推一次（`protocol-missing` / `protocol-empty`） |
| **正文完全为空**（一个字都没有） | 推一次（`protocol-empty-text`） |

**没有例外**：只要缺声明就推，不看本回合有没有工具调用、是不是纯聊天、句子有没有收住。协议要求每条回复都声明收尾，所以「看起来像聊天」不构成放行理由。

标记样式可切：`fence-check`（默认，块内清单）/ `fence`（块内纯文本）/ `line`（`DONE:` 行首）/ `plain`（`[DONE: …]`，仅兼容用）。

### 3. 兜底层：三个启发式域（协议关闭时才用）

| 域 | 判据 |
|---|---|
| `retryScope` | 本 turn 有 `llm/retry`，且 `failure.code ∈ retryCodes`（默认 TRANSPORT/TIMEOUT/SERVER） |
| `truncationScope` | 末句未收住（`：，、（` 或无标点结尾） |
| `extendedScope` | 收尾区（最后两个非空行）命中计划短语 |

共同闸门：最后一条是**纯文本 `stop`**、且**不是在问用户**。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册任何监听器 |
| `maxNudges` | `2` | **连续无效**推送上限（推完有推进的不计、并清零）；`0` 等同未安装 |
| `nudgeMinIntervalMs` | `5000` | 两次推送的最小间隔，防止一次短暂断连就把次数烧光 |
| `delayMs` | `0` | 额外的推送前等待，期间 abort 就放弃 |
| `dryRun` | `false` | 只记日志不推 |
| `completionProtocol` | `true` | 收尾协议 |
| `markerStyle` | `fence-check` | 标记样式 |
| `streamGuard` | `true` | 请求层防护 |
| `streamIdleMs` | `90000` | 流内静默多久判卡死（本机适配器自身超时 300s） |
| `maxGuardRetries` | `1` | 截断改判上限 / 每 step guard 重试上限 |
| `retryScope` / `truncationScope` / `extendedScope` | `true` | 兜底三域 |
| `retryCodes` | TRANSPORT/TIMEOUT/SERVER | 算「供应商侧故障」的码 |
| `allowModels` | `[]` | 生效路由；默认空数组 = 全部路由，收窄时填 `provider/model` 列表 |
| `planPatterns` / `isAskingPatterns` | 见代码 | 正则源串，非法项被忽略 |
| `nudgeText` / `protocolNudgeText` / `giveUpNoticeText` | 见代码 | 推送正文 / 放弃提示正文 |
| `logDecisions` / `logFile` | `false` / `$DSH_HOME/dsh-auto-continue/events.jsonl` | 诊断日志 |

## 安全阀

1. 额度只记「连续无效推送」：推完模型确实干了活（有工具调用）就不算消耗，也把之前的欠账清零；连续 `maxNudges` 次推了没反应才停。计数从会话日志的持久记录推导。
2. **没有总次数上限**：一个持续在推进的 turn 可以被无限制地重新打开（日志里的 `attempts` 只用于观测，不参与任何门限）。只有「连续无效」会累积，所以病态循环（模型反复停但什么也不干）仍会在 `maxNudges` 次后停下。
3. 两次推送至少间隔 `nudgeMinIntervalMs`（默认 5 秒），一次瞬时断连不会连着烧掉额度。
4. **放弃时会在对话里留一条可见提示**（`giveUpNoticeText`），说明自动续接已停止、可能是上游断连或配额问题，每个 turn 只留一次；同时写一条 `event: giveup` 日志。
5. 同 turn 同末条消息指纹只推一次。
6. `goal.phase === 'active'` 时整个跳过（不与 goal round driver 抢）。
7. 中途人类接管（首条 assistant 之后的人类消息）清零计数、指纹与放弃标记；**开局 prompt 不算**。
8. `signal.aborted` / `agent.status !== 'running'` / 非白名单路由不推。
9. 监听器内所有异常吞掉并记日志，绝不冒泡到主循环。
10. 截断改判与 guard 重试都有上限，`maxGuardRetries` 用尽后放行。

## 验证

```bash
cd plugins/dsh-auto-continue
npm test        # = node --test "test/*.test.mjs"
```

当前：**61 tests / 61 pass**。覆盖配置解析、标记解析（四种样式）、剥离、`isSettled`、决策正反例（缺声明必推 / 正文为空必推 / 协议关闭时维持原判 / 默认全路由 vs 显式白名单）、`foldTurn` 记账（含“有推进的推送不算欠账”）、`stateFor` 清零、`apply` 装配（含 section 清理函数注册）、监听器安全（注入抛错、放弃提示只发一次且留 `giveup` 事件、有推进的推送不吃额度、长回合无总次数上限）、以及 stream guard 的透传/截断/卡死/无 finish/上游抛错/预算耗尽/辅助请求放行与白名单收窄。

## 已知限制

- **只治「说得出来」的问题**：网关静默切断、模型自述计划、重连后停半截都能覆盖；真的网络断连仍由 DSH 自己的退避重试处理，SSE 保活做不到（在适配器内部）。
- **协议依赖模型合规**：漏写标记会被推一次（有上限）。合规率无法事前保证，只能靠日志观测。
- **不记录 `stopReason` 的路由不可判**（如 `deepseek-account/deepseek-flash`）：判据要求 `stop`，取不到就静默跳过。
- **协议层依赖宿主提供 `systemPrompt` 服务**：某些上下文里该服务不存在，协议段会静默缺失（日志留一条 `no system-prompt service is mounted`），此时只剩请求层 guard 与兜底三域。
- **依赖 `Session.eventAt` / `snapshotEvents`**：两者已被标 `@deprecated`，未来移除会让窗口读取返回 `undefined`（只记 skip，不推，不会崩）。

## 安装 / 卸载

```bash
git clone https://github.com/VergilYe/dsh-auto-continue.git
```

然后在 DSH 里：

```
plugin_manager  action: install_bundle  target: <clone 出来的目录>
plugin_manager  action: remove_bundle   target: dsh-auto-continue
```

也可以直接让 DSH 从 GitHub 安装（profile bundle 走 bundle patch，不需要构建）：

```
dsh plugin add git+https://github.com/VergilYe/dsh-auto-continue.git
```

零依赖、无安装脚本、无构建步骤。不读凭据、不联网、无遥测；只写
`$DSH_HOME/dsh-auto-continue/events.jsonl`（诊断日志，含末段文本片段与 sessionId，
只留在本机；不想留可把 `logDecisions` 设为 `false`）。

### 下载即用

`allowModels` 默认为**空数组 = 所有路由**，所以装完不需要任何配置，你自己的模型直接就是
生效范围。三层防护（stream guard / 收尾协议 / 兜底三域）会一起对这个 profile 的所有请求
生效，与具体的 provider/model 无关。

### 只想对某些模型生效（可选）

如果不想让别的模型也被这套行为管，在 **profile 自己的补丁层**里按行 id 覆盖即可：

`~/.dsh/profiles/<profile>/cordis.patch.yml`

```yaml
- id: auto-continue
  name: dsh-auto-continue
  config:
    allowModels:
      - open-design/deepseek-v4.1-flash
      - zai-coding-cn/glm-5.3
```

- 行 id 是 bundle 补丁里的 `auto-continue`（`plugin_manager` 报出的 `include:auto-continue`
  是宿主内层 id，写补丁时用前者）。
- 这个补丁层「在 bundle 层之后应用」，所以能覆盖插件自带配置，插件升级也不会被冲掉。
- 想查实际路由字符串：看 `$DSH_HOME/dsh-auto-continue/events.jsonl` 里的 `route` 字段。
- 空数组或省略该键 = 全部路由（默认）。

同一段 YAML 也可以直接交给你的 AI agent 去写——它有文件读写权限即可完成，不需要额外工具。

### 在插件市场里找到它

DSH 的「市场」读取社区索引
[`dsh-plugin-catalog`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
本插件的收录条目已准备好（[`market/VergilYe__dsh-auto-continue.yml`](market/VergilYe__dsh-auto-continue.yml)），
投稿步骤与 CI 要求见 [PUBLISHING.md](PUBLISHING.md)。
收录后可在 **设置 → 插件 → 市场** 直接搜索 `auto continue` 一键安装。

## 它解决什么问题（背景）

模型请求被网关静默切断时，客户端拿到的仍是**合法**的 `stopReason: "stop"`——没有错误、
没有重试、没有异常。DSH 于是认为这一轮正常结束，用户看到的却是一句「接下来我要……」就
没了下文，只能手动输入「继续」。

这类问题靠「更好的错误处理」解决不了，因为**没有错误**。三种形态要各自对付：

| 形态 | 现象 | 手段 |
|---|---|---|
| A 重连变体 | 本 turn 有 `llm/retry`，之后只叙述计划 | `retryScope` |
| B 静默截断 | 无错误、`stop=stop`，但正文停在冒号/半句 | `llm/stream` guard + `truncationScope` |
| C 自述计划 | 语法完整，把下一步计划当结论 | 收尾协议 + `extendedScope` |

用「用户手动输入『继续』」当标签在本机语料上标定：**只认重连的口径召回约 1.4%**，
三形态 + 协议才能覆盖大部分真实的「停半截」。


## License

MIT
