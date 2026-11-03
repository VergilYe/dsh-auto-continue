import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConfig,
  buildProtocolInstruction,
  parseProtocol,
  stripProtocolMarkers,
  isSettled,
  lastSentence,
  closingRegion,
  decide,
  matchedScopes,
  matchesAsking,
  matchesPlanTail,
  foldTurn,
  stateFor,
  buildNudgeMessage,
  fingerprintOf,
  DEFAULTS,
  MARKER_STYLES,
  SOURCE_KIND,
} from '../index.js';

const ROUTE = 'open-design/deepseek-v4.1-flash';
const FENCE = '`'.repeat(3);
const DONE_OPEN = `${FENCE}done`;
const ASK_OPEN = `${FENCE}ask`;
const CLOSE = FENCE;

const folded = (text, { toolCalls = 3, hadRetry = false, retryCodes = [], pushes = 0, userInputs = 0 } = {}) => ({
  hadRetry,
  toolCalls,
  userInputs,
  pushes,
  retryCodes,
  final: {
    id: 'm1',
    seq: 2,
    text,
    toolCalls: 0,
    stopReason: 'stop',
    provider: 'open-design',
    model: 'deepseek-v4.1-flash',
  },
});

const doneBlock = (summary) => `${DONE_OPEN}\n✅ 已完成：${summary}\n${CLOSE}`;
const askBlock = (question) => `${ASK_OPEN}\n❓ 待确认：${question}\n${CLOSE}`;

test('config: protocol on by default, fence-check markers, no brackets', () => {
  const options = resolveConfig({});
  assert.equal(options.completionProtocol, true);
  assert.equal(options.markerStyle, 'fence-check');
  assert.equal(options.doneMarker, DONE_OPEN);
  assert.equal(options.askMarker, ASK_OPEN);
  assert.equal(options.donePrefix, '✅ 已完成：');
  assert.equal(options.askPrefix, '❓ 待确认：');
  assert.equal(options.maxNudges, 2);
  assert.equal(options.streamGuard, true);
  assert.equal(options.streamIdleMs, 90_000);
  assert.ok(!options.doneMarker.includes('['), 'no bracketed marker by default');
});

test('config: unknown marker style falls back to fence-check', () => {
  assert.equal(resolveConfig({ markerStyle: 'nope' }).markerStyle, 'fence-check');
  assert.equal(resolveConfig({ markerStyle: 'line' }).markerStyle, 'line');
  assert.ok(MARKER_STYLES.plain, 'plain preset kept for compatibility');
});

test('config: invalid patterns are dropped, not thrown', () => {
  const options = resolveConfig({ planPatterns: ['(unclosed', 'ok'], isAskingPatterns: ['[bad'] });
  assert.equal(options.planPatterns.length, 1);
  assert.equal(options.isAskingPatterns.length, 0);
  assert.equal(options.invalidPatterns.length, 2);
});

test('instruction: describes the fenced checklist form', () => {
  const text = buildProtocolInstruction(resolveConfig({}));
  assert.match(text, /Turn-ending protocol/);
  assert.ok(text.includes(DONE_OPEN));
  assert.ok(text.includes(ASK_OPEN));
  assert.match(text, /✅ 已完成/);
  assert.match(text, /❓ 待确认/);
  assert.ok(!text.includes('[DONE:'), 'instruction must not mention bracketed markers');
});

test('parse: the four verdicts', () => {
  const options = resolveConfig({});
  assert.equal(parseProtocol(`改好了。\n${doneBlock('修好 3 个 bug')}`, options).verdict, 'done');
  assert.equal(parseProtocol(`还没定。\n${askBlock('同步 V2.4 吗')}`, options).verdict, 'ask');
  assert.equal(parseProtocol('改好了。', options).verdict, 'missing');
  assert.equal(parseProtocol(`改好了。\n${DONE_OPEN}\n${CLOSE}`, options).verdict, 'empty');
  assert.equal(parseProtocol('', options).verdict, 'missing');
  assert.equal(parseProtocol(undefined, options).verdict, 'missing');
});

test('parse: summary carries the declared text', () => {
  const options = resolveConfig({});
  const done = parseProtocol(doneBlock('修好 3 个 bug，回归 304 项通过'), options);
  assert.match(done.summary, /修好 3 个 bug/);
  const ask = parseProtocol(askBlock('只改 develop 还是同步 V2.4'), options);
  assert.match(ask.summary, /V2\.4/);
});

