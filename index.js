/**
 * dsh-auto-continue v2 — stop a turn from closing on an unfinished reply.
 *
 * Rewritten from scratch after v1. What v1 taught us, kept here as design rules:
 *
 * 1. A bracketed end-of-reply marker (`[DONE: …]`) puts constant "close the bracket"
 *    pressure on every reply and degenerates into runs of stray `]`. v2 uses a fenced
 *    block whose body is one checklist line — nothing to close wrong.
 * 2. `systemPrompt.section()` returns a disposer. Ignoring it makes every plugin
 *    reload append another system-prompt node to live sessions. v2 registers the
 *    disposer through `ctx.effect`, so a reload always leaves exactly one section.
 * 3. `ctx.get('system-prompt')` is wrong: the service key is `systemPrompt`.
 * 4. The `didWork` gate must not block a turn whose prose announces more work — but
 *    counting the turn-opening prompt as a "human takeover" disables the cap. v2
 *    counts a takeover only for messages after the first assistant output.
 * 5. `maxNudges` must be derived from the durable log (how many pushes this turn
 *    already contains), so duplicate plugin instances and reloads cannot overshoot.
 * 6. Cleanup of a damaged stream must never be awaited: a provider that hangs would
 *    hold the retry hostage for exactly as long as it hangs.
 *
 * Four layers, cheapest first:
 *   - `llm/stream` guard: a stream that stops mid-thought or goes silent becomes a
 *     terminal `error`, so DSH's own retry re-sends inside the same step.
 *   - completion protocol: an injected system-prompt section asks for an explicit
 *     end-of-reply declaration. Declared ⇒ close; missing after real work ⇒ push.
 *   - heuristic scopes: reconnect / unsettled text / plan phrasing, for when the
 *     protocol is off.
 *   - overload reconnector: once a provider's own retry budget is spent on a
 *     429/529 ("overloaded", "访问量过大", code 1305) failure, keep re-sending every
 *     `overloadRetryIntervalMs` until it connects or the turn is aborted, instead of
 *     closing the turn as failed.
 *
 * Zero runtime dependencies: only `node:` builtins.
 *
 * @module dsh-auto-continue
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-auto-continue'

/** Hard dependency: `agents` owns live agents and dispatches `agent/turn-stopping`. */
export const inject = ['agents']

/** Source kind of the messages this plugin pushes. Never `'user'`. */
export const SOURCE_KIND = 'auto-continue'

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

export const DEFAULT_NUDGE_TEXT =
  '继续。不要只描述计划：直接执行下一步；若任务已完成，给出结果汇报。'

export const DEFAULT_PLAN_PATTERNS = Object.freeze([
  '接下来',
  '下一步',
  '现在(就)?(先)?(改|查|检查|确认|修|跑|执行|补|加|写|做|看|读|试|提交|清理|重跑)',
  '我(继续|这就|马上|立刻)',
  '继续(把|改|查|做|跑|补)',
  '(执行|开始(改|做|跑|执行|检查))改动',
  '(开始|准备)(改|做|执行|检查|动手)',
  '先(查|读|看|确认|执行|改|跑|修|做)',
  '让我(先)?',
  '我要(先)?',
  '待会',
  '然后(再|就)',
  'Now (let|I)',
  'Next,? I',
  "I'll",
  'Let me',
  'Now:',
])

export const DEFAULT_ASKING_PATTERNS = Object.freeze([
  '[?？]',
  '要不要',
  '需不需要',
  '是否要',
  '是否需要',
  '要我(来|先|把|改|提|加|帮)?',
  '需要我',
  '你确认',
  '请确认',
  '你同意',
  '你定',
  '你决定',
  '你来定',
  '可以吗',
  '行吗',
  '好吗',
  '对吗',
  '等你',
  '待你',
  '发我',
  '截图发我',
  '告诉我',
  '你说了算',
  '需要的话',
  '可以的话',
  '有需要',
  '我可以(先|再|把|帮)?',
  '如果要',
  '愿意的话',
  'what do you want',
  'shall I',
  'should I',
  'do you want',
  'want me to',
  'let me know',
  'your call',
])

/**
 * Routes the plugin acts on. Empty means every route: a fresh install must work for
 * whoever installed it, without first discovering and hand-editing an allowlist. Narrow
 * it in the profile patch layer when a route needs to stay untouched.
 */
export const DEFAULT_ALLOW_MODELS = Object.freeze([])

/** Provider failure codes that mean "the answer was cut". */
export const DEFAULT_RETRY_CODES = Object.freeze(['TRANSPORT', 'TIMEOUT', 'SERVER'])

/**
 * Failure codes that mean "the provider is overloaded right now", which is the one shape
 * worth waiting out indefinitely: the request is valid, the model exists, and nothing in
 * the conversation needs to change — only the minute does.
 *
 * `SERVER` is deliberately absent: it covers every `5xx`, including a genuine gateway
 * fault that would keep failing forever. The 529 case is still reached, because
 * `dsh-llm-pi-ai` forwards the gateway body verbatim and the message patterns below match
 * its `529` / `1305` / `overloaded_error` wording. Add `SERVER` here only if every 5xx on
 * the route really is a load shed.
 */
export const DEFAULT_OVERLOAD_CODES = Object.freeze([
  'RATE_LIMIT',
  'OVERLOADED',
  'HTTP_429',
  'HTTP_529',
])

/**
 * Status text that identifies an overloaded provider when the adapter only forwards a
 * message. Matched case-insensitively against `failure.message`; the gateway's Chinese
 * wording ("该模型当前访问量过大，请您稍后再试") and Zhipu's `1305` both appear here.
 */
export const DEFAULT_OVERLOAD_PATTERNS = Object.freeze([
  '\\b529\\b',
  '\\b429\\b',
  'overloaded',
  '\\b1305\\b',
  '访问量过大',
  '稍后再试',
  '请求过于频繁',
  'too many requests',
  'rate.?limit',
])


const FENCE = '`'.repeat(3)

/**
 * End-of-reply marker presets. `fence-check` is the default: a fenced block holding
 * one checklist line, which renders as a compact code block.
 */
export const MARKER_STYLES = Object.freeze({
  'fence-check': Object.freeze({
    doneMarker: `${FENCE}done`,
    askMarker: `${FENCE}ask`,
    donePrefix: '✅ 已完成：',
    askPrefix: '❓ 待确认：',
  }),
  fence: Object.freeze({
    doneMarker: `${FENCE}done`,
    askMarker: `${FENCE}ask`,
    donePrefix: '',
    askPrefix: '',
  }),
  line: Object.freeze({ doneMarker: 'DONE:', askMarker: 'ASK:', donePrefix: '', askPrefix: '' }),
  plain: Object.freeze({
    doneMarker: '[DONE:',
    askMarker: '[ASK:',
    donePrefix: '',
    askPrefix: '',
    terminator: ']',
  }),
})

/** Section order: after the tool sections, before structured output. */
export const PROTOCOL_SECTION_ORDER = 9500

/** How much of the final body a decision log line records. */
const DECISION_TAIL_CHARS = 200
/** Length of the tail recorded in plugin logs. */
const LOG_TAIL_CHARS = 40
/** How much of the final line the asking test reads. */
const ASKING_PROBE_CHARS = 220
/** Upper bound for the message-source account. */
const SUMMARY_MAX_CHARS = 120

export const DEFAULTS = Object.freeze({
  enabled: true,
  maxNudges: 2,
  nudgeMinIntervalMs: 5_000,
  delayMs: 0,
  dryRun: false,
  retryScope: true,
  truncationScope: true,
  extendedScope: true,
  streamGuard: true,
  streamIdleMs: 90_000,
  maxGuardRetries: 1,
  completionProtocol: true,
  markerStyle: 'fence-check',
  overloadReconnect: true,
  overloadRetryIntervalMs: 10_000,
  overloadMaxWaitMs: 0,
  overloadCodes: [...DEFAULT_OVERLOAD_CODES],
  overloadPatterns: [...DEFAULT_OVERLOAD_PATTERNS],

  protocolNudgeText:
    '继续。若还有没做完的事就直接做完；完成时用 done 代码块收尾，需要我拍板时用 ask 代码块。',
  giveUpNoticeText:
    '（自动续接已停止：本轮多次推送都没有收到收尾声明。可能是上游断连或配额问题，请检查后手动继续。）',
  nudgeText: DEFAULT_NUDGE_TEXT,
  logDecisions: false,
  logFile: '',
})

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/**
 * Compile a pattern list, dropping unusable regular expressions. A typo in a
 * deployment config must never take the agent loop down.
 * @param {unknown} input - configured list.
 * @param {readonly string[]} fallback - defaults.
 * @returns {{ regexes: RegExp[], invalid: string[] }}
 */
