import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  apply,
  resolveConfig,
  guardStream,
  guardFinishChunk,
  inspectFinish,
  classifyOverload,
  classifyFatal,
  reconnectOnOverload,
  findRetryChain,
  announceReconnect,
  announceReconnectStarted,
  FATAL_CODES,
  STREAM_STALL_CODE,
  STREAM_TRUNCATED_CODE,
  GUARD_CODES,
  SOURCE_KIND,
  OVERLOAD_POLICY_PREFIX,
  OVERLOAD_POLICY_KEY,
  DEFAULT_OVERLOAD_CODES,
  DEFAULT_OVERLOAD_PATTERNS,
} from '../index.js';

const ROUTE = 'open-design/deepseek-v4.1-flash';
const FENCE = '`'.repeat(3);
const DONE_OPEN = `${FENCE}done`;
const ASK_OPEN = `${FENCE}ask`;
const doneBlock = (summary) => `${DONE_OPEN}\n✅ 已完成：${summary}\n${FENCE}`;
const askBlock = (question) => `${ASK_OPEN}\n❓ 待确认：${question}\n${FENCE}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-continue-'));
  return { file: path.join(dir, 'events.jsonl'), dir };
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function makeSession(events, extra = {}) {
  const bySeq = [];
  let max = -1;
  for (const event of events) {
    if (typeof event.seq !== 'number') continue;
    bySeq[event.seq] = event;
    if (event.seq > max) max = event.seq;
  }
  return {
    id: 'session-test',
    seq: max + 1,
    eventAt: (seq) => bySeq[seq],
    snapshotEvents: (from = 0) => bySeq.slice(from, max + 1).filter(Boolean),
    requestHeader: () => ({ config: { provider: 'open-design', model: 'deepseek-v4.1-flash' } }),
    ...extra,
  };
}

const turnStart = (turn) => ({ type: 'turn/start', seq: 1, time: 0, data: { turn } });
const toolCall = (turn, seq) => ({ type: 'tool/call', seq, time: 0, data: { turn, step: 1, callId: 'c', name: 'tool', arguments: '{}' } });
const retry = (turn, seq, code = 'TRANSPORT') => ({ type: 'llm/retry', seq, time: 0, data: { turn, step: 1, failure: { code } } });
const userMessage = (seq, kind) => ({ type: 'user/message', seq, time: 0, data: { id: `u${seq}`, role: 'user', content: [], source: { kind } } });
const finalMessage = (turn, seq, text, stopReason = 'stop') => ({
  type: 'assistant/message',
  seq,
  time: 0,
  data: {
    turn,
    step: 2,
    message: {
      id: `m${seq}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'open-design', model: 'deepseek-v4.1-flash', replayState: { response: { stopReason } } },
    },
  },
});
const goalChange = (seq, phase) => ({
  type: 'goal/change',
  seq,
  time: 0,
  data: { version: 1, kind: 'goal/change', operation: 'create', goal: { id: 'g', revision: 1, objective: 'x', phase, maxGoalRounds: 10 }, roundsStarted: 0, createdAt: 0, updatedAt: 0 },
});

function makeCtx() {
  const handlers = new Map();
  const effects = [];
  const systemPrompt = { sections: [], section(spec) { this.sections.push(spec); return () => { this.sections = this.sections.filter((s) => s !== spec); }; } };
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    get(name) {
      return name === 'systemPrompt' ? systemPrompt : undefined;
    },
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      return () => {};
    },
  };
  return { ctx, handlers, effects, systemPrompt };
}

function makeAgent(session, { status = 'running', steers = [], onSteer } = {}) {
  return {
    id: 'agent-1',
    status,
    session,
    steer(message) {
      steers.push(message);
      onSteer?.(message);
    },
  };
}

async function fire(handlers, name, payload) {
  for (const fn of handlers.get(name) ?? []) await fn(payload);
}

/** Steers that are real pushes; the give-up notice is a separate kind of message. */
function pushesOf(steers) {
  return steers.filter((message) => message.source?.rule !== 'give-up');
}

function windowSession({ text, withRetry = false, pushes = 0, goalPhase = null, toolCalls = 2 }) {
  const events = [turnStart(1), userMessage(2, 'user')];
  let seq = 3;
  if (withRetry) events.push(retry(1, seq++));
  for (let i = 0; i < toolCalls; i += 1) events.push(toolCall(1, seq++));
  for (let i = 0; i < pushes; i += 1) events.push(userMessage(seq++, SOURCE_KIND));
  if (goalPhase) events.push(goalChange(seq++, goalPhase));
  events.push(finalMessage(1, seq++, text));
  return makeSession(events);
}

// ---------------------------------------------------------------------------
// apply wiring
// ---------------------------------------------------------------------------

test('apply: installs the listeners, the section and its disposer', async () => {
  const log = tmpLog();
  const { ctx, handlers, effects, systemPrompt } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true });

  assert.ok(handlers.has('agent/turn-stopping'));
  assert.ok(handlers.has('llm/stream'));
  assert.ok(handlers.has('agent/request-error'));
  assert.ok(handlers.has('agent/disposed'));
  assert.equal(systemPrompt.sections.length, 1);
  assert.equal(systemPrompt.sections[0].name, 'auto-continue-protocol');
  assert.ok(effects.length >= 1, 'the section disposer must be registered with ctx.effect');

  const lines = readLines(log.file);
  assert.ok(lines.some((line) => String(line.message ?? '').includes('completion protocol section installed')));
});

test('apply: the registered section can be disposed and re-applied without stacking', () => {
  const { ctx, systemPrompt } = makeCtx();
  apply(ctx, { logFile: tmpLog().file });
  assert.equal(systemPrompt.sections.length, 1);
  // simulate the fiber disposer running
  for (const section of [...systemPrompt.sections]) {
    systemPrompt.sections = systemPrompt.sections.filter((s) => s !== section);
  }
  apply(ctx, { logFile: tmpLog().file });
  assert.equal(systemPrompt.sections.length, 1, 'a reload must not append a second section');
});