test('parse: the later block wins', () => {
  const options = resolveConfig({});
  const text = `草稿：\n${DONE_OPEN}\n✅ 已完成：初稿\n${CLOSE}\n还差一步。\n${askBlock('要同步吗')}`;
  assert.equal(parseProtocol(text, options).verdict, 'ask');
});

test('parse: a marker mentioned mid-text is not a declaration', () => {
  const options = resolveConfig({});
  const text = `协议要求用 ${DONE_OPEN} 收尾。\n\n${'细节行\n'.repeat(6)}现在检查这两点。`;
  assert.equal(parseProtocol(text, options).verdict, 'missing');
});

test('strip: removes the trailing block only', () => {
  const options = resolveConfig({});
  const text = `改完了三个文件。\n${doneBlock('304 项通过')}`;
  assert.equal(stripProtocolMarkers(text, options), '改完了三个文件。');
  assert.equal(stripProtocolMarkers(text, resolveConfig({ completionProtocol: false })), text);
});

test('isSettled: finished vs mid-thought', () => {
  for (const text of ['已修好。', '完成了！', '要我继续吗？', '已保存；', 'The build passes.', '| a | b |', '', '全部通过 **66/66**']) {
    assert.equal(isSettled(text), true, `expected settled: ${text}`);
  }
  for (const text of ['避免编码被破坏：', '接下来我会修改配置，', '见下文(', '看这里（', '他说「', '无标点结尾', 'no period', '待补充 -', '正在读取']) {
    assert.equal(isSettled(text), false, `expected unsettled: ${text}`);
  }
});

test('closing windows: last line vs last two lines', () => {
  assert.equal(lastSentence('第一行。\n最后一行：'), '最后一行：');
  assert.equal(lastSentence('…吗？（只提交 X）'), '…吗？（只提交 X）');
  assert.equal(closingRegion('a\nb\nc'), 'b\nc');
});

test('asking: matched on the last line, including a mid-line question mark', () => {
  const options = resolveConfig({});
  assert.equal(matchesAsking({ final: { text: '要我继续吗？' } }, options), true);
  assert.equal(matchesAsking({ final: { text: '等你打勾' } }, options), true);
  assert.equal(matchesAsking({ final: { text: '要我现在提交吗？（只提交 X）' } }, options), true);
  assert.equal(matchesAsking({ final: { text: '需要的话我现在就改。' } }, options), true);
  assert.equal(matchesAsking({ final: { text: '已读取文件，共 120 行。' } }, options), false);
});

test('plan: matched in the closing region only', () => {
  const options = resolveConfig({});
  assert.equal(matchesPlanTail({ final: { text: '读取完成。接下来我会修改配置。' } }, options), true);
  assert.equal(matchesPlanTail({ final: { text: '现在检查这两点。' } }, options), true);
  assert.equal(matchesPlanTail({ final: { text: '已完成。\n收尾完毕。' } }, options), false);
  const early = `接下来清理\n${'x'.repeat(300)}\n\n已完成。\n收尾完毕。`;
  assert.equal(matchesPlanTail({ final: { text: early } }, options), false);
});

test('decide/protocol: declared endings close the turn', () => {
  const options = resolveConfig({});
  const done = decide(folded(`改好了。\n${doneBlock('修好 3 个 bug')}`), ROUTE, options);
  assert.equal(done.nudge, false);
  assert.equal(done.reason, 'protocol-done');

  const ask = decide(folded(`还没定。\n${askBlock('同步 V2.4 吗')}`), ROUTE, options);
  assert.equal(ask.nudge, false);
  assert.equal(ask.reason, 'protocol-ask');
});

test('decide/protocol: a missing declaration after work is pushed', () => {
  const options = resolveConfig({});
  const missing = decide(folded('现在检查这两点。'), ROUTE, options);
  assert.equal(missing.nudge, true);
  assert.equal(missing.rule, 'protocol-missing');
  assert.equal(missing.reason, 'protocol-missing');
});

test('decide/protocol: an empty summary is pushed', () => {
  const options = resolveConfig({});
  const result = decide(folded(`改完了。\n${DONE_OPEN}\n${CLOSE}`), ROUTE, options);
  assert.equal(result.nudge, true);
  assert.equal(result.rule, 'protocol-empty');
});