export function compilePatterns(input, fallback) {
  const source = Array.isArray(input) ? input : [...fallback]
  const regexes = []
  const invalid = []
  for (const entry of source) {
    if (typeof entry !== 'string') {
      invalid.push(String(entry))
      continue
    }
    try {
      regexes.push(new RegExp(entry, 'i'))
    } catch {
      invalid.push(entry)
    }
  }
  return { regexes, invalid }
}

/**
 * @param {unknown} value - candidate.
 * @returns {boolean} whether it is a usable non-negative integer.
 */
function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Resolve the marker preset from the row config.
 * @param {object} input - raw row config.
 * @returns {{ markerStyle: string, doneMarker: string, askMarker: string,
 *   donePrefix: string, askPrefix: string, markerTerminator: string }}
 */
function markerSettings(input) {
  const key = Object.hasOwn(MARKER_STYLES, input.markerStyle) ? input.markerStyle : 'fence-check'
  const preset = MARKER_STYLES[key]
  return {
    markerStyle: key,
    doneMarker:
      typeof input.doneMarker === 'string' && input.doneMarker.length > 0
        ? input.doneMarker
        : preset.doneMarker,
    askMarker:
      typeof input.askMarker === 'string' && input.askMarker.length > 0
        ? input.askMarker
        : preset.askMarker,
    donePrefix: preset.donePrefix,
    askPrefix: preset.askPrefix,
    markerTerminator:
      typeof input.markerTerminator === 'string' && input.markerTerminator.length > 0
        ? input.markerTerminator
        : (preset.terminator ?? '\n'),
  }
}

/**
 * Merge a Loader row's `config` over {@link DEFAULTS}.
 * @param {unknown} raw - the row's `config`.
 * @returns {object} resolved options.
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const plan = compilePatterns(input.planPatterns, DEFAULT_PLAN_PATTERNS)
  const asking = compilePatterns(input.isAskingPatterns, DEFAULT_ASKING_PATTERNS)
  const markers = markerSettings(input)
  const allowModels = Array.isArray(input.allowModels)
    ? input.allowModels.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : [...DEFAULT_ALLOW_MODELS]

  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const text = (value, fallback) =>
    typeof value === 'string' && value.trim().length > 0 ? value : fallback

  return {
    enabled: bool(input.enabled, DEFAULTS.enabled),
    maxNudges: isCount(input.maxNudges) ? input.maxNudges : DEFAULTS.maxNudges,
    nudgeMinIntervalMs: isCount(input.nudgeMinIntervalMs)
      ? input.nudgeMinIntervalMs
      : DEFAULTS.nudgeMinIntervalMs,
    delayMs: isCount(input.delayMs) ? input.delayMs : DEFAULTS.delayMs,
    dryRun: bool(input.dryRun, DEFAULTS.dryRun),
    retryScope: bool(input.retryScope, DEFAULTS.retryScope),
    truncationScope: bool(input.truncationScope, DEFAULTS.truncationScope),
    extendedScope: bool(input.extendedScope, DEFAULTS.extendedScope),
    streamGuard: bool(input.streamGuard, DEFAULTS.streamGuard),
    streamIdleMs: isCount(input.streamIdleMs) ? input.streamIdleMs : DEFAULTS.streamIdleMs,
    maxGuardRetries: isCount(input.maxGuardRetries)
      ? input.maxGuardRetries
      : DEFAULTS.maxGuardRetries,
    completionProtocol: bool(input.completionProtocol, DEFAULTS.completionProtocol),
    ...markers,
    protocolNudgeText: text(input.protocolNudgeText, DEFAULTS.protocolNudgeText),
    giveUpNoticeText: text(input.giveUpNoticeText, DEFAULTS.giveUpNoticeText),
    nudgeText: text(input.nudgeText, DEFAULT_NUDGE_TEXT),
    allowModels,
    retryCodes: Array.isArray(input.retryCodes)
      ? input.retryCodes.filter((entry) => typeof entry === 'string' && entry.length > 0)
      : [...DEFAULT_RETRY_CODES],
    overloadReconnect: bool(input.overloadReconnect, DEFAULTS.overloadReconnect),
    overloadRetryIntervalMs:
      isCount(input.overloadRetryIntervalMs) && input.overloadRetryIntervalMs > 0
        ? input.overloadRetryIntervalMs
        : DEFAULTS.overloadRetryIntervalMs,
    overloadMaxWaitMs: isCount(input.overloadMaxWaitMs)
      ? input.overloadMaxWaitMs
      : DEFAULTS.overloadMaxWaitMs,
    overloadCodes: Array.isArray(input.overloadCodes)
      ? input.overloadCodes.filter((entry) => typeof entry === 'string' && entry.length > 0)
      : [...DEFAULT_OVERLOAD_CODES],
    overloadPatterns: compilePatterns(input.overloadPatterns, DEFAULT_OVERLOAD_PATTERNS).regexes,
    logDecisions: bool(input.logDecisions, DEFAULTS.logDecisions),
    logFile: typeof input.logFile === 'string' ? input.logFile : DEFAULTS.logFile,
    planPatterns: plan.regexes,
    isAskingPatterns: asking.regexes,
    invalidPatterns: [...plan.invalid, ...asking.invalid],
  }
}

// ---------------------------------------------------------------------------
// message + text helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} message - any message-shaped value.
 * @returns {string} joined text blocks.
 */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * @param {unknown} message - any message-shaped value.
 * @returns {number} number of tool-call blocks.
 */
export function toolCallCount(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  let count = 0
  for (const block of content) {
    if (block && block.type === 'tool-call') count += 1
  }
  return count
}

/**
 * Provider stop reason of one committed assistant message. Only the replay envelope
 * carries it; a streaming snapshot has none.
 * @param {unknown} message - a committed assistant message.
 * @returns {string | undefined}
 */
export function stopReasonOf(message) {
  const replay = message?.source?.replayState
  if (replay === undefined || replay === null) return undefined
  const response = replay.response
  if (typeof response === 'string') return response
  const stopReason = response?.stopReason
  return typeof stopReason === 'string' ? stopReason : undefined
}

/**
 * @param {string} summary - free-form account.
 * @returns {string} bounded to the source-summary limit.
 */
function boundSummary(summary) {
  return summary.length <= SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * Build the durable user-role message that re-opens the turn. `role: 'user'` is the
 * only role the model answers, but `source.kind` records that no human spoke.
 * @param {{ turn: number, rule: string, text: string }} input - construction input.
 * @returns {object} a UserMessage ready for `agent.steer()`.
 */
export function buildNudgeMessage({ turn, rule, text }) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      rule,
      turn,
      summary: boundSummary(`${name}: ${rule} at turn ${turn}`),
    },
  }
}

/**
 * Content fingerprint of one final message.
 * @param {object | null} finalMessage - folded final message.
 * @returns {string | undefined}
 */