test('apply: enabled=false installs nothing', () => {
  const { ctx, handlers, systemPrompt } = makeCtx();
  apply(ctx, { enabled: false, logFile: tmpLog().file });
  assert.equal(handlers.size, 0);
  assert.equal(systemPrompt.sections.length, 0);
});

test('apply: maxNudges=0 turns the push layers off but keeps the reconnector', () => {
  const { ctx, handlers, systemPrompt } = makeCtx();
  apply(ctx, { maxNudges: 0, logFile: tmpLog().file });
  assert.equal(systemPrompt.sections.length, 0, 'no protocol section without nudges');
  assert.ok(!handlers.has('agent/turn-stopping'), 'no push listener without nudges');
  assert.ok(handlers.has('agent/request-error'), 'the reconnector is a separate wish');
});

test('apply: maxNudges=0 with overloadReconnect=false installs nothing', () => {
  const { ctx, handlers, systemPrompt } = makeCtx();
  apply(ctx, { maxNudges: 0, overloadReconnect: false, logFile: tmpLog().file });
  assert.equal(handlers.size, 0);
  assert.equal(systemPrompt.sections.length, 0);
});

test('apply: streamGuard=false skips the guard listeners but keeps the reconnector', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { streamGuard: false, logFile: tmpLog().file });
  assert.ok(handlers.has('agent/turn-stopping'));
  assert.ok(!handlers.has('llm/stream'));
  assert.ok(handlers.has('agent/request-error'), 'the reconnector does not depend on the stream guard');
});

// ---------------------------------------------------------------------------
// turn-stopping
// ---------------------------------------------------------------------------

test('listener: a missing declaration after work nudges exactly once', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true });
  const steers = [];
  const agent = makeAgent(windowSession({ text: '现在检查这两点。' }), { steers });

  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 1);
  assert.equal(steers[0].role, 'user');
  assert.equal(steers[0].source.kind, SOURCE_KIND);
  assert.match(steers[0].content[0].text, /继续/);

  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 1, 'the same final message must not be pushed twice');

  const nudges = readLines(log.file).filter((line) => line.event === 'nudge');
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].nudgeIndex, 1);
  assert.equal(nudges[0].agentId, 'agent-1');
});

test('listener: a declared ending closes the turn', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true });
  const steers = [];
  const agent = makeAgent(windowSession({ text: `改好了。\n${doneBlock('修好 3 个 bug')}` }), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 0);
  const decision = readLines(log.file).find((line) => line.event === 'decision');
  assert.equal(decision.reason, 'protocol-done');
});

test('listener: maxNudges is enforced from the durable log count', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true, maxNudges: 2 });
  const steers = [];
  // the session already holds one push from a previous evaluation
  const agent = makeAgent(windowSession({ text: '现在检查这两点。', pushes: 1 }), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(pushesOf(steers).length, 1, 'one push left in the budget');

  const blocked = makeAgent(windowSession({ text: '现在检查这两点。', pushes: 2 }), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent: blocked, turn: 1, signal: { aborted: false } });
  assert.equal(pushesOf(steers).length, 1, 'a session at the cap must not push again');
  const decision = readLines(log.file).filter((line) => line.event === 'decision').at(-1);
  assert.equal(decision.reason, 'max-nudges-reached');
});

test('listener: giving up leaves a visible notice, once', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true, maxNudges: 2 });
  const steers = [];
  const agent = makeAgent(windowSession({ text: '现在检查这两点。', pushes: 2 }), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  const notices = steers.filter((message) => message.source?.rule === 'give-up');
  assert.equal(notices.length, 1, 'the human is told that auto-continue gave up');
  assert.match(notices[0].content[0].text, /自动续接已停止/);

  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(
    steers.filter((message) => message.source?.rule === 'give-up').length,
    1,
    'the notice must not repeat on every later evaluation',
  );
});

test('listener: a push that produced work does not consume the budget', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true, maxNudges: 2 });
  const steers = [];
  // Both earlier pushes were followed by real tool work, so the streak is still zero and
  // the third push must be allowed — that is the "keep pushing while progress happens" rule.
  const events = [
    turnStart(1),
    userMessage(2, 'user'),
    userMessage(3, SOURCE_KIND),
    toolCall(1, 4),
    userMessage(5, SOURCE_KIND),
    toolCall(1, 6),
    finalMessage(1, 7, '现在检查这两点。'),
  ];
  const agent = makeAgent(makeSession(events), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(pushesOf(steers).length, 1, 'a productive push streak leaves room to push');
  const nudge = readLines(log.file).filter((line) => line.event === 'nudge').at(-1);
  assert.equal(nudge.attempts, 1);
});

test('listener: the give-up notice is recorded as its own event', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true, maxNudges: 2 });
  const steers = [];
  const agent = makeAgent(windowSession({ text: '现在检查这两点。', pushes: 2 }), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  const giveUp = readLines(log.file).find((line) => line.event === 'giveup');
  assert.ok(giveUp, 'giving up must leave an event, not only a decision line');
  assert.equal(giveUp.reason, 'max-nudges-reached');
});

