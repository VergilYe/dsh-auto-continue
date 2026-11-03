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
 * Three layers, cheapest first:
 *   - `llm/stream` guard: a stream that stops mid-thought or goes silent becomes a
 *     terminal `error`, so DSH's own retry re-sends inside the same step.
 *   - completion protocol: an injected system-prompt section asks for an explicit
 *     end-of-reply declaration. Declared ⇒ close; missing after real work ⇒ push.
 *   - heuristic scopes: reconnect / unsettled text / plan phrasing, for when the
 *     protocol is off.
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
 * @param {number} ms - delay.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer?.unref === 'function') timer.unref()
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
 * With `enabled: false` or `maxNudges: 0` nothing is installed and the plugin is
 * behaviourally identical to not being installed.
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
  if (!options.enabled || options.maxNudges <= 0) {
    writePluginLog(options, ctx, {
      event: 'inert',
      reason: options.enabled ? 'maxNudges=0' : 'enabled=false',
    })
    return
  }

  /** @type {Map<string, { turn: number, count: number, fingerprints: Set<string> }>} */
  const states = new Map()
  /** @type {Map<string, { used: number }>} */
  const guardBudgets = new Map()
  /** @type {Map<string, number>} */
  const guardRetries = new Map()

  // ---- completion protocol: our own system-prompt section -------------------
  // The service key is `systemPrompt` (camelCase); `system-prompt` is the event name.
  // The returned disposer MUST be registered: without it every reload appends another
  // section to live sessions.
  if (options.completionProtocol) {
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
        return
      }
      const key = String(agentId)
      states.delete(key)
      guardBudgets.delete(key)
      const prefix = `${key}|`
      for (const retryKey of guardRetries.keys()) {
        if (retryKey.startsWith(prefix)) guardRetries.delete(retryKey)
      }
    } catch {
      /* bookkeeping only */
    }
  })

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

  ctx.effect(() => () => {
    states.clear()
    guardBudgets.clear()
    guardRetries.clear()
  })
}
