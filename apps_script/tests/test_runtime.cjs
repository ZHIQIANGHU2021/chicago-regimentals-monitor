/* Service-adapter tests: Google APIs are in-memory mocks; no HTTP or email. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const importUrl = 'https://raw.githubusercontent.com/ZHIQIANGHU2021/chicago-regimentals-monitor/main/state.json';
const isImport = url => url === importUrl || /^\d+$/.test(url.slice(importUrl.length + 14)) && url.startsWith(importUrl + '?monitor_sync=');
const pointerKey = 'regimentals.monitor.pointer';

function product(sku, verified = false) {
  return {sku: String(sku), title: sku === 10397 ? 'Vz.37 重機関銃' : 'New display collectible',
    url: `https://www.regimentals.jp/shop/g/g${sku}/`, price_jpy: 550000, branch: '東京店',
    status: 'お客様ご連絡中', release_date: verified ? '2026-11-04' : null,
    eligible: verified, reason: verified ? 'verified' : 'detail_not_checked', category: '無可動実銃'};
}

function environment() {
  const env = {clock: Date.parse('2026-11-06T00:00:00Z'), props: Object.create(null), emails: [],
    requests: [], batches: [], triggers: [], logs: [], quota: 100, writes: 0, propertyReads: 0,
    failWrite: null, failPage: null, rawImport: null, locked: false, mailThrows: false, uuid: 0};
  const products = [product(10398), product(10397)];
  for (let i = 0; i < 58; i++) products.push(product(10000 + i));
  env.products = products;
  env.details = {'10398': product(10398, true)};
  const seen = {'10396': '2026-11-03T03:26:51+00:00'};
  products.filter(p => p.sku !== '10398').forEach(p => { seen[p.sku] = '2026-11-03T03:26:51+00:00'; });
  env.legacy = {version: 1, initialized: true, baseline_at: '2026-11-03T03:26:51+00:00',
    baseline_max_sku: 10396, seen, pending: {}, outbox: {},
    notified: {'10397': {issue_url: 'https://github.com/ZHIQIANGHU2021/chicago-regimentals-monitor/issues/3',
      notified_at: '2026-11-05T03:00:00+00:00'}}, last_success_heartbeat: '2026-11-05T03:00:00+00:00'};

  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [env.clock])); }
    static now() { return env.clock; }
  }
  function response(text, status = 200, type = 'text/html; charset=utf-8') {
    return {getResponseCode: () => status, getHeaders: () => ({'Content-Type': type}),
      getContentText: () => text};
  }
  function serve(url) {
    if (isImport(url)) return response(env.rawImport === null ? JSON.stringify(env.legacy) : env.rawImport, 200, 'text/plain');
    const category = url.match(/\/c10_srd(?:_p(\d+))?\/$/);
    if (category) {
      const page = Number(category[1] || 1);
      return response(JSON.stringify({kind: 'category', page}), env.failPage === page ? 503 : 200);
    }
    const detail = url.match(/\/g(\d+)\/$/);
    if (detail) return response(JSON.stringify({kind: 'detail', sku: detail[1]}));
    throw new Error('Unexpected mock URL ' + url);
  }
  const properties = {
    getProperty(key) { env.propertyReads++; return Object.hasOwn(env.props, key) ? env.props[key] : null; },
    getProperties() { env.propertyReads++; return {...env.props}; },
    setProperty(key, value) {
      env.writes++;
      if (env.failWrite && env.failWrite(key, String(value))) throw new Error('injected property failure');
      env.props[key] = String(value); return this;
    },
    deleteProperty(key) { delete env.props[key]; return this; }
  };
  const context = vm.createContext({Date: Clock, console: {
    log(value) { env.logs.push(String(value)); }, warn(value) { env.logs.push(String(value)); },
    error(value) { env.logs.push(String(value)); }
  }, PropertiesService: {getScriptProperties: () => properties},
  Utilities: {
    Charset: {UTF_8: 'UTF-8'}, DigestAlgorithm: {SHA_256: 'SHA-256'},
    computeDigest(_, value) { return Array.from(crypto.createHash('sha256').update(value).digest()); },
    base64Encode(value) { return Buffer.from(value, 'utf8').toString('base64'); },
    base64Decode(value) { return Array.from(Buffer.from(value, 'base64')); },
    newBlob(value) { const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      return {getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8')}; },
    getUuid() { return `mock-uuid-${++env.uuid}`; }
  }, UrlFetchApp: {
    fetch(url, options) { env.requests.push({url, options: copy(options)}); env.clock += 100; return serve(url); },
    fetchAll(requests) { env.batches.push(copy(requests)); env.clock += 120; return requests.map(r => serve(r.url)); }
  }, MailApp: {
    getRemainingDailyQuota: () => env.quota,
    sendEmail(message) { env.emails.push(copy(message)); env.quota--; if (env.mailThrows) throw new Error('mail outcome unknown'); }
  }, LockService: {getScriptLock: () => ({
    tryLock() { if (env.locked) return false; env.locked = true; return true; },
    releaseLock() { env.locked = false; }
  })}, ScriptApp: {
    getProjectTriggers: () => env.triggers,
    newTrigger(handler) { const builder = {timeBased() { return builder; }, everyMinutes(n) {
      assert.equal(n, 5); return builder; }, create() { const trigger = {getHandlerFunction: () => handler};
      env.triggers.push(trigger); return trigger; }}; return builder; }
  }, RegimentalsSite: {
    categoryUrl(page = 1) { return `https://www.regimentals.jp/shop/c/c10_srd${page === 1 ? '' : '_p' + page}/`; },
    parseCategory(text, page) { assert.equal(JSON.parse(text).page, page);
      return {products: copy(env.products.slice((page - 1) * 20, page * 20)), total_count: 60, total_pages: 3, current_page: page}; },
    parseDetail(text, listing) { const sku = JSON.parse(text).sku; assert.equal(sku, listing.sku);
      return copy(env.details[sku]); }
  }});
  vm.runInContext(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'), context, {filename: 'engine.js'});
  vm.runInContext(fs.readFileSync(path.join(root, 'runtime.js'), 'utf8'), context, {filename: 'runtime.js'});
  context.REGIMENTALS_MONITOR_CFG.recipient = 'monitor-test@example.test';
  env.ctx = context;
  env.runtime = context.RegimentalsRuntime;
  env.setup = () => context.setupAndStartMonitor();
  env.timer = () => { env.clock += 300000; return context.runFiveMinuteMonitor({triggerUid: 'actual-mock-timer'}); };
  env.activate = () => context.activateProductionMonitor();
  env.load = () => copy(env.runtime.load_());
  return env;
}

test('setup imports the baseline, scans all three pages, queues in shadow, tests once and creates one timer', () => {
  const e = environment(), info = e.setup();
  assert.equal(info.mode, 'SHADOW');
  assert.equal(info.last_run.pages, 3);
  assert.equal(info.last_run.itemcount, 60);
  assert.equal(info.last_run.details, 1);
  assert.equal(info.last_run.source, 'manual');
  assert.ok(e.load().outbox['10398']);
  assert.ok(e.load().notified['10397']);
  assert.equal(e.emails.length, 1);
  assert.match(e.emails[0].subject, /部署测试/);
  assert.match(e.emails[0].body, /不是新品通知/);
  assert.equal(e.triggers.length, 1);
  e.setup();
  assert.equal(e.emails.length, 1, 'repeated setup does not resend the test');
  assert.equal(e.triggers.length, 1, 'repeated setup does not duplicate timers');
  assert.equal(e.requests.filter(r => isImport(r.url)).length, 1, 'legacy state is not fetched every round');
  assert.ok(e.batches.some(batch => batch.length === 2 && batch.every(r => /c10_srd_p[23]/.test(r.url))));
  for (const req of e.requests.concat(e.batches.flat().map(r => ({options: r})))) {
    assert.equal(req.options.followRedirects, false);
    assert.equal(req.options.validateHttpsCertificates, true);
    assert.equal(req.options.timeoutSeconds, 12);
  }
});

test('manual checks do not count as three natural runs; timer history reports measured gaps and runtime', () => {
  const e = environment(); e.setup();
  for (let i = 0; i < 3; i++) e.ctx.runFiveMinuteMonitor();
  assert.throws(e.activate, /three natural shadow runs/);
  for (let i = 0; i < 3; i++) e.timer();
  const info = e.ctx.printMonitorHealth();
  assert.equal(info.timer_runs, 3);
  assert.ok(info.median_gap_seconds >= 300 && info.median_gap_seconds < 301);
  assert.ok(info.max_gap_seconds >= 300 && info.max_gap_seconds < 301);
  assert.ok(info.projected_trigger_minutes_per_day < 90);
  assert.equal(info.monitor_trigger_count, 1);
  assert.equal(info.last_run.source, 'timer');
  assert.equal(e.emails.length, 1, 'natural shadow runs send no product email');
});

test('activation imports latest notified SKUs, removes matching outbox and retains the original baseline', () => {
  const e = environment(); e.setup();
  for (let i = 0; i < 3; i++) e.timer();
  const before = e.load();
  e.legacy.notified['10398'] = {issue_url: 'https://github.com/owner/monitor/issues/4', notified_at: '2026-11-06T00:01:00Z'};
  const info = e.activate(), after = e.load();
  assert.equal(info.mode, 'PRODUCTION');
  assert.equal(after.baseline_at, before.baseline_at);
  assert.equal(after.baseline_max_sku, before.baseline_max_sku);
  assert.ok(after.seen['10398']);
  assert.ok(after.notified['10397']);
  assert.ok(after.notified['10398']);
  assert.equal(after.outbox['10398'], undefined);
  e.timer();
  assert.equal(e.emails.length, 1, 'cutover does not duplicate either legacy notification');
  const imports = e.requests.filter(r => isImport(r.url));
  assert.equal(imports.length, 2, 'imports only at setup and activation');
  assert.notEqual(imports[0].url, imports[1].url, 'cutover uses a fresh fixed-origin cache key');
});

test('production marks accepted product mail and never sends that SKU again', () => {
  const e = environment(); e.setup();
  for (let i = 0; i < 3; i++) e.timer();
  e.activate(); e.timer();
  const after = e.load();
  assert.equal(e.emails.length, 2);
  assert.match(e.emails[1].subject, /10398/);
  assert.equal(after.outbox['10398'], undefined);
  assert.equal(after.notified['10398'].receipt.channel, 'MailApp');
  e.timer(); assert.equal(e.emails.length, 2);
});

test('ambiguous MailApp outcome persists sending and stops automatic resends', () => {
  const e = environment(); e.setup();
  for (let i = 0; i < 3; i++) e.timer();
  e.activate(); e.mailThrows = true;
  assert.throws(e.timer, /mail outcome unknown/);
  assert.equal(e.load().outbox['10398'].delivery_status, 'sending');
  assert.equal(e.emails.length, 2);
  e.mailThrows = false;
  assert.throws(e.timer, /outcome uncertain for SKU 10398/);
  assert.equal(e.emails.length, 2);
  assert.equal(e.load().runtime.history.at(-1).status, 'failure');
});

test('insufficient quota retains an untouched unsent outbox', () => {
  const e = environment(); e.setup();
  for (let i = 0; i < 3; i++) e.timer();
  e.activate(); e.quota = 0;
  assert.throws(e.timer, /quota insufficient/);
  assert.equal(e.load().outbox['10398'].delivery_status, undefined);
  assert.equal(e.emails.length, 1);
});

test('a failed category page records failure without committing partial observations or sending mail', () => {
  const e = environment(); e.setup();
  const before = e.load();
  e.products[1] = product(10399);
  e.failPage = 3;
  assert.throws(e.timer, /HTTP 503/);
  const after = e.load();
  assert.deepEqual(after.seen, before.seen);
  assert.deepEqual(after.outbox, before.outbox);
  assert.deepEqual(after.pending, before.pending);
  assert.equal(after.runtime.history.at(-1).status, 'failure');
  assert.equal(after.runtime.history.at(-1).source, 'timer');
  assert.equal(e.emails.length, 1);
});

test('a failed detail batch cannot commit earlier candidates from the same scan', () => {
  const e = environment(); e.setup();
  const before = e.load();
  e.products[1] = product(10399);
  delete e.details['10399'];
  assert.throws(e.timer);
  const after = e.load();
  assert.deepEqual(after.seen, before.seen);
  assert.deepEqual(after.outbox, before.outbox);
  assert.equal(after.runtime.history.at(-1).status, 'failure');
});

test('chunk write failure leaves the old committed pointer and state intact', () => {
  const e = environment(); e.setup();
  const previous = e.load(), oldPointer = e.props[pointerKey], changed = copy(previous);
  changed.runtime.largeTestValue = '改'.repeat(15000);
  e.failWrite = key => /\.g\.[^.]+\.1$/.test(key);
  assert.throws(() => e.runtime.save_(changed), /injected property failure/);
  assert.equal(e.props[pointerKey], oldPointer);
  assert.deepEqual(e.load(), previous);
  e.failWrite = null;
  e.runtime.save_(changed); e.runtime.save_(previous);
  const generations = new Set(Object.keys(e.props).filter(k => k.includes('.g.')).map(k => k.split('.g.')[1].split('.')[0]));
  assert.equal(generations.size, 2);
  assert.ok(Object.values(e.props).every(value => Buffer.byteLength(value, 'utf8') <= 9000));
  assert.ok(Object.entries(e.props).reduce((n, [k, v]) => n + k.length + v.length, 0) < 500000);
});

test('corrupt current generation refuses a stale fallback or another public import', () => {
  const e = environment(); e.setup();
  const ptr = JSON.parse(e.props[pointerKey]);
  e.props[`regimentals.monitor.g.${ptr.current}.0`] = 'corrupt';
  const imports = e.requests.filter(r => isImport(r.url)).length;
  assert.throws(e.timer, /incomplete or corrupt/);
  assert.equal(e.requests.filter(r => isImport(r.url)).length, imports);
  assert.equal(e.emails.length, 1);
});

test('a test mail crash is persisted as uncertain and repeated setup cannot resend it', () => {
  const e = environment(); e.mailThrows = true;
  assert.throws(e.setup, /mail outcome unknown/);
  assert.equal(e.load().runtime.deployment_tests['google-monitor-v1'].status, 'sending');
  e.mailThrows = false;
  assert.throws(e.setup, /deployment test mail outcome uncertain/);
  assert.equal(e.emails.length, 1);
  assert.equal(e.triggers.length, 0);
});

test('new unverifiable candidate fails visibly once per SKU/reason while preserving manual review', () => {
  const e = environment(); e.setup();
  e.products[1] = product(10399);
  e.details['10399'] = {...product(10399), eligible: false, reason: 'missing_release_date'};
  assert.throws(e.timer, /10399 \(missing_release_date\)/);
  const held = e.load();
  assert.equal(held.pending['10399'].reason, 'missing_release_date');
  assert.equal(held.runtime.history.at(-1).status, 'verification_hold');
  e.timer();
  assert.equal(e.load().pending['10399'].reason, 'missing_release_date');
  assert.equal(e.emails.length, 1);
});

test('invalid or oversized public state never initializes, sends mail or installs a timer', () => {
  for (const invalid of [JSON.stringify({...environment().legacy, initialized: false}), 'x'.repeat(100001)]) {
    const e = environment(); e.rawImport = invalid;
    assert.throws(e.setup);
    assert.equal(e.props[pointerKey], undefined);
    assert.equal(e.emails.length, 0);
    assert.equal(e.triggers.length, 0);
  }
});

test('more than one timer or a held lock fails before making source requests', () => {
  const e = environment(); e.setup();
  e.triggers.push({getHandlerFunction: () => 'runFiveMinuteMonitor'});
  const count = e.requests.length;
  assert.throws(e.timer, /multiple monitor triggers/);
  assert.equal(e.requests.length, count);
  e.triggers.pop(); e.locked = true;
  assert.throws(e.timer, /another monitoring run is active/);
  assert.equal(e.requests.length, count);
});

test('imported runtime flags cannot silently turn initial shadow setup into production', () => {
  const e = environment(); e.legacy.runtime = {shadow_mode: false, deployment_tests: {'google-monitor-v1': {status: 'sent'}}};
  e.setup();
  assert.equal(e.load().runtime.shadow_mode, true);
  assert.equal(e.emails.length, 1);
});

test('activation rejects stale, interrupted or irregular natural verification and excessive measured runtime', () => {
  const stale = environment(); stale.setup();
  for (let i = 0; i < 3; i++) stale.timer();
  stale.clock += 601000;
  assert.throws(stale.activate, /verification is stale/);

  const interrupted = environment(); interrupted.setup();
  for (let i = 0; i < 3; i++) interrupted.timer();
  interrupted.failPage = 2;
  assert.throws(interrupted.timer, /HTTP 503/);
  assert.throws(interrupted.activate, /consecutively/);

  const irregular = environment(); irregular.setup();
  for (let i = 0; i < 3; i++) { irregular.clock += 300000; irregular.timer(); }
  assert.throws(irregular.activate, /five-minute cadence/);

  const expensive = environment(); expensive.setup();
  for (let i = 0; i < 3; i++) expensive.timer();
  const state = expensive.load();
  state.runtime.history.filter(run => run.source === 'timer').forEach(run => { run.elapsedMs = 16000; });
  expensive.runtime.save_(state);
  assert.throws(expensive.activate, /daily trigger quota/);
});

test('cutover preserves both queues and review records, and legacy seen cannot swallow unnotified new SKUs', () => {
  const e = environment(); e.setup();
  for (let i = 0; i < 3; i++) e.timer();
  const originalFirstSeen = e.load().seen['10398'];
  e.legacy.outbox['10400'] = product(10400, true);
  e.legacy.pending['10401'] = {product: product(10401), reason: 'missing_release_date', first_seen: '2026-11-06T00:00:00Z'};
  e.legacy.seen['10400'] = e.legacy.seen['10401'] = e.legacy.seen['10402'] = '2026-11-06T00:00:00Z';
  e.activate();
  const after = e.load();
  assert.ok(after.outbox['10398'], 'Google-owned queued candidate survives');
  assert.ok(after.outbox['10400'], 'legacy queued candidate is imported');
  assert.equal(after.pending['10401'].reason, 'missing_release_date');
  assert.equal(after.pending['10402'].reason, 'migration_seen_requires_recheck');
  assert.equal(after.baseline_max_sku, 10396);
  assert.equal(after.seen['10398'], originalFirstSeen);
});