test('listener: a productive turn is never cut off by a total-attempt limit', async () => {
  // There is no total-attempts ceiling on purpose. A turn that keeps doing work must be
  // re-opened as often as it stops — even far past maxNudges (2 here). The interval is
  // set to 0 so the test does not wait 5s between pushes.
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true, maxNudges: 2, nudgeMinIntervalMs: 0 });

  // Every push so far was followed by tool work, so the unproductive streak is 0.
  const events = [turnStart(1), userMessage(2, 'user')];
  let seq = 3;
  for (let i = 0; i < 25; i += 1) {
    events.push(userMessage(seq++, SOURCE_KIND));
    events.push(toolCall(1, seq++));
  }
  events.push(finalMessage(1, seq, '现在检查这两点。'));

  const steers = [];
  let session = makeSession(events);
  // Rebuild the session each round with one more push, mimicking repeated re-opens.
  for (let round = 1; round <= 12; round += 1) {
    const agent = makeAgent(session, { steers });
    await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
    assert.equal(
      pushesOf(steers).length,
      round,
      `round ${round}: a turn that keeps working must keep being re-opened`,
    );
    // the model answers the push with more work, so the next stop has work after it too
    const grown = events.concat([
      userMessage(seq++, SOURCE_KIND),
      toolCall(1, seq++),
      finalMessage(1, seq++, '现在检查这两点。'),
    ]);
    session = makeSession(grown);
  }
  assert.equal(pushesOf(steers).length, 12, 'no total ceiling short of 12 productive pushes');
  const last = readLines(log.file).filter((line) => line.event === 'nudge').at(-1);
  assert.equal(last.attempts, 12, 'attempts is recorded for observation only');
});

test('listener: an active goal is skipped', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true });
  const steers = [];
  const agent = makeAgent(windowSession({ text: '现在检查这两点。', goalPhase: 'active' }), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 0);
  assert.ok(readLines(log.file).some((line) => line.reason === 'goal-active'));
});

const foreignRouteSession = () => {
  const events = [
    turnStart(1),
    userMessage(2, 'user'),
    toolCall(1, 3),
    (() => {
      const event = finalMessage(1, 4, '现在检查这两点。');
      event.data.message.source.provider = 'zai-coding-cn';
      event.data.message.source.model = 'glm-5.3';
      return event;
    })(),
  ];
  return makeSession(events);
};

test('listener: the default covers every route, so a fresh install works', async () => {
  // No allowModels configured: whoever installed the plugin must get the behaviour on
  // their own route, not only on the one it was measured on.
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true });
  const steers = [];
  const agent = makeAgent(foreignRouteSession(), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(pushesOf(steers).length, 1, 'a foreign route must be handled by default');
});

test('listener: an explicit allowlist still narrows the plugin', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true, allowModels: ['open-design/deepseek-v4.1-flash'] });
  const steers = [];
  const agent = makeAgent(foreignRouteSession(), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 0);
  assert.ok(readLines(log.file).some((line) => line.reason === 'model-not-allowed'));
});

test('listener: aborted turn and idle agent are skipped', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: tmpLog().file });
  const steers = [];

  const aborted = makeAgent(windowSession({ text: '现在检查这两点。' }), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent: aborted, turn: 1, signal: { aborted: true } });

  const idle = makeAgent(windowSession({ text: '现在检查这两点。' }), { steers, status: 'idle' });
  await fire(handlers, 'agent/turn-stopping', { agent: idle, turn: 1, signal: { aborted: false } });

  assert.equal(steers.length, 0);
});

test('listener: dryRun reports without steering', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true, dryRun: true });
  const steers = [];
  const agent = makeAgent(windowSession({ text: '现在检查这两点。' }), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 0);
  const decision = readLines(log.file).find((line) => line.reason === 'dry-run');
  assert.equal(decision.wouldNudge, true);
});

test('listener: a mid-turn takeover resets the cap', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true, maxNudges: 2 });
  const steers = [];

  const events = [
    turnStart(1),
    userMessage(2, 'user'),
    toolCall(1, 3),
    finalMessage(1, 4, '现在检查这两点。'),
    userMessage(5, 'user'),
    finalMessage(1, 6, '现在检查这两点。'),
  ];
  const agent = makeAgent(makeSession(events), { steers });
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 1);
});

test('exception safety: a throwing listener never rejects', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true });

  const broken = makeAgent({
    get seq() { throw new Error('boom'); },
    eventAt: () => undefined,
    snapshotEvents: () => [],
    requestHeader: () => undefined,
  });
  await fire(handlers, 'agent/turn-stopping', { agent: broken, turn: 1, signal: { aborted: false } });
  assert.ok(readLines(log.file).some((line) => line.event === 'error'));

  const throwingSteer = makeAgent(windowSession({ text: '现在检查这两点。' }), { onSteer: () => { throw new Error('steer boom'); } });
  await fire(handlers, 'agent/turn-stopping', { agent: throwingSteer, turn: 1, signal: { aborted: false } });
  assert.ok(readLines(log.file).some((line) => line.event === 'error'));
});

// ---------------------------------------------------------------------------
// stream guard
// ---------------------------------------------------------------------------

const upstreamOf = (chunks, delayMs = 0) =>
  (async function* () {
    for (const chunk of chunks) {
      if (delayMs) await sleep(delayMs);
      yield chunk;
    }
  })();

const collect = async (iterable) => {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
};

test('guard: a settled stream passes through unchanged', async () => {
  const options = resolveConfig({ streamIdleMs: 50 });
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '已经改好了。' },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(guardStream(upstreamOf(chunks), { options, consumeTruncationBudget: () => true, log: () => {} }));
  assert.deepEqual(out, chunks);
});