test('decide/protocol: plain chat without a declaration is pushed too', () => {
  // The protocol asks for a declaration at the end of every reply, so "looks like chat"
  // is not an exemption any more: the turn must not close on an undeclared reply.
  const options = resolveConfig({});
  const chat = decide(folded('好的，明白了。', { toolCalls: 0 }), ROUTE, options);
  assert.equal(chat.nudge, true);
  assert.equal(chat.rule, 'protocol-missing');
  assert.equal(chat.reason, 'protocol-missing');
});

test('decide/protocol: a body-less reply is pushed with or without work', () => {
  const options = resolveConfig({});
  // The shape seen in the wild: the whole answer went into the reasoning channel, so the
  // visible body is empty. Whether the turn did tool work must not change the verdict.
  for (const toolCalls of [10, 0]) {
    for (const text of ['', '   \n\t ']) {
      const blank = decide(folded(text, { toolCalls }), ROUTE, options);
      assert.equal(blank.nudge, true, `expected a push for ${JSON.stringify(text)}/${toolCalls}`);
      assert.equal(blank.rule, 'protocol-empty-text');
      // Shares the protocol nudge text, so the model is asked for the closing block.
      assert.equal(blank.reason, 'protocol-missing');
    }
  }
});

test('decide/protocol: with the protocol off a body-less reply keeps the old verdict', () => {
  const options = resolveConfig({ completionProtocol: false });
  const blank = decide(folded('', { toolCalls: 10 }), ROUTE, options);
  assert.equal(blank.nudge, false);
  assert.equal(blank.reason, 'empty-final-text');
});

test('decide/protocol: an announced plan with zero tool calls is still pushed', () => {
  const options = resolveConfig({});
  const result = decide(folded('我继续把第三步做完。', { toolCalls: 0 }), ROUTE, options);
  assert.equal(result.nudge, true);
  assert.equal(result.rule, 'protocol-missing');
});

test('decide: gates hold regardless of the protocol', () => {
  const options = resolveConfig({});
  assert.equal(decide(folded(`x\n${doneBlock('y')}`), 'other/model', options).reason, 'model-not-allowed');
  const noStop = folded(`x\n${doneBlock('y')}`);
  noStop.final.stopReason = 'max-tokens';
  assert.equal(decide(noStop, ROUTE, options).nudge, false);
  const withTool = folded(`x\n${doneBlock('y')}`);
  withTool.final.toolCalls = 1;
  assert.equal(decide(withTool, ROUTE, options).nudge, false);
});

test('decide/heuristics: scopes apply when the protocol is off', () => {
  const options = resolveConfig({ completionProtocol: false });

  const retry = decide(folded('修好了，测试通过。', { hadRetry: true, retryCodes: ['TRANSPORT'] }), ROUTE, options);
  assert.equal(retry.nudge, true);
  assert.equal(retry.rule, 'retry');

  const plan = decide(folded('现在检查这两点。'), ROUTE, options);
  assert.equal(plan.nudge, true);
  assert.equal(plan.rule, 'plan');

  const truncated = decide(folded('我改用 Node 来做编辑，避免编码被破坏：'), ROUTE, options);
  assert.equal(truncated.nudge, true);
  assert.ok(truncated.scopes.includes('truncated'));

  const clean = decide(folded('修好了，测试通过。'), ROUTE, options);
  assert.equal(clean.nudge, false);
  assert.match(clean.reason, /no-scope/);

  const allOff = resolveConfig({ completionProtocol: false, retryScope: false, truncationScope: false, extendedScope: false });
  assert.equal(decide(folded('现在检查这两点。'), ROUTE, allOff).reason, 'all-scopes-off');
});

test('decide/heuristics: retry codes are filtered', () => {
  const options = resolveConfig({ completionProtocol: false });
  const quota = decide(folded('修好了。', { hadRetry: true, retryCodes: ['QUOTA'] }), ROUTE, options);
  assert.equal(quota.nudge, false);
  const noCode = decide(folded('修好了。', { hadRetry: true, retryCodes: [] }), ROUTE, options);
  assert.equal(noCode.nudge, true);
});

test('decide/heuristics: asking suppresses the push', () => {
  const options = resolveConfig({ completionProtocol: false });
  const asking = decide(folded('要不要我把剩下的也改了？', { hadRetry: true }), ROUTE, options);
  assert.equal(asking.nudge, false);
  assert.equal(asking.reason, 'asking-user');
});