export function fingerprintOf(finalMessage) {
  if (finalMessage === undefined || finalMessage === null) return undefined
  const hash = createHash('sha256')
  hash.update(String(finalMessage.id ?? ''))
  hash.update('\u0000')
  hash.update(String(finalMessage.stopReason ?? ''))
  hash.update('\u0000')
  hash.update(finalMessage.text ?? '')
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// session window
// ---------------------------------------------------------------------------

/**
 * Locate the committed event window of one open turn.
 * @param {object} session - the agent's session.
 * @param {number} turn - the turn being closed.
 * @returns {{ events: readonly object[] } | undefined}
 */
export function turnWindow(session, turn) {
  if (typeof session?.eventAt !== 'function' || typeof session?.snapshotEvents !== 'function') {
    return undefined
  }
  const end = typeof session.seq === 'number' ? session.seq : undefined
  if (typeof end !== 'number') return undefined
  for (let seq = end - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    if (event.type !== 'turn/start') continue
    if (event.data?.turn !== turn) return undefined
    return { events: session.snapshotEvents(event.seq) }
  }
  return undefined
}

/**
 * Fold one turn's committed events into the facts the rules need.
 * @param {readonly object[]} events - the turn's event window.
 * @returns {object} folded facts.
 */
export function foldTurn(events) {
  let hadRetry = false
  let toolCalls = 0
  let userInputs = 0
  let final = null
  let firstAssistantSeq
  let lastPushTime
  const retryCodes = new Set()
  // Every push we made this turn, plus whether the model actually did anything after
  // it. A push that produced work was not wasted, so it must not eat the budget.
  const pushes = []
  let workSincePush = false

  for (const event of events) {
    if (event === undefined || event === null) continue
    switch (event.type) {
      case 'llm/retry': {
        hadRetry = true
        const code = event.data?.failure?.code
        if (typeof code === 'string') retryCodes.add(code)
        break
      }
      case 'tool/call':
        toolCalls += 1
        workSincePush = true
        break
      case 'user/message': {
        const kind = event.data?.source?.kind
        if (kind === SOURCE_KIND) {
          // Durable record of our own pushes: survives reloads and duplicate instances.
          const previous = pushes[pushes.length - 1]
          if (previous !== undefined) previous.productive = workSincePush
          pushes.push({ productive: false, time: event.time })
          workSincePush = false
          lastPushTime = event.time
          break
        }
        // Only a message *after* the first assistant output is a takeover; the prompt
        // that opened the turn arrives before it and must not reset the bookkeeping.
        if (kind === 'user' && firstAssistantSeq !== undefined && event.seq > firstAssistantSeq) {
          userInputs += 1
        }
        break
      }
      case 'assistant/message': {
        if (firstAssistantSeq === undefined) firstAssistantSeq = event.seq
        const message = event.data?.message
        if (event.data?.interrupted === true) break
        if (message?.source?.replayState === undefined) break
        final = {
          id: message.id,
          seq: event.seq,
          text: messageText(message),
          toolCalls: toolCallCount(message),
          stopReason: stopReasonOf(message),
          provider: message.source?.provider,
          model: message.source?.model,
        }
        break
      }
      default:
        break
    }
  }

  const last = pushes[pushes.length - 1]
  if (last !== undefined) last.productive = workSincePush
  // Trailing run of pushes that led nowhere: that is the only budget worth counting.
  let unproductiveStreak = 0
  for (let i = pushes.length - 1; i >= 0; i -= 1) {
    if (pushes[i].productive) break
    unproductiveStreak += 1
  }

  return {
    hadRetry,
    toolCalls,
    userInputs,
    pushes: pushes.length,
    productivePushes: pushes.filter((push) => push.productive).length,
    unproductiveStreak,
    lastPushTime,
    final,
    retryCodes: [...retryCodes],
  }
}

/**
 * Fold the newest `goal/change` event to learn whether a goal is live.
 * @param {object} session - the agent's session.
 * @returns {'active' | string | 'none' | 'unknown'}
 */
export function latestGoalPhase(session) {
  if (typeof session?.eventAt !== 'function' || typeof session?.seq !== 'number') return 'unknown'
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    if (event.type !== 'goal/change') continue
    if (event.data?.operation === 'clear') return 'none'
    const phase = event.data?.goal?.phase
    return typeof phase === 'string' ? phase : 'unknown'
  }
  return 'none'
}

/**
 * @param {object} folded - folded turn facts.
 * @param {object} session - the agent's session.
 * @returns {string | undefined} `provider/model` of this turn.
 */