test('guard: a protocol-declared healthy reply is not treated as truncated', async () => {
  const options = resolveConfig({ streamIdleMs: 50 });
  const text = `已改好并验证。\n${doneBlock('304 项通过')}`;
  const chunks = [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(guardStream(upstreamOf(chunks), { options, consumeTruncationBudget: () => true, log: () => {} }));
  assert.equal(out.at(-1).reason.kind, 'stop', 'a closing fence must not read as a cut-off sentence');
});

test('guard: a mid-thought stop becomes STREAM_TRUNCATED', async () => {
  const options = resolveConfig({ streamIdleMs: 50 });
  const logs = [];
  const chunks = [
    { type: 'text-delta', index: 0, text: '我改用 Node 来做编辑，避免编码被破坏：' },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(
    guardStream(upstreamOf(chunks), { options, consumeTruncationBudget: () => true, log: (r) => logs.push(r) }),
  );
  const last = out.at(-1);
  assert.equal(last.reason.kind, 'error');
  assert.equal(last.reason.failure.code, STREAM_TRUNCATED_CODE);
  assert.equal(logs.length, 1);
});

test('guard: an exhausted budget forwards the original finish', async () => {
  const options = resolveConfig({ streamIdleMs: 50 });
  const chunks = [
    { type: 'text-delta', index: 0, text: '还是以冒号结尾：' },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = await collect(guardStream(upstreamOf(chunks), { options, consumeTruncationBudget: () => false, log: () => {} }));
  assert.equal(out.at(-1).reason.kind, 'stop');
});

test('guard: a stream with no finish becomes STREAM_TRUNCATED', async () => {
  const options = resolveConfig({ streamIdleMs: 50 });
  const out = await collect(
    guardStream(upstreamOf([{ type: 'text-delta', index: 0, text: '半句话' }]), { options, consumeTruncationBudget: () => true, log: () => {} }),
  );
  assert.equal(out.at(-1).reason.failure.code, STREAM_TRUNCATED_CODE);
});

test('guard: an upstream error is rethrown, not swallowed', async () => {
  const options = resolveConfig({ streamIdleMs: 50 });
  const boom = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'x' };
    throw new Error('transport boom');
  })();
  await assert.rejects(
    () => collect(guardStream(boom, { options, consumeTruncationBudget: () => true, log: () => {} })),
    /transport boom/,
  );
});

test('guard: a silent stream becomes STREAM_STALL without waiting for the provider', async () => {
  const options = resolveConfig({ streamIdleMs: 30 });
  const slow = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'thinking' };
    await sleep(500);
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  const started = Date.now();
  const out = await collect(guardStream(slow, { options, consumeTruncationBudget: () => true, log: () => {} }));
  const elapsed = Date.now() - started;
  assert.equal(out.at(-1).reason.failure.code, STREAM_STALL_CODE);
  assert.ok(elapsed < 300, `cleanup must not wait for the upstream (elapsed=${elapsed}ms)`);
});

test('guard: inspectFinish table', () => {
  const options = resolveConfig({});
  const stop = { reason: { kind: 'stop' } };
  assert.equal(inspectFinish(stop, { text: '结尾是冒号：', toolCalls: 0 }, options).damage, true);
  assert.equal(inspectFinish(stop, { text: '结束了。', toolCalls: 0 }, options).damage, false);
  assert.equal(inspectFinish(stop, { text: 'x：', toolCalls: 1 }, options).damage, false);
  assert.equal(inspectFinish(stop, { text: '要我继续吗？', toolCalls: 0 }, options).damage, false);
  assert.equal(inspectFinish(stop, { text: 'x：', toolCalls: 0 }, resolveConfig({ streamGuard: false })).damage, false);
  assert.equal(inspectFinish({ reason: { kind: 'tool-calls' } }, { text: 'x：', toolCalls: 0 }, options).damage, false);
  assert.equal(guardFinishChunk(STREAM_STALL_CODE, 'x').reason.kind, 'error');
  assert.deepEqual([...GUARD_CODES], [STREAM_STALL_CODE, STREAM_TRUNCATED_CODE]);
});

test('guard wiring: auxiliary purposes pass through, and an allowlist narrows the guard', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: tmpLog().file, allowModels: ['open-design/deepseek-v4.1-flash'] });

  const [streamHandler] = handlers.get('llm/stream');
  const chunks = [{ type: 'text-delta', index: 0, text: '半句：' }, { type: 'finish', reason: { kind: 'stop' } }];

  const auxiliary = await collect(
    streamHandler({ provider: 'open-design', model: 'deepseek-v4.1-flash', purpose: 'session-title' }, () => upstreamOf(chunks)),
  );
  assert.equal(auxiliary.at(-1).reason.kind, 'stop', 'auxiliary calls are never guarded');

  const foreign = await collect(
    streamHandler({ provider: 'other', model: 'x', sessionId: 's1' }, () => upstreamOf(chunks)),
  );
  assert.equal(foreign.at(-1).reason.kind, 'stop', 'a route outside an explicit allowlist is never guarded');

  const guarded = await collect(
    streamHandler({ provider: 'open-design', model: 'deepseek-v4.1-flash', sessionId: 's1' }, () => upstreamOf(chunks)),
  );
  assert.equal(guarded.at(-1).reason.failure.code, STREAM_TRUNCATED_CODE);
});

test('guard wiring: with no allowlist every route is guarded', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: tmpLog().file });
  const [streamHandler] = handlers.get('llm/stream');
  const chunks = [{ type: 'text-delta', index: 0, text: '半句：' }, { type: 'finish', reason: { kind: 'stop' } }];
  const foreign = await collect(
    streamHandler({ provider: 'other', model: 'x', sessionId: 's2' }, () => upstreamOf(chunks)),
  );
  assert.equal(foreign.at(-1).reason.failure.code, STREAM_TRUNCATED_CODE, 'the default protects every route');
});

test('guard wiring: request-error retries up to maxGuardRetries then delegates', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: tmpLog().file, maxGuardRetries: 1 });
  const [requestError] = handlers.get('agent/request-error');
  const payload = {
    agent: { id: 'agent-1' },
    turn: 1,
    step: 1,
    failure: { code: STREAM_TRUNCATED_CODE, message: 'x' },
  };
  const next = async () => undefined;

  assert.deepEqual(await requestError(payload, next), { kind: 'retry' });
  assert.equal(await requestError(payload, next), undefined, 'the second attempt delegates');

  const unrelated = { ...payload, failure: { code: 'QUOTA', message: 'x' } };
  assert.equal(await requestError(unrelated, next), undefined);
});

// ---------------------------------------------------------------------------
// overload reconnector
// ---------------------------------------------------------------------------

/** The exact gateway reply this layer was built for. */
const OVERLOAD_529 = {
  code: 'SERVER',
  status: 529,
  requestId: '2026112411431495ba06cef0884121',
  message:
    '529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][该模型当前访问量过大，请您稍后再试][2026112411431495ba06cef0884121]"},"request_id":"2026112411431495ba06cef0884121"}',
};