test('foldTurn: counts work, retries, pushes and real takeovers', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [] } },
    { type: 'llm/retry', seq: 3, data: { turn: 1, step: 1, failure: { code: 'TRANSPORT' } } },
    { type: 'tool/call', seq: 4, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 5, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 6, data: { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm', replayState: { response: { stopReason: 'toolUse' } } } } } },
    { type: 'user/message', seq: 7, data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [] } },
    { type: 'user/message', seq: 8, data: { id: 'n1', role: 'user', source: { kind: SOURCE_KIND }, content: [] } },
    { type: 'assistant/message', seq: 9, data: { turn: 1, step: 2, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm', replayState: { response: { stopReason: 'stop' } } } } } },
  ];
  const result = foldTurn(events);
  assert.equal(result.hadRetry, true);
  assert.deepEqual(result.retryCodes, ['TRANSPORT']);
  assert.equal(result.toolCalls, 2);
  assert.equal(result.userInputs, 1, 'only the message after the first assistant output is a takeover');
  assert.equal(result.pushes, 1);
  assert.equal(result.final.id, 'm2');
  assert.equal(result.final.text, 'done');
  assert.equal(result.final.stopReason, 'stop');
});

test('foldTurn: only pushes that led nowhere count as unproductive', () => {
  const push = (seq) => ({ type: 'user/message', seq, data: { id: `n${seq}`, role: 'user', source: { kind: SOURCE_KIND }, content: [] }, time: seq * 1000 });
  const work = (seq) => ({ type: 'tool/call', seq, data: { turn: 1, step: 1 } });
  const open = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    push(2),
    work(3),
    push(4),
    work(5),
  ];
  const productive = foldTurn(open);
  assert.equal(productive.pushes, 2);
  assert.equal(productive.productivePushes, 2);
  assert.equal(productive.unproductiveStreak, 0, 'work after every push means no debt');
  assert.equal(productive.lastPushTime, 4000);

  const idle = foldTurn([{ type: 'turn/start', seq: 1, data: { turn: 1 } }, push(2), push(3)]);
  assert.equal(idle.unproductiveStreak, 2, 'two pushes with no work between them');

  // A productive push clears the debt that came before it.
  const mixed = foldTurn([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    push(2),
    push(3),
    work(4),
  ]);
  assert.equal(mixed.pushes, 2);
  assert.equal(mixed.unproductiveStreak, 0, 'the last push produced work');
});

test('foldTurn: a message without a replay envelope is never the final message', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: 'stream', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } } },
  ];
  assert.equal(foldTurn(events).final, null);
});

test('stateFor: takeover resets the bookkeeping, turn change resets it', () => {
  const states = new Map();
  const a = stateFor(states, 'a', 1, folded('x'));
  a.count = 2;
  a.attempts = 3;
  a.gaveUp = true;
  a.fingerprints.add('f');
  const b = stateFor(states, 'a', 1, folded('x', { userInputs: 1 }));
  assert.equal(b.count, 0);
  assert.equal(b.attempts, 0, 'a fresh human message restores the push budget');
  assert.equal(b.gaveUp, false, 'and re-arms the give-up notice');
  assert.equal(b.fingerprints.size, 0);
  const c = stateFor(states, 'a', 2, folded('x', { userInputs: 1 }));
  assert.equal(c.turn, 2);
});

test('nudge message: durable, identifiable, never a user source', () => {
  const message = buildNudgeMessage({ turn: 7, rule: 'protocol-missing', text: '继续。' });
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, SOURCE_KIND);
  assert.equal(message.source.form, 'notice');
  assert.equal(message.source.turn, 7);
  assert.ok(message.id.length > 0);
  assert.ok(message.content[0].text.length > 0);
});

test('fingerprint: stable per message, changes with the text', () => {
  const a = { id: 'x', stopReason: 'stop', text: 'a' };
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }));
  assert.notEqual(fingerprintOf(a), fingerprintOf({ ...a, text: 'b' }));
  assert.equal(fingerprintOf(null), undefined);
});

test('defaults: documented shape', () => {
  assert.equal(DEFAULTS.completionProtocol, true);
  assert.equal(DEFAULTS.markerStyle, 'fence-check');
  assert.equal(DEFAULTS.maxNudges, 2);
  // No total-attempts option exists: the unproductive streak is the only cap, so a turn
  // that keeps producing work can be re-opened without any ceiling.
  assert.equal(DEFAULTS.maxAttemptsPerTurn, undefined);
  assert.equal(DEFAULTS.nudgeMinIntervalMs, 5000);
  assert.equal(DEFAULTS.dryRun, false);
});