export function routeOf(folded, session) {
  const final = folded?.final
  if (typeof final?.provider === 'string' && typeof final?.model === 'string') {
    return `${final.provider}/${final.model}`
  }
  const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
  const config = header?.config
  if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
    return `${config.provider}/${config.model}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// prose rules
// ---------------------------------------------------------------------------

/**
 * The tail of the last non-empty line — what actually hands the turn back.
 * Deliberately not sentence-split: `…吗？（只提交 X）` must keep its question mark.
 * @param {string} text - final body.
 * @returns {string}
 */
export function lastSentence(text) {
  const body = String(text ?? '').trim()
  if (body.length === 0) return ''
  const lines = body.split('\n').filter((line) => line.trim().length > 0)
  const lastLine = (lines.length > 0 ? lines[lines.length - 1] : body).trim()
  return lastLine.length <= ASKING_PROBE_CHARS ? lastLine : lastLine.slice(-ASKING_PROBE_CHARS)
}

/**
 * The last two non-empty lines: the smallest window that still covers a plan written
 * on the line before a one-line closer.
 * @param {string} text - final body.
 * @returns {string}
 */
export function closingRegion(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.slice(-2).join('\n')
}

const TRAILING_CLOSERS = /[）」』”"'\])】》〉\s]+$/u
const SETTLED_END = /[。！？!?…；;.]$/u
const OPEN_END = /[：:，,、\-–—(（\[【「『“"']$/u

/**
 * Whether the body ends like a finished thought (as opposed to being cut mid-sentence,
 * which is the silent-truncation shape).
 * @param {string} text - final body.
 * @returns {boolean}
 */
export function isSettled(text) {
  const body = String(text ?? '').trim()
  if (body.length === 0) return true
  if (/```\s*$/.test(body)) return true
  const lines = body.split('\n').filter((line) => line.trim().length > 0)
  const lastLine = (lines.length > 0 ? lines[lines.length - 1] : body).trim()
  if (lastLine.length === 0) return true
  if (/^\|/.test(lastLine) || /\|\s*$/.test(lastLine)) return true
  if (OPEN_END.test(lastLine)) return false
  const stripped = lastLine.replace(TRAILING_CLOSERS, '').replace(/[*_`]+$/u, '')
  if (stripped.length === 0) return true
  if (SETTLED_END.test(stripped)) return true
  const lastToken = stripped.split(/\s+/u).at(-1) ?? ''
  // A tail with no letters is a number/unit/code fragment: complete by nature.
  if (lastToken.length > 0 && !/\p{L}/u.test(lastToken)) return true
  return false
}

/**
 * @param {object} folded - folded turn facts.
 * @param {object} options - resolved config.
 * @returns {boolean} whether the closing region announces a plan.
 */
export function matchesPlanTail(folded, options) {
  const text = folded.final?.text ?? ''
  if (text.trim().length === 0) return false
  const region = closingRegion(text)
  if (region.length === 0) return false
  return options.planPatterns.some((pattern) => pattern.test(region))
}

/**
 * @param {object} folded - folded turn facts.
 * @param {object} options - resolved config.
 * @returns {boolean} whether the reply hands the turn back to the human.
 */
export function matchesAsking(folded, options) {
  const sentence = lastSentence(folded.final?.text ?? '')
  if (sentence.length === 0) return false
  return options.isAskingPatterns.some((pattern) => pattern.test(sentence))
}

/**
 * @param {object} folded - folded turn facts.
 * @param {object} options - resolved config.
 * @returns {string[]} matched heuristic scopes.
 */
export function matchedScopes(folded, options) {
  const scopes = []
  const text = folded.final?.text ?? ''
  if (options.retryScope && folded.hadRetry) {
    const codes = Array.isArray(folded.retryCodes) ? folded.retryCodes : []
    const allowed =
      !Array.isArray(options.retryCodes) || options.retryCodes.length === 0
        ? true
        : codes.some((code) => options.retryCodes.includes(code))
    if (allowed || codes.length === 0) scopes.push('retry')
  }
  if (options.truncationScope && !isSettled(text)) scopes.push('truncated')
  if (options.extendedScope && matchesPlanTail(folded, options)) scopes.push('plan')
  return scopes
}

// ---------------------------------------------------------------------------
// completion protocol
// ---------------------------------------------------------------------------

/**
 * The instruction injected into the system prompt.
 * @param {object} options - resolved config.
 * @returns {string}
 */
export function buildProtocolInstruction(options) {
  const { doneMarker, askMarker, donePrefix, askPrefix } = options
  const fenced = doneMarker.startsWith('`')
  const done = `${donePrefix}<一句话结果摘要>`
  const ask = `${askPrefix}<需要用户拍板的具体问题>`

  if (fenced) {
    return [
      '## Turn-ending protocol (mandatory)',
      '',
      'End EVERY reply with exactly one of these two fenced blocks, as the last thing',
      'in the message:',
      '',
      '````',
      doneMarker,
      done,
      '```',
      '````',
      '',
      'when the requested work is finished and verified (the summary must state what',
      'was actually delivered), or',
      '',
      '````',
      askMarker,
      ask,
      '```',
      '````',
      '',
      'when you cannot continue without the user (a decision, a credential, a manual',
      'check, missing information).',
      '',
      'Never end a reply without one of them. Never write a plan ("next I will …") as',
      'the last thing you say: if work remains, keep working instead of ending the',
      'turn. The two blocks are the only endings that close a turn.',
    ].join('\n')
  }

  return [
    '## Turn-ending protocol (mandatory)',
    '',
    'End EVERY reply with exactly one of these two markers on its own final line:',
    '',
    `- ${doneMarker} ${done}${options.markerTerminator}`,
    `- ${askMarker} ${ask}${options.markerTerminator}`,
    '',
    'Never end a reply without one of them. Never write a plan as the last thing you',
    'say: if work remains, keep working instead of ending the turn.',
  ].join('\n')
}

/**
 * Read the protocol verdict from a final body. Only the closing lines are inspected:
 * a reply that *mentions* the markers mid-text is not making a declaration.
 * @param {string} text - final body.
 * @param {object} options - resolved config.
 * @returns {{ verdict: 'done' | 'ask' | 'missing' | 'empty', summary: string }}
 */
export function parseProtocol(text, options) {
  const body = String(text ?? '')
  const fenced = options.doneMarker.startsWith('`')
  if (fenced) return parseFencedProtocol(body, options)

  const tail = body.split('\n').filter((line) => line.trim().length > 0).slice(-3).join('\n')
  const doneIndex = tail.lastIndexOf(options.doneMarker)
  const askIndex = tail.lastIndexOf(options.askMarker)
  const terminator = options.markerTerminator
  const read = (index, marker) => {
    if (index < 0) return undefined
    const rest = tail.slice(index + marker.length)
    const close = rest.indexOf(terminator)
    return (close >= 0 ? rest.slice(0, close) : rest).replace(/^\s*:?\s*/, '').trim()
  }
  if (askIndex > doneIndex) {
    const question = read(askIndex, options.askMarker)
    if (question === undefined) return { verdict: 'missing', summary: '' }
    return { verdict: question.length > 0 ? 'ask' : 'empty', summary: question }
  }
  if (doneIndex >= 0) {
    const summary = read(doneIndex, options.doneMarker)
    if (summary === undefined) return { verdict: 'missing', summary: '' }
    return { verdict: summary.length > 0 ? 'done' : 'empty', summary }
  }
  return { verdict: 'missing', summary: '' }
}

/**
 * Whether the declaration block is the *last* thing in the body.
 *
 * The protocol text asks for the block "as the last thing in the message", but a model
 * that writes "```done" and then keeps talking ("wait, I am not finished yet") used to be
 * read as done, which closed the turn mid-task. So the bar is structural: the final
 * non-blank line must close a fenced block, and that block must be the declaration block.
 * Only that shape counts as a finished reply — trailing prose, a second block, or a
 * declaration that sits mid-text all mean the turn is not settled.
 * @param {string} body - final body.
 * @param {object} options - resolved config.
 * @returns {boolean}
 */
function declarationIsLastBlock(body, options) {
  const lines = body.split('\n')
  let end = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) {
      end = i
      break
    }
  }
  if (end < 0) return false
  // The closing fence must be the last thing: only backticks, nothing after it.
  if (!/^`{3,}$/.test(lines[end].trim())) return false
  // Walk up to the fence that opened this block. Whichever fence line we hit first is the
  // opener, because fenced blocks do not interleave with prose.
  for (let i = end - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (!trimmed.startsWith(FENCE)) continue
    return trimmed.startsWith(options.doneMarker) || trimmed.startsWith(options.askMarker)
  }
  return false
}

/**
 * Parse the fenced form: the marker opens a block whose first non-blank line is the
 * declaration body.
 * @param {string} body - final body.
 * @param {object} options - resolved config.
 * @returns {{ verdict: 'done' | 'ask' | 'missing' | 'empty', summary: string }}
 */
function parseFencedProtocol(body, options) {
  const lines = body.split('\n')
  let found = -1
  let kind = 'missing'
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith(options.doneMarker)) {
      found = i
      kind = 'done'
      break
    }
    if (trimmed.startsWith(options.askMarker)) {
      found = i
      kind = 'ask'
      break
    }
  }
  if (found < 0) return { verdict: 'missing', summary: '' }

  const collected = []
  for (let j = found + 1; j < lines.length; j += 1) {
    if (lines[j].trim().startsWith(FENCE)) break
    collected.push(lines[j])
  }
  const summary = collected.join('\n').trim()
  // A declaration that is not the final block does not close the turn: the model went on
  // talking after it, so treat it as undeclared and let the listener push once.
  if (!declarationIsLastBlock(body, options)) {
    return { verdict: summary.length > 0 ? 'missing' : 'empty', summary }
  }
  return { verdict: summary.length > 0 ? kind : 'empty', summary }
}

/**
 * Replace the whole trailing marker block with nothing, so the prose rules judge the
 * prose and the stream guard does not read a closing fence as a cut-off sentence.
 * @param {string} text - final body.
 * @param {object} options - resolved config.
 * @returns {string}
 */
export function stripProtocolMarkers(text, options) {
  const body = String(text ?? '')
  if (!options.completionProtocol) return body

  if (options.doneMarker.startsWith('`')) {
    const lines = body.split('\n')
    let start = -1
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const trimmed = lines[i].trim()
      if (trimmed.startsWith(options.doneMarker) || trimmed.startsWith(options.askMarker)) {
        start = i
        break
      }
    }
    if (start < 0) return body.trimEnd()
    let end = lines.length
    for (let j = start + 1; j < lines.length; j += 1) {
      if (lines[j].trim().startsWith(FENCE)) {
        end = j + 1
        break
      }
    }
    return [...lines.slice(0, start), ...lines.slice(end)].join('\n').trimEnd()
  }

  return body
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith(options.doneMarker) && !trimmed.startsWith(options.askMarker)
    })
    .join('\n')
    .trimEnd()
}

// ---------------------------------------------------------------------------
// decision
// ---------------------------------------------------------------------------

/**
 * Decide whether this turn should be re-opened.
 * @param {object} folded - folded turn facts.
 * @param {string | undefined} route - `provider/model`.
 * @param {object} options - resolved config.
 * @returns {{ nudge: boolean, rule: string, reason: string, tail: string, scopes: string[] }}
 */
export function decide(folded, route, options) {
  const tail = (folded.final?.text ?? '').trim().slice(-DECISION_TAIL_CHARS)
  const early = (reason) => ({ nudge: false, rule: 'none', reason, tail, scopes: [] })

  if (!options.enabled) return early('disabled')
  if (options.maxNudges <= 0) return early('max-nudges-0')
  if (options.allowModels.length > 0) {
    if (route === undefined) return early('unknown-route')
    if (!options.allowModels.includes(route)) return early('model-not-allowed')
  }
  if (folded.final === null) return early('no-final-message')
  if (folded.final.stopReason !== 'stop') {
    return early(`stop-reason:${String(folded.final.stopReason)}`)
  }
  if (folded.final.toolCalls > 0) return early('final-has-tool-call')

  const prose = stripProtocolMarkers(folded.final.text ?? '', options)
  const judged = { ...folded, final: { ...folded.final, text: prose } }
  const scopes = matchedScopes(judged, options)

  if (options.completionProtocol) {
    // The protocol asks for a declaration at the end of every reply, so a missing one
    // must never be allowed to close the turn — whatever the shape of the reply. An
    // empty body, a plan announcement and ordinary chatter all read as "not declared".
    const protocol = parseProtocol(folded.final.text ?? '', options)
    if (protocol.verdict === 'done' || protocol.verdict === 'ask') {
      return { nudge: false, rule: 'none', reason: `protocol-${protocol.verdict}`, tail, scopes }
    }
    const emptyProse = prose.trim().length === 0
    return {
      nudge: true,
      rule: emptyProse
        ? 'protocol-empty-text'
        : protocol.verdict === 'empty'
          ? 'protocol-empty'
          : 'protocol-missing',
      reason: 'protocol-missing',
      tail,
      scopes,
    }
  }

  if (prose.trim().length === 0) return early('empty-final-text')

  const planOnly = scopes.length > 0 && scopes.every((scope) => scope === 'plan')
  if (folded.toolCalls === 0 && !planOnly) return early('no-work-this-turn')
  if (scopes.length === 0) {
    const allOff = !options.retryScope && !options.truncationScope && !options.extendedScope
    return {
      nudge: false,
      rule: 'none',
      reason: allOff ? 'all-scopes-off' : `no-scope:retry=${folded.hadRetry}`,
      tail,
      scopes,
    }
  }
  if (matchesAsking(judged, options)) {
    return { nudge: false, rule: 'none', reason: 'asking-user', tail, scopes }
  }
  return { nudge: true, rule: scopes.join('+'), reason: 'matched', tail, scopes }
}