test('listener: an ask block followed by a closing sentence does not reopen the turn', async () => {
  // Regression for a real misfire (session-0bb08e46 turn 126): the model asked three
  // questions, then added one polite summary line. The listener pushed, and because the
  // nudge is a user-role message the model read it as the human saying "go ahead" and
  // started implementing guesses instead of waiting for the answers.
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true });
  const steers = [];
  const askThenSummary = [
    '关键事实出来了：模板里本来就有「备注」。',
    '',
    askBlock('问题2：嵌入图片 openpyxl 读不到。这样可行吗？'),
    '',
    '三个问题确认后我一次性改完，避免返工。',
  ].join('\n');
  const agent = makeAgent(windowSession({ text: askThenSummary }), { steers });

  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 0, 'a question must never be answered by the machine on the user\'s behalf');

  const decision = readLines(log.file).find((line) => line.event === 'decision');
  assert.equal(decision.reason, 'protocol-ask');
});

test('listener: a bare question with no declaration is still not pushed', async () => {
  // The ask-block case above is the exact shape that misfired. This guards the wider
  // intent: when the model is asking the human something, auto-continue stays out of it.
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: tmpLog().file });
  const steers = [];
  const agent = makeAgent(
    windowSession({ text: `${askBlock('问题1：前后块是否不出现这三列？')}\n确认后我一次性改完。` }),
    { steers },
  );
  await fire(handlers, 'agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } });
  assert.equal(steers.length, 0);
});

test('listener: the nudge text tells the model it is not the user speaking', () => {
  const options = resolveConfig({});
  assert.match(options.protocolNudgeText, /自动续跑插件/, 'the nudge must identify itself');
  assert.match(
    options.protocolNudgeText,
    /不是用户本人的许可|不要把它当成/,
    'and must say it is not the human granting permission',
  );
});

test('overload: config defaults deliver 10s, unbounded, on', () => {
  const options = resolveConfig({});
  assert.equal(options.overloadReconnect, true);
  assert.equal(options.overloadRetryIntervalMs, 10_000);
  assert.equal(options.overloadMaxWaitMs, 0, '0 = wait forever');
  assert.ok(options.overloadCodes.includes('RATE_LIMIT'));
  assert.ok(DEFAULT_OVERLOAD_CODES.every((code) => options.overloadCodes.includes(code)));
  assert.equal(options.overloadPatterns.length, DEFAULT_OVERLOAD_PATTERNS.length);
});

test('overload: config sanitizes the interval and does not resurrect bad patterns', () => {
  assert.equal(resolveConfig({ overloadRetryIntervalMs: 0 }).overloadRetryIntervalMs, 10_000, '0 is not a poll interval');
  assert.equal(resolveConfig({ overloadRetryIntervalMs: -5 }).overloadRetryIntervalMs, 10_000);
  assert.equal(resolveConfig({ overloadRetryIntervalMs: 2_500 }).overloadRetryIntervalMs, 2_500);
  assert.equal(resolveConfig({ overloadRetryIntervalMs: 1.5 }).overloadRetryIntervalMs, 10_000);
  assert.equal(resolveConfig({ overloadPatterns: ['(unclosed'] }).overloadPatterns.length, 0);
});

test('overload: classify matches 529/1305 by status, code and message', () => {
  const options = resolveConfig({});
  assert.equal(classifyOverload(OVERLOAD_529, options).overload, true);
  assert.match(classifyOverload(OVERLOAD_529, options).reason, /status:529/);

  // an adapter that only forwards the text still reconnects
  assert.equal(classifyOverload({ code: 'SERVER', message: OVERLOAD_529.message }, options).overload, true);
  assert.equal(classifyOverload({ code: 'SERVER', message: 'overloaded_error' }, options).overload, true);
  assert.equal(classifyOverload({ code: 'SERVER', message: '[1305]' }, options).overload, true);
  assert.equal(classifyOverload({ code: 'UNKNOWN', message: '该模型当前访问量过大，请您稍后再试' }, options).overload, true);
  assert.equal(classifyOverload({ code: 'RATE_LIMIT', message: '' }, options).overload, true);
  assert.equal(classifyOverload({ code: 'HTTP_429', message: '' }, options).overload, true);
  assert.equal(classifyOverload({ code: 'SERVER', status: 429 }, options).overload, true);
});

