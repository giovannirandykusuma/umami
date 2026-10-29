#!/usr/bin/env node
// Offline by default. Live mode is a separately approved, synthetic-only operation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const startAt = Date.parse('2026-01-01T00:00:00+07:00');
const timezone = 'Asia/Jakarta';
const daily = [1, 2, 3, 0, 5, 6, 7];
const definitions = [
  [
    'person-week',
    'A',
    'events',
    { distinctId: 'u_1', event: 'ui.element_clicked' },
    daily,
    0,
    6,
    'Resolve Dewi Anggraini by session-data name (not distinct ID); count her tracked ui.element_clicked events each day.',
  ],
  [
    'person-first-three',
    'A',
    'events',
    { distinctId: 'u_1', event: 'ui.element_clicked' },
    daily.slice(0, 3),
    0,
    2,
    'For Dewi Anggraini only, count tracked ui.element_clicked events for these three days.',
  ],
  [
    'person-empty-day',
    'A',
    'events',
    { distinctId: 'u_1', event: 'ui.element_clicked' },
    [0],
    3,
    3,
    'For Dewi Anggraini only, count tracked ui.element_clicked events on this empty day; do not substitute other activity.',
  ],
  [
    'other-person',
    'A',
    'events',
    { distinctId: 'u_2', event: 'login' },
    [1, 0, 0, 0, 0, 0, 0],
    0,
    6,
    'Resolve Dewi Ayu by session-data name and count her tracked login events (not proof of successful authentication).',
  ],
  [
    'event-only-pageviews',
    'A',
    'pageviews',
    {},
    [0, 0, 0, 0, 0, 0, 0],
    0,
    6,
    'Count native pageviews on this event-only site. Do not treat custom events as pageviews.',
  ],
  [
    'jakarta-boundary',
    'B',
    'pageviews',
    {},
    [1, 1],
    -1,
    0,
    'Count native pageviews over these two Jakarta calendar days; keep the midnight boundary correct.',
  ],
];
const cases = definitions.map(([id, site, metric, filters, values, first, last, task]) => {
  const range = {
    startAt: startAt + first * 86400000,
    endAt: startAt + (last + 1) * 86400000 - 1000,
  };
  const series = {
    metric,
    unit: 'day',
    range,
    timezone,
    appliedFilters: filters,
    buckets: values.map((y, i) => ({
      t: `${new Date(startAt + (first + i) * 86400000 + 7 * 3600000).toISOString().slice(0, 10)}T00:00:00+07:00`,
      y,
    })),
    total: values.reduce((a, b) => a + b, 0),
  };
  return { id, site, task, series };
});
const fixtureHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
const same = (a, b) => {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

function validate(test, message) {
  const reasons = [];
  if (
    message?.role !== 'assistant' ||
    message.status !== 'done' ||
    !Array.isArray(message.parts) ||
    message.parts.some(p => !p || typeof p !== 'object')
  )
    return { id: test.id, pass: false, reasons: ['malformed or unfinished assistant message'] };
  const text = message.parts
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('\n');
  // A deliberate final-answer marker avoids accidental matches in dates/tool dumps.
  const totals = [...text.matchAll(/TOTAL\s*:\s*(\d+(?:\.\d+)?)(?![\d.])/g)].map(m => Number(m[1]));
  if (totals.length !== 1 || totals[0] !== test.series.total)
    reasons.push('incorrect or missing text TOTAL');
  const charts = message.parts.filter(p => p.type === 'result-chart');
  if (charts.length !== 1) reasons.push('expected exactly one result-chart');
  else {
    const chart = charts[0],
      series = chart.series;
    if (
      !['line', 'bar', 'table'].includes(chart.kind) ||
      !series ||
      typeof series.label !== 'string' ||
      !series.label
    )
      reasons.push('malformed result-chart');
    for (const key of Object.keys(test.series))
      if (!same(series?.[key], test.series[key])) reasons.push(`chart ${key} mismatch`);
    if (
      !Array.isArray(series?.buckets) ||
      series.buckets.some(b => !b || !Number.isFinite(b.y)) ||
      series.buckets.reduce((sum, b) => sum + b.y, 0) !== series.total
    )
      reasons.push('bucket sum differs from chart total');
    if (Buffer.byteLength(JSON.stringify(chart)) > 8192)
      reasons.push('chart exceeds protocol size');
  }
  return { id: test.id, pass: reasons.length === 0, reasons };
}
function grade(messages) {
  assert.ok(
    Array.isArray(messages) && messages.length === cases.length,
    'exactly six messages required',
  );
  const results = cases.map((test, i) => validate(test, messages[i]));
  return {
    results,
    passed: results.filter(r => r.pass).length,
    count: cases.length,
    rate: results.filter(r => r.pass).length / cases.length,
  };
}
function exampleMessages() {
  return cases.map(test => ({
    role: 'assistant',
    status: 'done',
    parts: [
      { type: 'text', text: `TOTAL: ${test.series.total}` },
      {
        type: 'result-chart',
        kind: 'line',
        series: { label: test.id, ...structuredClone(test.series) },
      },
    ],
  }));
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const args = process.argv.slice(2);
const mode = args.shift() || '--plan';
let report;
if (mode === '--plan') {
  assert.equal(args.length, 0);
  report = {
    mode: 'plan',
    fixtureHash,
    baseline: { status: 'not_run', rate: null },
    candidate: { status: 'not_run', rate: null },
    cases,
    live: 'DEFERRED: Randy has not approved model spend',
  };
} else if (mode === '--self-test') {
  assert.equal(args.length, 0);
  assert.equal(grade(exampleMessages()).passed, 6);
  let rejected = 0;
  for (const mutate of [
    m => {
      m[0].parts[0].text = 'TOTAL: 25';
    },
    m => {
      m[0].parts[1].series.total = 25;
    },
    m => {
      m[0].parts[1].series.buckets[0].y = 2;
    },
    m => {
      m[0].parts[1].series.appliedFilters = {};
    },
    m => {
      m[0].parts[1].series.timezone = 'UTC';
    },
    m => {
      m[0].parts[1].series.buckets = null;
    },
    m => {
      m[0].parts[1].type = 'chart';
    },
    m => {
      m[0].status = 'error';
    },
    m => {
      m[0] = null;
    },
  ]) {
    const messages = exampleMessages();
    mutate(messages);
    assert.equal(grade(messages).passed, 5);
    rejected++;
  }
  assert.throws(() => grade([]));
  report = {
    mode: 'self-test',
    syntheticOnly: true,
    passed: 6,
    negativeControlsRejected: rejected,
    liveRates: 'not_run',
  };
} else if (mode === '--offline') {
  assert.equal(args.length, 1, '--offline transcript.json');
  report = {
    mode: 'offline',
    fixtureHash,
    ...grade((await json(args[0])).messages),
    liveRates: 'not_run',
  };
} else if (mode === '--compare') {
  assert.equal(args.length, 2, '--compare baseline.json candidate.json');
  const [baseline, candidate] = await Promise.all(args.map(json));
  for (const [r, label] of [
    [baseline, 'baseline'],
    [candidate, 'candidate'],
  ]) {
    assert.equal(r.mode, 'live');
    assert.equal(r.label, label);
    assert.ok(r.revision && r.model && r.seedReceipt);
    assert.equal(r.fixtureHash, fixtureHash);
    assert.deepEqual(r.score, grade(r.messages), 'report score must match transcript');
  }
  assert.equal(baseline.model, candidate.model);
  assert.equal(baseline.seedReceipt, candidate.seedReceipt);
  report = {
    mode: 'comparison',
    fixtureHash,
    model: baseline.model,
    baseline: { revision: baseline.revision, ...baseline.score },
    candidate: { revision: candidate.revision, ...candidate.score },
    delta: candidate.score.rate - baseline.score.rate,
  };
} else if (mode === '--live') {
  // Check approval BEFORE any fetch, including local API requests that could invoke a model.
  assert.equal(
    process.env.AI_ANALYTICS_APPROVE_SPEND,
    'Randy-approved-synthetic-only',
    'live spend is not approved',
  );
  assert.equal(args.length, 3, '--live config.json baseline|candidate output.json');
  const [path, label, output] = args;
  assert.ok(['baseline', 'candidate'].includes(label));
  const config = await json(path);
  assert.equal(config.syntheticOnly, true);
  assert.equal(config.fixtureHash, fixtureHash);
  for (const key of ['model', 'revision', 'seedReceipt'])
    assert.ok(typeof config[key] === 'string' && config[key]);
  const origin = new URL(config.origin);
  assert.ok(
    origin.protocol === 'http:' &&
      origin.hostname === '127.0.0.1' &&
      origin.port &&
      origin.pathname === '/' &&
      !origin.search &&
      !origin.hash &&
      !origin.username &&
      !origin.password,
    'only an isolated loopback synthetic app is allowed',
  );
  const auth = process.env.AI_ANALYTICS_SYNTHETIC_TOKEN;
  assert.ok(auth, 'synthetic non-admin session token required');
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${origin.origin}/api${path}`, {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(300000),
    });
    assert.ok(response.ok, `synthetic API status ${response.status}`);
    return response;
  };
  for (const site of ['A', 'B']) {
    assert.match(config.sites?.[site] || '', /^[a-f0-9-]{36}$/i);
    const website = await (await request(`/websites/${config.sites[site]}`)).json();
    assert.equal(website.domain, 'synthetic.invalid', 'refuse non-synthetic site');
  }
  const messages = [];
  for (const test of cases) {
    const chat = await (
      await request('/ai/assistant/chats', 'POST', { title: `Synthetic eval ${test.id}` })
    ).json();
    assert.ok(chat.id);
    try {
      const message = `${test.task} Website ID: ${config.sites[test.site]}. Inclusive range in Unix milliseconds: ${test.series.range.startAt} through ${test.series.range.endAt}. Timezone: ${timezone}; daily buckets. Show exactly one result-chart of that same query. State the final total exactly once as TOTAL: <number>. Do not create or modify boards, reports or data.`;
      const response = await request(`/ai/assistant/chats/${chat.id}/turn`, 'POST', {
        message,
        context: { websiteId: config.sites[test.site], ...test.series.range, timezone },
      });
      const stream = await response.text();
      const terminals = stream
        .replaceAll('\r\n', '\n')
        .split('\n\n')
        .flatMap(frame => {
          const type = frame.match(/^event: (done|error)$/m)?.[1];
          const data = frame.match(/^data: (.*)$/m)?.[1];
          return type && data ? [{ type, ...JSON.parse(data) }] : [];
        });
      assert.equal(terminals.length, 1, 'exactly one terminal event required');
      messages.push(terminals[0].message ?? { role: 'assistant', status: 'error', parts: [] });
    } finally {
      await request(`/ai/assistant/chats/${chat.id}`, 'DELETE');
    }
  }
  report = {
    mode: 'live',
    label,
    fixtureHash,
    model: config.model,
    revision: config.revision,
    seedReceipt: config.seedReceipt,
    createdAt: new Date().toISOString(),
    score: grade(messages),
    messages,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
} else {
  throw new Error('Use --plan, --self-test, --offline, --compare or --live');
}
console.log(JSON.stringify(report, null, 2));
if (report.mode === 'offline' && report.passed !== 6) process.exitCode = 1;