// ---------------------------------------------------------------------------
// provider-side guard
// ---------------------------------------------------------------------------

export const STREAM_STALL_CODE = 'STREAM_STALL'
export const STREAM_TRUNCATED_CODE = 'STREAM_TRUNCATED'
export const GUARD_CODES = Object.freeze([STREAM_STALL_CODE, STREAM_TRUNCATED_CODE])

/**
 * A terminal `error` finish chunk for a damaged stream.
 * @param {string} code - guard code.
 * @param {string} message - account for the failure.
 * @returns {object} a `StreamChunk` of type `finish`.
 */
export function guardFinishChunk(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message, status: 0 } } }
}

/**
 * Whether an adapter's terminal `finish` should be replaced by an error.
 * @param {object} finishChunk - the adapter finish chunk.
 * @param {{ text: string, toolCalls: number }} pending - accumulated stream facts.
 * @param {object} options - resolved config.
 * @returns {{ damage: boolean, reason: string }}
 */
export function inspectFinish(finishChunk, pending, options) {
  const reason = finishChunk?.reason
  if (reason === undefined || reason === null) return { damage: false, reason: 'no-reason' }
  if (reason.kind !== 'stop') return { damage: false, reason: `kind:${String(reason.kind)}` }
  if (!options.streamGuard) return { damage: false, reason: 'guard-off' }
  if (pending.toolCalls > 0) return { damage: false, reason: 'tool-calls' }
  const text = stripProtocolMarkers(pending.text, options)
  if (text.trim().length === 0) return { damage: false, reason: 'no-text' }
  if (matchesAsking({ final: { text, toolCalls: 0 } }, options)) {
    return { damage: false, reason: 'asking-user' }
  }
  if (isSettled(text)) return { damage: false, reason: 'settled' }
  return { damage: true, reason: 'unsettled-text' }
}

class IdleTimeout extends Error {}

/**
 * Await the next chunk, failing when the adapter goes silent for `idleMs`.
 * @param {AsyncIterator<object>} iterator - upstream iterator.
 * @param {number} idleMs - silence budget; non-positive disables the watchdog.
 * @returns {Promise<object | undefined>}
 */
function nextWithWatchdog(iterator, idleMs) {
  if (!(idleMs > 0)) return iterator.next().then((step) => step.value)
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new IdleTimeout('idle')), idleMs)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  const read = iterator.next().then((step) => step.value)
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Wrap one adapter stream with the stall watchdog and the truncation guard.
 * @param {AsyncIterable<object>} upstream - the adapter stream.
 * @param {object} context - guard context.
 * @param {object} context.options - resolved config.
 * @param {() => boolean} context.consumeTruncationBudget - budget check.
 * @param {(record: object) => void} context.log - decision sink.
 * @returns {AsyncIterable<object>}
 */