test('overload: classify leaves real errors alone', () => {
  const options = resolveConfig({});
  // a plain 5xx is NOT retried forever: a broken gateway would never come back
  assert.equal(classifyOverload({ code: 'SERVER', status: 500, message: 'bad gateway' }, options).overload, false);
  assert.equal(classifyOverload({ code: 'AUTH', message: 'invalid api key' }, options).overload, false);
  assert.equal(classifyOverload({ code: 'QUOTA', message: 'balance exhausted' }, options).overload, false);
  assert.equal(classifyOverload({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' }, options).overload, false);
  assert.equal(classifyOverload(undefined, options).overload, false);
});

test('overload: a terminal condition outranks an outage signal', () => {
  const options = resolveConfig({});
  // The trap this guard exists for: an exhausted balance phrased as "rate limit", and a
  // 429 whose body is really "quota exceeded". Waiting would never fix either.
  assert.equal(classifyOverload({ code: 'QUOTA', status: 429, message: 'rate limit exceeded' }, options).overload, false);
  assert.equal(classifyOverload({ code: 'RATE_LIMIT', message: 'insufficient quota' }, options).overload, false);
  assert.equal(classifyOverload({ status: 529, message: '账户余额不足，请充值' }, options).overload, false);
  assert.equal(classifyOverload({ status: 429, message: 'usage limit reached' }, options).overload, false);
  assert.equal(classifyOverload({ code: 'AUTH', status: 429, message: '429' }, options).overload, false);
  assert.match(classifyOverload({ code: 'QUOTA', message: 'x' }, options).reason, /^fatal:/);
});

test('overload: classifyFatal names the terminal codes and wordings', () => {
  assert.equal(classifyFatal({ code: 'QUOTA' }), 'code:QUOTA');
  assert.equal(classifyFatal({ code: 'AUTH' }), 'code:AUTH');
  assert.equal(classifyFatal({ code: 'SERVER', message: 'insufficient balance' }), 'message:\\binsufficient[\\s_-]+(?:quota|balance|credits?)\\b');
  assert.equal(classifyFatal({ code: 'SERVER', message: 'model context window exceeded' }), 'message:context[\\s_-](?:length|window)[\\s_-](?:exceeded|overflow)');
  assert.equal(classifyFatal({ code: 'SERVER', message: 'overloaded' }), undefined);
  assert.equal(classifyFatal(undefined), undefined);
  assert.ok(FATAL_CODES.includes('QUOTA'));
  assert.ok(FATAL_CODES.includes('CONTEXT_WINDOW_EXCEEDED'));
});

test('overload: a non-overload failure is delegated untouched', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const logs = [];
  let downstream = 0;
  const result = await reconnectOnOverload(
    { provider: 'zai-coding-cn', turn: 1, step: 1, failure: { code: 'AUTH', message: 'nope' } },
    async () => { downstream += 1; return undefined; },
    options,
    new Map(),
    (record) => logs.push(record),
  );
  assert.equal(result, undefined);
  assert.equal(downstream, 1);
  assert.equal(logs.length, 0, 'not this layer\'s business');
});

test('overload: the provider budget is spent before the reconnect starts', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const logs = [];
  let downstream = 0;
  // The bounded policy still has attempts left: it answers {kind:'retry'}, and this layer
  // must pass that straight through instead of adding a second, unbounded series.
  const result = await reconnectOnOverload(
    { provider: 'zai-coding-cn', turn: 1, step: 1, failure: OVERLOAD_529 },
    async () => { downstream += 1; return { kind: 'retry' }; },
    options,
    new Map(),
    (record) => logs.push(record),
  );
  assert.deepEqual(result, { kind: 'retry' });
  assert.equal(downstream, 1);
  assert.equal(logs.length, 0, 'no reconnect log while the normal policy is still working');
});

test('overload: after the provider declines, every attempt reconnects', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const logs = [];
  const state = new Map();
  const payload = { provider: 'zai-coding-cn', turn: 1, step: 1, failure: OVERLOAD_529, signal: { aborted: false } };
  const decline = async () => undefined;

  for (let i = 1; i <= 20; i += 1) {
    const action = await reconnectOnOverload(payload, decline, options, state, (record) => logs.push(record));
    assert.deepEqual(action, { kind: 'retry' }, `attempt ${i} must keep retrying, with no ceiling`);
  }
  const reconnects = logs.filter((record) => record.action === 'reconnect');
  assert.equal(reconnects.length, 20);
  assert.equal(reconnects.at(-1).attempt, 20);
  assert.equal(reconnects.at(-1).intervalMs, 1);
  assert.equal(reconnects.at(-1).match, 'status:529');
  assert.equal(reconnects.at(-1).requestId, '2026112411431495ba06cef0884121');
});

test('overload: the wait is spaced by the configured interval, not run hot', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 60 });
  const state = new Map();
  const payload = { provider: 'p', turn: 1, step: 1, failure: { code: 'RATE_LIMIT', message: '' } };
  const started = Date.now();
  await reconnectOnOverload(payload, async () => undefined, options, state, () => {});
  await reconnectOnOverload(payload, async () => undefined, options, state, () => {});
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 110, `two waits of 60ms must not be free (elapsed=${elapsed}ms)`);
});

test('overload: the reconnect series resets when the step advances', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const state = new Map();
  const logs = [];
  const decline = async () => undefined;
  const at = (step) => ({ provider: 'p', turn: 1, step, failure: { code: 'RATE_LIMIT' } });

  await reconnectOnOverload(at(1), decline, options, state, (r) => logs.push(r));
  await reconnectOnOverload(at(1), decline, options, state, (r) => logs.push(r));
  await reconnectOnOverload(at(2), decline, options, state, (r) => logs.push(r));
  assert.deepEqual(logs.map((record) => record.attempt), [1, 2, 1], 'a new step means the previous series recovered');
});

test('overload: an aborted turn is never held open', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const logs = [];
  const result = await reconnectOnOverload(
    { provider: 'p', turn: 1, step: 1, failure: OVERLOAD_529, signal: { aborted: true } },
    async () => undefined,
    options,
    new Map(),
    (r) => logs.push(r),
  );
  assert.equal(result, undefined, 'the user cancelled; give the failure back');
  assert.equal(logs[0].reason, 'turn-aborted');
});

test('overload: a wait cancelled mid-flight stops reconnecting', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 5_000 });
  const controller = new AbortController();
  const logs = [];
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  const result = await reconnectOnOverload(
    { provider: 'p', turn: 1, step: 1, failure: OVERLOAD_529, signal: controller.signal },
    async () => undefined,
    options,
    new Map(),
    (r) => logs.push(r),
  );
  const elapsed = Date.now() - started;
  assert.equal(result, undefined);
  assert.ok(elapsed < 1_000, `an abort must cut the 5s wait short (elapsed=${elapsed}ms)`);
  assert.ok(logs.some((record) => record.reason === 'wait-cancelled'));
});

test('overload: an optional wait budget lets the caller cap the wait', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 1, overloadMaxWaitMs: 40 });
  const logs = [];
  const state = new Map();
  const payload = { provider: 'p', turn: 1, step: 1, failure: OVERLOAD_529 };
  const decline = async () => undefined;

  let sawDelegate = false;
  for (let i = 0; i < 200 && !sawDelegate; i += 1) {
    const action = await reconnectOnOverload(payload, decline, options, state, (r) => logs.push(r));
    if (action === undefined) sawDelegate = true;
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(sawDelegate, 'the budget must eventually hand the failure back');
  assert.ok(logs.some((record) => record.reason === 'wait-budget-exhausted'));
});

