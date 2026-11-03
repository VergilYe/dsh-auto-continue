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
  STREAM_STALL_CODE,
  STREAM_TRUNCATED_CODE,
  GUARD_CODES,
  SOURCE_KIND,
} from '../index.js';

const ROUTE = 'open-design/deepseek-v4.1-flash';
const FENCE = '`'.repeat(3);
const DONE_OPEN = `${FENCE}done`;
const doneBlock = (summary) => `${DONE_OPEN}\n✅ 已完成：${summary}\n${FENCE}`;
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

test('apply: maxNudges=0 behaves like not installed', () => {
  const { ctx, handlers, systemPrompt } = makeCtx();
  apply(ctx, { maxNudges: 0, logFile: tmpLog().file });
  assert.equal(handlers.size, 0);
  assert.equal(systemPrompt.sections.length, 0);
});

test('apply: streamGuard=false skips the guard listeners', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { streamGuard: false, logFile: tmpLog().file });
  assert.ok(handlers.has('agent/turn-stopping'));
  assert.ok(!handlers.has('llm/stream'));
  assert.ok(!handlers.has('agent/request-error'));
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

test('listener: a non-allowlisted route is skipped', async () => {
  const log = tmpLog();
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: log.file, logDecisions: true });
  const steers = [];
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
  const agent = makeAgent(makeSession(events), { steers });
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

test('guard wiring: auxiliary purposes and foreign routes pass through unguarded', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { logFile: tmpLog().file });

  const [streamHandler] = handlers.get('llm/stream');
  const chunks = [{ type: 'text-delta', index: 0, text: '半句：' }, { type: 'finish', reason: { kind: 'stop' } }];

  const auxiliary = await collect(
    streamHandler({ provider: 'open-design', model: 'deepseek-v4.1-flash', purpose: 'session-title' }, () => upstreamOf(chunks)),
  );
  assert.equal(auxiliary.at(-1).reason.kind, 'stop', 'auxiliary calls are never guarded');

  const foreign = await collect(
    streamHandler({ provider: 'other', model: 'x', sessionId: 's1' }, () => upstreamOf(chunks)),
  );
  assert.equal(foreign.at(-1).reason.kind, 'stop', 'foreign routes are never guarded');

  const guarded = await collect(
    streamHandler({ provider: 'open-design', model: 'deepseek-v4.1-flash', sessionId: 's1' }, () => upstreamOf(chunks)),
  );
  assert.equal(guarded.at(-1).reason.failure.code, STREAM_TRUNCATED_CODE);
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