export async function* guardStream(upstream, context) {
  const { options, consumeTruncationBudget, log } = context
  const pending = { text: '', toolCalls: 0 }
  const iterator = upstream[Symbol.asyncIterator]()
  let finished = false

  try {
    for (;;) {
      let chunk
      try {
        chunk = await nextWithWatchdog(iterator, options.streamIdleMs)
      } catch (error) {
        if (error instanceof IdleTimeout) {
          log({ event: 'guard', damage: 'stall', action: 'error-finish' })
          yield guardFinishChunk(
            STREAM_STALL_CODE,
            `no stream chunk for ${options.streamIdleMs}ms; treating the request as failed`,
          )
          return
        }
        throw error
      }

      if (chunk === undefined) {
        log({ event: 'guard', damage: 'no-finish', action: 'error-finish' })
        yield guardFinishChunk(STREAM_TRUNCATED_CODE, 'stream ended without a finish chunk')
        return
      }

      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') pending.text += chunk.text
      else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') pending.toolCalls += 1
      else if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
        pending.toolCalls += 1
      }

      if (chunk.type === 'finish') {
        finished = true
        const verdict = inspectFinish(chunk, pending, options)
        if (verdict.damage && consumeTruncationBudget()) {
          log({
            event: 'guard',
            damage: 'truncated',
            verdict: verdict.reason,
            action: 'error-finish',
            tail: pending.text.trim().slice(-LOG_TAIL_CHARS),
          })
          yield guardFinishChunk(
            STREAM_TRUNCATED_CODE,
            'stream stopped mid-thought; treating the request as failed',
          )
          return
        }
        yield chunk
        return
      }

      yield chunk
    }
  } finally {
    if (!finished) {
      // Never awaited: a hanging provider would hold the retry for as long as it hangs.
      try {
        const pendingReturn = iterator.return?.()
        if (pendingReturn !== undefined && typeof pendingReturn.then === 'function') {
          pendingReturn.then(undefined, () => {})
        }
      } catch {
        /* best-effort cancellation */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// overload reconnect
// ---------------------------------------------------------------------------

/**
 * Failures that must never be treated as overload, whatever their status or wording.
 *
 * An outage is waited out because the next attempt can plausibly succeed. These cannot: a
 * revoked key, an exhausted balance, or a request that is too large for the model fails
 * identically forever, so an unbounded reconnector would burn every 10 seconds for the rest
 * of the session instead of surfacing the one thing the user has to fix.
 *
 * The check runs **before** the overload match because provider wording overlaps: an
 * exhausted-quota message is routinely phrased with "rate limit", and a 429 can just as
 * easily carry "quota exceeded".
 */
export const FATAL_CODES = Object.freeze([
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'NO_CREDENTIAL_STORE',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'ACCOUNT_TOKEN_INVALID',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REQUEST',
  'MODEL_UNSUPPORTED',
  'UNKNOWN_MODEL',
  'INVALID_MODEL_CONTEXT',
  'UNSUPPORTED_REASONING_EFFORT',
  'UNSUPPORTED_OPTION',
])

/** Provider wording that means a terminal condition rather than a load shed. */
export const FATAL_PATTERNS = Object.freeze([
  /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i,
  /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
  /\binvalid[\s_-]+(?:api[\s_-]?key|token|credential)\b/i,
  /余额不足|额度(?:不足|已用尽|耗尽)|欠费|请充值|重新登录/i,
  /context[\s_-](?:length|window)[\s_-](?:exceeded|overflow)/i,
  /maximum\s+context\s+(?:length|window)/i,
])

/**
 * @param {{ code?: unknown, message?: unknown }} failure - the request failure.
 * @returns {string | undefined} the fatal reason, or undefined when it is not fatal.
 */
export function classifyFatal(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : ''
  if (code.length > 0 && FATAL_CODES.includes(code)) return `code:${code}`
  const message = typeof failure?.message === 'string' ? failure.message : ''
  if (message.length === 0) return undefined
  for (const pattern of FATAL_PATTERNS) {
    if (pattern.test(message)) return `message:${pattern.source}`
  }
  return undefined
}

/**
 * Whether one provider failure is the "come back in a minute" shape — the only kind this
 * plugin reconnects without a ceiling.
 *
 * Two independent signals are accepted, because the code an adapter reports and the text
 * the gateway sent do not always line up: `dsh-llm-pi-ai` maps every `5xx` to `SERVER`,
 * so its code alone cannot distinguish a load-shed 529 from a broken gateway, while the
 * message still carries `529` / `1305` / `overloaded_error`.
 *
 * @param {{ code?: unknown, status?: unknown, message?: unknown }} failure - the
 *   `agent/request-error` failure.
 * @param {object} options - resolved config.
 * @returns {{ overload: boolean, reason: string }}
 */
export function classifyOverload(failure, options) {
  if (failure === undefined || failure === null) return { overload: false, reason: 'no-failure' }

  // A terminal condition outranks every "try again later" signal, including a 429 status:
  // waiting does not refill a balance or shrink an oversized request.
  const fatal = classifyFatal(failure)
  if (fatal !== undefined) return { overload: false, reason: `fatal:${fatal}` }

  const code = typeof failure.code === 'string' ? failure.code : ''
  const status = typeof failure.status === 'number' ? failure.status : undefined
  const message = typeof failure.message === 'string' ? failure.message : ''

  // A status the adapter managed to carry is the strongest signal there is.
  if (status === 429 || status === 529) return { overload: true, reason: `status:${status}` }
  if (code.length > 0 && options.overloadCodes.includes(code)) {
    return { overload: true, reason: `code:${code}` }
  }
  if (message.length > 0) {
    for (const pattern of options.overloadPatterns) {
      if (pattern.test(message)) return { overload: true, reason: `message:${pattern.source}` }
    }
  }
  return { overload: false, reason: `code:${code || 'unknown'}` }
}

/**
 * Policy-key prefix that marks a durable `llm/retry` record as this plugin's own.
 * `dsh-llm-retry` keys its projection state by `provider` + `policyKey`, so a distinct
 * prefix keeps our unbounded series from being mistaken for (or counted against) the
 * provider's bounded one. The prefix is deliberately independent of the configured
 * interval: tuning the wait must not reset the visible attempt count.
 */
export const OVERLOAD_POLICY_PREFIX = 'auto-continue:'

/** The complete policy key of a reconnect record. */
export const OVERLOAD_POLICY_KEY = `${OVERLOAD_POLICY_PREFIX}overload`

/**
 * Locate the retry chain the current step already recorded, so our attempts continue the
 * row the user is already looking at instead of opening a second one.
 *
 * Both numbers are read from the durable log, not from process memory: a plugin reload in
 * the middle of a long outage must not restart the count at 1. The scan walks backwards in
 * one pass and counts **all** of this plugin's records for the step, so the count is right
 * even when the provider's own records sit above ours.
 *
 * @param {object} session - the agent's session.
 * @param {number} turn - current turn.
 * @param {number} step - current step.
 * @returns {{ retryId?: string, baseRetry: number, ours: number }}
 */
export function findRetryChain(session, turn, step) {
  const found = { baseRetry: 0, ours: 0 }
  if (typeof session?.eventAt !== 'function' || typeof session?.seq !== 'number') return found
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    if (event.type !== 'llm/retry') continue
    const data = event.data
    if (data?.turn !== turn || data?.step !== step) continue
    const policyKey = typeof data.policyKey === 'string' ? data.policyKey : ''
    if (policyKey.startsWith(OVERLOAD_POLICY_PREFIX)) {
      found.ours += 1
      continue
    }
    // Newest record from the provider's own policy: it owns the chain and its numbering.
    if (found.retryId === undefined) {
      if (typeof data.retryId === 'string' && data.retryId.length > 0) found.retryId = data.retryId
      found.baseRetry = Number.isInteger(data.retry) && data.retry > 0 ? data.retry : 0
    }
  }
  return found
}

/**
 * Record one reconnect as a durable `llm/retry` event, the same record `dsh-llm-retry`
 * writes for its own attempts.
 *
 * This is what keeps the wait honest to the user: the chat renders the chain from these
 * events (provider, failure, attempt count, countdown), so an unbounded reconnect shows up
 * as a live "retrying ∞ — 10s" row instead of a turn that looks stuck. Reporting it only to
 * this plugin's own log file would hide a potentially hours-long wait from the conversation.
 *
 * @param {object} payload - the `agent/request-error` payload.
 * @param {{ retryId: string, retry: number, delayMs: number }} record - what to record.
 * @param {object} failure - the provider failure being waited out.
 * @returns {boolean} whether the record was written.
 */
export function announceReconnect(payload, record, failure) {
  const session = payload?.agent?.session
  if (typeof session?.append !== 'function') return false
  try {
    session.append('llm/retry', {
      retryId: record.retryId,
      turn: payload.turn,
      step: payload.step,
      provider: String(payload.provider ?? 'unknown'),
      mode: 'always',
      policyKey: OVERLOAD_POLICY_KEY,
      retry: record.retry,
      delayMs: record.delayMs,
      failure,
    })
    return true
  } catch {
    // A session that refuses the record must not stop the reconnect itself.
    return false
  }
}

/**
 * Close one reconnect record once its wait actually completed.
 * @param {object} payload - the `agent/request-error` payload.
 * @param {{ retryId: string, retry: number }} record - the record to close.
 * @returns {void}
 */
export function announceReconnectStarted(payload, record) {
  const session = payload?.agent?.session
  if (typeof session?.append !== 'function') return
  try {
    session.append('llm/retry-started', {
      retryId: record.retryId,
      turn: payload.turn,
      step: payload.step,
      retry: record.retry,
    })
  } catch {
    /* the wait already happened; a failed announcement changes nothing */
  }
}

/**
 * Answer one `agent/request-error` for the overload reconnector.
 *
 * The bounded retry policy (`dsh-llm-retry`, 5 attempts by default) must get every attempt
 * it is entitled to **before** this listener starts reconnecting without a ceiling.
 * Registration order cannot be relied on: a profile may mount this plugin above or below
 * `llm-retry` on the waterfall. So this listener always asks downstream first and passes a
 * downstream `{ kind: 'retry' }` through untouched; it only takes over once the downstream
 * chain declines the failure, which is exactly the moment DSH would otherwise render
 * "本轮运行失败" and close the turn.
 *
 * Returning `{ kind: 'retry' }` re-sends the request inside the same step, so the
 * conversation, the tool results and the user's place in the turn all survive.
 *
 * @param {object} payload - the `agent/request-error` payload.
 * @param {() => Promise<object>} next - the downstream recovery chain.
 * @param {object} options - resolved config.
 * @param {Map<string, object>} state - per-provider reconnect bookkeeping.
 * @param {(record: object) => void} log - decision sink.
 * @returns {Promise<object>}
 */
export async function reconnectOnOverload(payload, next, options, state, log) {
  if (!options.overloadReconnect) return next()

  const failure = payload?.failure
  const verdict = classifyOverload(failure, options)
  if (!verdict.overload) return next()

  // A cancelled turn is the user's decision, not an outage: never hold it open.
  if (payload?.signal?.aborted === true) {
    log({ event: 'overload', action: 'delegate', reason: 'turn-aborted' })
    return next()
  }

  // Let the provider's own bounded retry spend its budget first. Anything downstream
  // answers is passed straight back up; only a declined failure reaches the code below.
  const downstream = await next()
  if (downstream?.kind === 'retry') return downstream

  const provider = String(payload?.provider ?? 'unknown')
  const turn = payload?.turn
  const step = payload?.step
  // Bookkeeping is per provider **and** per step: a new step means the previous attempt
  // series ended (probably successfully), so the reconnect budget must start over.
  const previous = state.get(provider)
  const entry =
    previous !== undefined && previous.turn === turn && previous.step === step
      ? previous
      : { attempts: 0, since: Date.now(), turn, step }
  state.set(provider, entry)
  entry.attempts += 1

  const waitedMs = Date.now() - entry.since
  if (options.overloadMaxWaitMs > 0 && waitedMs >= options.overloadMaxWaitMs) {
    log({
      event: 'overload',
      action: 'delegate',
      reason: 'wait-budget-exhausted',
      provider,
      attempts: entry.attempts,
      waitedMs,
    })
    return undefined
  }

  // Continue the chain the conversation already shows: same retry id as the provider's
  // attempts, numbered after them, so the row keeps counting up instead of restarting.
  //
  // The durable log is the authority, but it is only readable when the session exposes
  // `eventAt`/`seq`. Where it does not, the per-provider entry still knows how many
  // reconnects this step already made, so the number keeps climbing instead of pinning
  // at 1 — a display detail, but one the user reads as "is this thing still alive?".
  const chain = findRetryChain(payload?.agent?.session, turn, step)
  const record = {
    retryId: typeof chain.retryId === 'string'
      ? chain.retryId
      : `${OVERLOAD_POLICY_PREFIX}${provider}:${String(turn)}:${String(step)}`,
    retry: chain.baseRetry + Math.max(chain.ours, entry.attempts - 1) + 1,
    delayMs: options.overloadRetryIntervalMs,
  }
  const announced = announceReconnect(payload, record, failure)

  log({
    event: 'overload',
    action: 'reconnect',
    provider,
    turn: turn ?? null,
    step: step ?? null,
    attempt: entry.attempts,
    retry: record.retry,
    intervalMs: options.overloadRetryIntervalMs,
    match: verdict.reason,
    announced,
    code: typeof failure?.code === 'string' ? failure.code : null,
    status: typeof failure?.status === 'number' ? failure.status : null,
    requestId: typeof failure?.requestId === 'string' ? failure.requestId : null,
  })

  // `keepAlive: true`: this wait is the whole point — the reconnect must still be pending
  // when the provider recovers, so it may hold the loop open (a shutdown aborts it anyway).
  const waited = await sleep(options.overloadRetryIntervalMs, payload?.signal, { keepAlive: true })
  if (!waited) {
    log({ event: 'overload', action: 'delegate', reason: 'wait-cancelled', attempts: entry.attempts })
    // The turn is over; hand the failure back so the loop records its own ending.
    return undefined
  }
  if (announced) announceReconnectStarted(payload, record)

  return { kind: 'retry' }
}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

/**
 * @returns {string} the default plugin log path.
 */
export function defaultLogFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, name, 'events.jsonl')
}