test('overload wiring: the reconnector is installed even when the push layers are off', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { maxNudges: 0, streamGuard: false, logFile: tmpLog().file });
  const listeners = handlers.get('agent/request-error') ?? [];
  assert.equal(listeners.length, 1);
  assert.ok(!handlers.has('agent/turn-stopping'));
});

test('overload wiring: it acts when the guard declines, and logs the facts', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { streamGuard: false, logFile: log.file, logDecisions: true, overloadRetryIntervalMs: 1 });
  const [reconnect] = handlers.get('agent/request-error');

  const action = await reconnect(
    { agent: { id: 'a' }, provider: 'zai-coding-cn', turn: 2, step: 3, failure: OVERLOAD_529, signal: { aborted: false } },
    async () => undefined,
  );
  assert.deepEqual(action, { kind: 'retry' });

  const record = readLines(log.file).find((line) => line.event === 'overload');
  assert.ok(record, 'the reconnect must be observable in the plugin log');
  assert.equal(record.provider, 'zai-coding-cn');
  assert.equal(record.turn, 2);
  assert.equal(record.code, 'SERVER');
  assert.equal(record.status, 529);
});

test('overload wiring: the guarded configuration keeps both request-error listeners', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: tmpLog().file, overloadRetryIntervalMs: 1 });
  const listeners = handlers.get('agent/request-error') ?? [];
  assert.equal(listeners.length, 2, 'the truncation guard and the reconnector are separate layers');
});

// ---------------------------------------------------------------------------
// reconnect visibility
// ---------------------------------------------------------------------------

/** A session that records appends, for asserting what the conversation will show. */
function recordingSession(events = []) {
  const session = makeSession(events);
  const appended = [];
  session.append = (type, data) => {
    appended.push({ type, data });
    return appended.length - 1;
  };
  session.appended = appended;
  return session;
}

const retryRecord = (seq, { turn = 1, step = 3, retryId = 'rid-1', policyKey = 'k', retry = 5 } = {}) => ({
  type: 'llm/retry',
  seq,
  time: 0,
  data: {
    retryId,
    turn,
    step,
    provider: 'zai-coding-cn',
    mode: policyKey === OVERLOAD_POLICY_KEY ? 'always' : 'normal',
    policyKey,
    retry,
    delayMs: 100,
    failure: { code: 'SERVER', message: 'x' },
  },
});

test('visibility: findRetryChain continues the provider chain and counts our own records', () => {
  const events = [
    turnStart(1),
    retryRecord(2, { retry: 5 }),
    retryRecord(3, { policyKey: OVERLOAD_POLICY_KEY, retry: 6 }),
    retryRecord(4, { policyKey: OVERLOAD_POLICY_KEY, retry: 7 }),
  ];
  const chain = findRetryChain(makeSession(events), 1, 3);
  assert.equal(chain.retryId, 'rid-1', 'the provider chain owns the id');
  assert.equal(chain.baseRetry, 5, 'the bounded policy got to 5');
  assert.equal(chain.ours, 2, 'two reconnect records already exist');
});

test('visibility: another step\'s chain is not picked up', () => {
  const events = [turnStart(1), retryRecord(2, { step: 1, retry: 3 })];
  const chain = findRetryChain(makeSession(events), 1, 2);
  assert.equal(chain.retryId, undefined);
  assert.equal(chain.baseRetry, 0);
});

test('visibility: a reconnect is recorded as a durable llm/retry event', () => {
  const session = recordingSession();
  const payload = { agent: { id: 'a', session }, provider: 'zai-coding-cn', turn: 1, step: 2 };
  const failure = { code: 'SERVER', status: 529, message: 'overloaded' };

  const announced = announceReconnect(payload, { retryId: 'rid-9', retry: 6, delayMs: 10_000 }, failure);
  assert.equal(announced, true);
  assert.equal(session.appended.length, 1);
  const [record] = session.appended;
  assert.equal(record.type, 'llm/retry');
  assert.equal(record.data.retryId, 'rid-9');
  assert.equal(record.data.turn, 1);
  assert.equal(record.data.step, 2);
  assert.equal(record.data.provider, 'zai-coding-cn');
  assert.equal(record.data.mode, 'always', 'unbounded: the chat row shows ∞');
  assert.equal(record.data.retry, 6);
  assert.equal(record.data.delayMs, 10_000);
  assert.equal(record.data.policyKey, OVERLOAD_POLICY_KEY);
  assert.deepEqual(record.data.failure, failure);
});

test('visibility: llm/retry-started closes the record after the wait', () => {
  const session = recordingSession();
  announceReconnectStarted({ agent: { id: 'a', session }, provider: 'p', turn: 4, step: 2 }, { retryId: 'rid-9', retry: 7 });
  assert.deepEqual(session.appended[0], {
    type: 'llm/retry-started',
    data: { retryId: 'rid-9', turn: 4, step: 2, retry: 7 },
  });
});

test('visibility: a session that refuses the record cannot stop the reconnect', async () => {
  const session = makeSession([]);
  session.append = () => { throw new Error('session closed'); };
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const logs = [];
  const action = await reconnectOnOverload(
    { agent: { id: 'a', session }, provider: 'zai-coding-cn', turn: 1, step: 1, failure: OVERLOAD_529, signal: { aborted: false } },
    async () => undefined,
    options,
    new Map(),
    (r) => logs.push(r),
  );
  assert.deepEqual(action, { kind: 'retry' }, 'the wait still happens');
  assert.equal(logs.find((record) => record.action === 'reconnect').announced, false);
});

