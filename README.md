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

- 只对 `allowModels` 路由生效，跳过 `purpose` 为标题/压缩的辅助请求。
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
| 无块 / 摘要为空，且本回合干过活 | 推一次（`protocol-missing` / `protocol-empty`） |
| 无块 / 摘要为空，且收尾区在讲计划或明显没说完 | 推一次 |
| 无块，纯聊天（无工具、不像没说完） | 放行（`protocol-pure-chat`） |

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
| `maxNudges` | `2` | 每 turn 最多推几次；`0` 等同未安装 |
| `delayMs` | `0` | 推送前等待，期间 abort 就放弃 |
| `dryRun` | `false` | 只记日志不推 |
| `completionProtocol` | `true` | 收尾协议 |
| `markerStyle` | `fence-check` | 标记样式 |
| `streamGuard` | `true` | 请求层防护 |
| `streamIdleMs` | `90000` | 流内静默多久判卡死（本机适配器自身超时 300s） |
| `maxGuardRetries` | `1` | 截断改判上限 / 每 step guard 重试上限 |
| `retryScope` / `truncationScope` / `extendedScope` | `true` | 兜底三域 |
| `retryCodes` | TRANSPORT/TIMEOUT/SERVER | 算「供应商侧故障」的码 |
| `allowModels` | `['open-design/deepseek-v4.1-flash']` | 空数组 = 全部启用 |
| `planPatterns` / `isAskingPatterns` | 见代码 | 正则源串，非法项被忽略 |
| `nudgeText` / `protocolNudgeText` | 见代码 | 推送正文 |
| `logDecisions` / `logFile` | `false` / `$DSH_HOME/dsh-auto-continue/events.jsonl` | 诊断日志 |

## 安全阀

1. 每 turn 最多 `maxNudges` 次，**从会话日志的持久计数推导**。
2. 同 turn 同末条消息指纹只推一次。
3. `goal.phase === 'active'` 时整个跳过（不与 goal round driver 抢）。
4. 中途人类接管（首条 assistant 之后的人类消息）清零计数与指纹；**开局 prompt 不算**。
5. `signal.aborted` / `agent.status !== 'running'` / 非白名单路由不推。
6. 监听器内所有异常吞掉并记日志，绝不冒泡到主循环。
7. 截断改判与 guard 重试都有上限，`maxGuardRetries` 用尽后放行。

## 验证

```bash
cd plugins/dsh-auto-continue
npm test        # = node --test "test/*.test.mjs"
```

当前：**52 tests / 52 pass**。覆盖配置解析、标记解析（四种样式）、剥离、`isSettled`、决策正反例、`foldTurn` 记账、`stateFor` 清零、`apply` 装配（含 section 清理函数注册）、监听器安全（注入抛错）、以及 stream guard 的透传/截断/卡死/无 finish/上游抛错/预算耗尽/白名单与辅助请求放行。

## 已知限制

- **只治「说得出来」的问题**：网关静默切断、模型自述计划、重连后停半截都能覆盖；真的网络断连仍由 DSH 自己的退避重试处理，SSE 保活做不到（在适配器内部）。
- **协议依赖模型合规**：漏写标记会被推一次（有上限）。合规率无法事前保证，只能靠日志观测。
- **不记录 `stopReason` 的路由不可判**（如 `deepseek-account/deepseek-flash`）：判据要求 `stop`，取不到就静默跳过。
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

本包 `private: true`，不发布到 npm —— 它是一个 profile bundle，由 DSH 的插件管理器落地。
不读凭据、不联网、无遥测；只写 `$DSH_HOME/dsh-auto-continue/events.jsonl`。

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