/**
 * Append one plugin-log line. Every failure path is swallowed: logging must never be
 * able to break a turn.
 * @param {object} options - resolved config.
 * @param {object} ctx - plugin context, for `ctx.logger`.
 * @param {object} record - the line to write.
 * @returns {void}
 */
export function writePluginLog(options, ctx, record) {
  const interesting =
    record.event === 'nudge' || record.event === 'error' || record.event === 'inert'
  if (!options.logDecisions && !interesting) return
  const line = JSON.stringify({ time: new Date().toISOString(), plugin: name, ...record })
  try {
    const file = options.logFile.length > 0 ? options.logFile : defaultLogFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${line}\n`)
  } catch {
    /* a log write must never affect the loop */
  }
  try {
    if (record.event === 'error') ctx?.logger?.warn?.(`${name}: ${record.message ?? 'error'}`)
    else ctx?.logger?.info?.(`${name}: ${record.event}`)
  } catch {
    /* a logger must never affect the loop */
  }
}

// ---------------------------------------------------------------------------
// listener
// ---------------------------------------------------------------------------

/**
 * Read (or start) the per-agent bookkeeping for the current turn.
 * @param {Map<string, object>} states - per-agent state.
 * @param {string} agentId - agent identity.
 * @param {number} turn - turn being closed.
 * @param {object} folded - folded turn facts.
 * @returns {{ turn: number, count: number, fingerprints: Set<string> }}
 */
export function stateFor(states, agentId, turn, folded) {
  let state = states.get(agentId)
  if (state === undefined || state.turn !== turn) {
    state = { turn, count: 0, attempts: 0, gaveUp: false, lastPushAt: undefined, fingerprints: new Set() }
    states.set(agentId, state)
  } else if (folded.userInputs > 0) {
    state.count = 0
    state.attempts = 0
    state.gaveUp = false
    state.fingerprints.clear()
  }
  return state
}

/**
 * Wait for `ms`, giving up as soon as `signal` aborts.
 *
 * The abort listener is registered for the whole wait and removed on both exits, so a
 * reconnector that runs for hours does not leak one listener per attempt onto the turn's
 * signal.
 *
 * `keepAlive` decides whether the timer holds the event loop open. The reconnect wait keeps
 * it (its only job is to still be waiting when the provider recovers, so letting the process
 * fall out from under it would be self-defeating); an ordinary in-turn pause does not, so a
 * shutting-down host is never held up by a plugin's cosmetic delay.
 * @param {number} ms - delay.
 * @param {AbortSignal} [signal] - optional cancellation.
 * @param {{ keepAlive?: boolean }} [options] - timer ref behaviour.
 * @returns {Promise<boolean>} false when the wait was cancelled.
 */
function sleep(ms, signal, options = {}) {
  if (signal?.aborted === true) return Promise.resolve(false)
  if (!(ms > 0)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (completed) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(completed)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(true), ms)
    if (options.keepAlive !== true && typeof timer?.unref === 'function') timer.unref()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * One `agent/turn-stopping` evaluation.
 * @param {object} ctx - plugin context.
 * @param {object} options - resolved config.
 * @param {Map<string, object>} states - per-agent state.
 * @param {object} payload - event payload.
 * @returns {Promise<void>}
 */
async function onTurnStopping(ctx, options, states, payload) {
  const agent = payload?.agent
  const turn = payload?.turn
  const signal = payload?.signal
  if (agent === undefined || agent === null || typeof agent.steer !== 'function') return
  if (!Number.isInteger(turn)) return
  const session = agent.session
  if (session === undefined || session === null) return

  if (signal?.aborted === true) {
    writePluginLog(options, ctx, { event: 'skip', turn, reason: 'turn-aborted' })
    return
  }
  if (agent.status !== undefined && agent.status !== 'running') {
    writePluginLog(options, ctx, { event: 'skip', turn, reason: `status:${String(agent.status)}` })
    return
  }
  if (latestGoalPhase(session) === 'active') {
    writePluginLog(options, ctx, { event: 'skip', turn, reason: 'goal-active' })
    return
  }

  const window = turnWindow(session, turn)
  if (window === undefined) {
    writePluginLog(options, ctx, { event: 'skip', turn, reason: 'no-turn-window' })
    return
  }

  const folded = foldTurn(window.events)
  const route = routeOf(folded, session)
  const decision = decide(folded, route, options)
  const agentId = String(agent.id ?? 'unknown')
  const state = stateFor(states, agentId, turn, folded)

  const base = {
    event: 'decision',
    agentId,
    sessionId: typeof session.id === 'string' ? session.id : null,
    turn,
    route: route ?? null,
    hadRetry: folded.hadRetry,
    toolCalls: folded.toolCalls,
    stopReason: folded.final?.stopReason ?? null,
    isAsking: matchesAsking(folded, options),
    planTail: matchesPlanTail(folded, options),
    scopes: matchedScopes(folded, options),
    userTakeovers: folded.userInputs,
    priorNudges: state.count,
    rule: decision.rule,
    reason: decision.reason,
  }

  if (!decision.nudge) {
    writePluginLog(options, ctx, { ...base, nudge: false })
    return
  }

  // Budget: only pushes that led nowhere count, and a push that made the model do real
  // work resets the streak. There is deliberately NO total-attempts ceiling: a turn that
  // keeps making progress must be re-opened as often as it stops. A model that stops
  // without producing anything simply adds to the streak and gets cut off at maxNudges.
  // The durable log is the authority, so a reload or a second instance cannot talk itself
  // past the cap.
  const durableStreak = folded.unproductiveStreak ?? 0
  state.count = durableStreak
  // `state.attempts` is kept for the log only (how many pushes this turn saw in total).
  // It must never gate a push.
  if (state.count >= options.maxNudges) {
    // R5: when we really give up, say so in the conversation instead of closing silently.
    if (!state.gaveUp) {
      state.gaveUp = true
      try {
        const notice = buildNudgeMessage({ turn, rule: 'give-up', text: options.giveUpNoticeText })
        agent.steer(notice)
        writePluginLog(options, ctx, {
          event: 'giveup',
          turn,
          reason: 'max-nudges-reached',
          attempts: state.attempts,
          messageId: notice.id,
        })
      } catch {
        /* a failed notice must never take the turn down */
      }
    }
    writePluginLog(options, ctx, {
      ...base,
      priorNudges: state.count,
      attempts: state.attempts,
      nudge: false,
      reason: 'max-nudges-reached',
    })
    return
  }

  const fingerprint = fingerprintOf(folded.final)
  if (fingerprint !== undefined && state.fingerprints.has(fingerprint)) {
    writePluginLog(options, ctx, { ...base, nudge: false, reason: 'duplicate-fingerprint' })
    return
  }

  if (options.dryRun) {
    writePluginLog(options, ctx, { ...base, nudge: false, reason: 'dry-run', wouldNudge: true })
    return
  }

  // R4: never fire two pushes back to back. A one-second upstream hiccup must not eat the
  // whole budget, so the gap is measured from the last push we actually made.
  const lastPushAt = state.lastPushAt ?? folded.lastPushTime
  const sinceLast = typeof lastPushAt === 'number' ? Date.now() - lastPushAt : Number.POSITIVE_INFINITY
  const waitMs = Math.max(options.delayMs, options.nudgeMinIntervalMs - sinceLast, 0)
  if (waitMs > 0) {
    await sleep(waitMs)
    if (signal?.aborted === true) {
      writePluginLog(options, ctx, { ...base, nudge: false, reason: 'turn-aborted-after-delay' })
      return
    }
  }

  const message = buildNudgeMessage({
    turn,
    rule: decision.rule,
    text:
      options.completionProtocol && decision.reason === 'protocol-missing'
        ? options.protocolNudgeText
        : options.nudgeText,
  })
  agent.steer(message)

  state.count += 1
  state.attempts += 1
  state.lastPushAt = Date.now()
  if (fingerprint !== undefined) state.fingerprints.add(fingerprint)
  writePluginLog(options, ctx, {
    ...base,
    event: 'nudge',
    nudge: true,
    priorNudges: state.count - 1,
    nudgeIndex: state.attempts,
    attempts: state.attempts,
    maxNudges: options.maxNudges,
    messageId: message.id,
  })
}

/**
 * Install the plugin.
 *
 * `enabled: false` installs nothing at all. `maxNudges: 0` disables the two push layers
 * (completion protocol and turn-stopping) but **not** the overload reconnector: stopping
 * the "推它继续" behaviour is a different wish from stopping the "别把这一轮判死" behaviour,
 * and the latter is what keeps a long task alive through a provider outage.
 * @param {object} ctx - the plugin context.
 * @param {unknown} config - the Loader row's config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = resolveConfig(config)
  if (options.invalidPatterns.length > 0) {
    writePluginLog(options, ctx, {
      event: 'inert',
      message: `ignored ${options.invalidPatterns.length} invalid pattern(s)`,
    })
  }
  if (!options.enabled) {
    writePluginLog(options, ctx, { event: 'inert', reason: 'enabled=false' })
    return
  }

  const nudging = options.maxNudges > 0
  if (!nudging && !options.overloadReconnect) {
    writePluginLog(options, ctx, { event: 'inert', reason: 'maxNudges=0 and overloadReconnect=false' })
    return
  }
  if (!nudging) {
    writePluginLog(options, ctx, { event: 'inert', reason: 'maxNudges=0: nudge layers off' })
  }

  /** @type {Map<string, { turn: number, count: number, fingerprints: Set<string> }>} */
  const states = new Map()
  /** @type {Map<string, { used: number }>} */
  const guardBudgets = new Map()
  /** @type {Map<string, number>} */
  const guardRetries = new Map()
  /** @type {Map<string, { attempts: number, since: number }>} */
  const overloadState = new Map()

  // ---- completion protocol: our own system-prompt section -------------------
  // The service key is `systemPrompt` (camelCase); `system-prompt` is the event name.
  // The returned disposer MUST be registered: without it every reload appends another
  // section to live sessions.
  if (nudging && options.completionProtocol) {
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt === undefined) {
        writePluginLog(options, ctx, {
          event: 'error',
          message: 'completionProtocol requested but no systemPrompt service is mounted',
        })
      } else {
        ctx.effect(() =>
          systemPrompt.section({
            name: 'auto-continue-protocol',
            order: PROTOCOL_SECTION_ORDER,
            text: buildProtocolInstruction(options),
          }),
        )
        writePluginLog(options, ctx, {
          event: 'inert',
          message: `completion protocol section installed (${options.markerStyle})`,
        })
      }
    } catch (error) {
      try {
        writePluginLog(options, ctx, {
          event: 'error',
          message: error instanceof Error ? error.message : String(error),
          stage: 'protocol-section',
        })
      } catch {
        /* activation must not fail over a prompt section */
      }
    }
  }

  ctx.on('agent/disposed', (payload) => {
    try {
      const agentId = payload?.agent?.id
      if (agentId === undefined) {
        states.clear()
        guardBudgets.clear()
        guardRetries.clear()
        overloadState.clear()
        return
      }
      const key = String(agentId)
      states.delete(key)
      guardBudgets.delete(key)
      overloadState.delete(key)
      const prefix = `${key}|`
      for (const retryKey of guardRetries.keys()) {
        if (retryKey.startsWith(prefix)) guardRetries.delete(retryKey)
      }
    } catch {
      /* bookkeeping only */
    }
  })

  if (nudging) {
    ctx.on('agent/turn-stopping', async (payload) => {
      try {
        await onTurnStopping(ctx, options, states, payload)
      } catch (error) {
        try {
          writePluginLog(options, ctx, {
            event: 'error',
            message: error instanceof Error ? error.message : String(error),
            turn: payload?.turn ?? null,
          })
        } catch {
          /* the innermost failure path still must not throw */
        }
      }
    })
  }

  // ---- provider-side guard --------------------------------------------------
  if (options.streamGuard) {
    const logGuard = (record) => {
      try {
        writePluginLog(options, ctx, record)
      } catch {
        /* diagnostics must never affect the stream */
      }
    }

    ctx.on('llm/stream', (requestOptions, next) => {
      const route = `${String(requestOptions?.provider)}/${String(requestOptions?.model)}`
      if (requestOptions?.purpose !== undefined) return next()
      if (options.allowModels.length > 0 && !options.allowModels.includes(route)) return next()

      const sessionId = requestOptions?.sessionId
      const key = typeof sessionId === 'string' ? sessionId : 'anonymous'
      let budget = guardBudgets.get(key)
      if (budget === undefined) {
        budget = { used: 0 }
        guardBudgets.set(key, budget)
      }
      const theBudget = budget
      const consumeTruncationBudget = () => {
        if (theBudget.used >= options.maxGuardRetries) return false
        theBudget.used += 1
        return true
      }

      const wrapped = guardStream(next(), { options, consumeTruncationBudget, log: logGuard })

      // Only a clean, settled finish gives the budget back; an unsettled stop that the
      // guard merely delegated must not reset it, or a route that truncates every time
      // would be intercepted again and again instead of staying capped.
      return (async function* () {
        let text = ''
        for await (const chunk of wrapped) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'finish' && chunk.reason?.kind === 'stop') {
            if (isSettled(stripProtocolMarkers(text, options))) theBudget.used = 0
          }
          yield chunk
        }
      })()
    })

    ctx.on('agent/request-error', async (payload, next) => {
      try {
        const code = payload?.failure?.code
        if (!GUARD_CODES.includes(code)) return next()
        const agentId = String(payload?.agent?.id ?? 'unknown')
        const retryKey = `${agentId}|${payload?.turn}|${payload?.step}|${code}`
        const taken = guardRetries.get(retryKey) ?? 0
        if (taken >= options.maxGuardRetries) {
          logGuard({ event: 'guard', damage: code, action: 'delegate', retriesTaken: taken })
          return next()
        }
        guardRetries.set(retryKey, taken + 1)
        logGuard({
          event: 'guard',
          damage: code,
          action: 'retry',
          retryIndex: taken + 1,
          turn: payload?.turn ?? null,
          step: payload?.step ?? null,
        })
        return { kind: 'retry' }
      } catch (error) {
        try {
          logGuard({
            event: 'error',
            message: error instanceof Error ? error.message : String(error),
            stage: 'guard-retry',
          })
        } catch {
          /* never let guard logging break recovery */
        }
        return next()
      }
    })
  }

  // ---- overload reconnector -------------------------------------------------
  // Relative to `dsh-llm-retry` this listener is order-independent, because
  // `reconnectOnOverload` always asks downstream first and passes a downstream
  // `{ kind: 'retry' }` through untouched: whichever of the two is outer, the provider's
  // bounded budget is spent before the unbounded reconnector takes over. The only moment
  // this layer acts is the one where the whole chain declined — i.e. where the loop would
  // otherwise throw and close the turn as failed.
  if (options.overloadReconnect) {
    const logOverload = (record) => {
      try {
        writePluginLog(options, ctx, record)
      } catch {
        /* diagnostics must never affect recovery */
      }
    }

    ctx.on('agent/request-error', async (payload, next) => {
      try {
        return await reconnectOnOverload(payload, next, options, overloadState, logOverload)
      } catch (error) {
        try {
          logOverload({
            event: 'error',
            message: error instanceof Error ? error.message : String(error),
            stage: 'overload-reconnect',
          })
        } catch {
          /* never let reconnect logging break recovery */
        }
        // Deliberately NOT `next()`: a waterfall `next` is single-shot, and the failure may
        // already have been delegated inside `reconnectOnOverload`. Declining here leaves
        // the loop to record its own ending, which is the pre-plugin behaviour.
        return undefined
      }
    })
  }

  ctx.effect(() => () => {
    states.clear()
    guardBudgets.clear()
    guardRetries.clear()
    overloadState.clear()
  })
}