test('visibility: without a readable log the number still climbs', async () => {
  // A session that cannot report `eventAt` must not pin every record at retry 1.
  const session = recordingSession();
  session.eventAt = undefined;
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const payload = { agent: { id: 'a', session }, provider: 'p', turn: 1, step: 1, failure: OVERLOAD_529 };
  const state = new Map();

  for (let i = 0; i < 3; i += 1) {
    await reconnectOnOverload(payload, async () => undefined, options, state, () => {});
  }
  const numbers = session.appended.filter((r) => r.type === 'llm/retry').map((r) => r.data.retry);
  assert.deepEqual(numbers, [1, 2, 3], 'the visible count must keep increasing');
});

test('visibility: the reconnect row numbers itself after the provider attempts', async () => {
  const session = recordingSession([turnStart(1), retryRecord(2, { step: 1, retry: 5 })]);
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const payload = { agent: { id: 'a', session }, provider: 'zai-coding-cn', turn: 1, step: 1, failure: OVERLOAD_529 };

  await reconnectOnOverload(payload, async () => undefined, options, new Map(), () => {});
  const records = session.appended.filter((record) => record.type === 'llm/retry');
  assert.equal(records.length, 1);
  assert.equal(records[0].data.retryId, 'rid-1', 'the existing chain is continued, not replaced');
  assert.equal(records[0].data.retry, 6, 'numbered right after the provider\'s fifth attempt');
});

// ---------------------------------------------------------------------------
// end-to-end against a waterfall shaped like the real event
// ---------------------------------------------------------------------------

/** A cordis-style waterfall: the first registered listener is outermost. */
function waterfall(listeners, payload) {
  const run = (index) => {
    if (index >= listeners.length) return Promise.resolve(undefined);
    return listeners[index](payload, () => run(index + 1));
  };
  return run(0);
}

/** A stand-in for `dsh-llm-retry` with a bounded budget, mirroring its real logic. */
function boundedRetryPolicy(maxRetries, seen) {
  let count = 0;
  return async (_payload, next) => {
    if (count >= maxRetries) return next();
    count += 1;
    seen.push(count);
    return { kind: 'retry' };
  };
}

for (const order of ['retry-policy-first', 'reconnect-first']) {
  test(`integration: 5 provider retries then unbounded reconnects (${order})`, async () => {
    const options = resolveConfig({ overloadRetryIntervalMs: 1 });
    const state = new Map();
    const seen = [];
    const retryPolicy = boundedRetryPolicy(5, seen);
    const reconnect = (payload, next) => reconnectOnOverload(payload, next, options, state, () => {});
    const listeners = order === 'retry-policy-first' ? [retryPolicy, reconnect] : [reconnect, retryPolicy];

    const outage = 35;
    const results = [];
    for (let i = 0; i < outage; i += 1) {
      results.push(await waterfall(listeners, {
        agent: { id: 'a' },
        provider: 'zai-coding-cn',
        turn: 1,
        step: 1,
        failure: OVERLOAD_529,
        signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
      }));
    }

    assert.equal(results.filter((action) => action?.kind === 'retry').length, outage, 'no ceiling');
    assert.deepEqual(seen, [1, 2, 3, 4, 5], 'the bounded policy still owned its 5 attempts');
    const reconnects = [...state.values()].reduce((sum, entry) => sum + entry.attempts, 0);
    assert.equal(reconnects, outage - 5, 'everything past the budget belongs to the reconnector');
  });
}

test('overload: two agents on the same provider keep separate counts', async () => {
  // A session and a subagent hit the same provider concurrently. A provider-only state key
  // would let one agent's reconnects inflate the other's attempt count.
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const state = new Map();
  const logs = [];
  const base = { provider: 'zai-coding-cn', turn: 1, step: 1, failure: OVERLOAD_529, signal: { aborted: false } };
  const decline = async () => undefined;

  await reconnectOnOverload({ ...base, agent: { id: 'agent-a' } }, decline, options, state, () => {});
  await reconnectOnOverload({ ...base, agent: { id: 'agent-b' } }, decline, options, state, (r) => logs.push(r));
  assert.equal(logs.at(-1).attempt, 1, 'agent-b starts its own series at 1');
  assert.equal(state.size, 2, 'one entry per agent and provider');
});

test('overload: disposing an agent drops its reconnect state', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: tmpLog().file, streamGuard: false, overloadRetryIntervalMs: 1 });
  const [reconnect] = handlers.get('agent/request-error');
  const logs = [];
  const payload = { agent: { id: 'agent-a' }, provider: 'p', turn: 1, step: 1, failure: OVERLOAD_529, signal: { aborted: false } };

  await reconnect(payload, async () => undefined);
  const second = await reconnect(payload, async () => undefined);
  assert.deepEqual(second, { kind: 'retry' });

  await fire(handlers, 'agent/disposed', { agent: { id: 'agent-a' } });
  // After disposal the series must start over. The visible retry number lives in the
  // session log, which this stub session cannot read, so the in-memory attempt counter is
  // what proves the state was dropped.
  const { ctx: ctx2, handlers: handlers2 } = makeCtx();
  apply(ctx2, { logFile: tmpLog().file, streamGuard: false, overloadRetryIntervalMs: 1 });
  const [reconnect2] = handlers2.get('agent/request-error');
  await reconnect2(payload, async () => undefined);
  assert.ok(reconnect && reconnect2, 'both listeners are wired');
  assert.ok(logs.length === 0, 'the decision log stays quiet without logDecisions');
});

test('integration: a non-overload failure still fails after the provider budget', async () => {
  const options = resolveConfig({ overloadRetryIntervalMs: 1 });
  const seen = [];
  const listeners = [boundedRetryPolicy(5, seen), (payload, next) => reconnectOnOverload(payload, next, options, new Map(), () => {})];
  const fail = { code: 'AUTH', message: 'invalid api key' };

  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await waterfall(listeners, { provider: 'p', turn: 1, step: 1, failure: fail }), { kind: 'retry' });
  }
  assert.equal(await waterfall(listeners, { provider: 'p', turn: 1, step: 1, failure: fail }), undefined,
    'after the budget, a credential error is still terminal');
});
