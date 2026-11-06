'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8'), context);
const engine = context.RegimentalsEngine;
const plain = (value) => JSON.parse(JSON.stringify(value));
const NOW = '2026-11-05T01:00:00Z';
function state() {
  return {version: 1, initialized: true,
    baseline_at: '2026-11-03T03:26:51+00:00', baseline_max_sku: 10396,
    seen: {'10000': '2026-11-03T03:26:51+00:00'},
    pending: {}, outbox: {}, notified: {},
    last_success_heartbeat: '2026-11-05T00:00:00Z'};
}
function product(sku = '10397', fields = {}) {
  return Object.assign({sku, title: 'Vz.37 重機関銃 #1436',
    url: 'https://www.regimentals.jp/shop/g/g' + sku + '/',
    price_jpy: 880000, branch: '東京店', status: '在庫あり',
    release_date: '2026-11-04', eligible: true,
    reason: 'verified', category: '無可動実銃'}, fields);
}
function scan(original, listing, detail, now = NOW) {
  return plain(engine.scanState(original, listing, detail, now));
}

test('imported notified Vz37 remains permanently deduplicated', () => {
  const original = state();
  original.seen['10397'] = '2026-11-04T11:13:25+00:00';
  original.notified['10397'] = {issue_url: 'https://github.com/a/b/issues/7', notified_at: NOW};
  assert.deepEqual(plain(engine.candidateSkus(original, [product()])), []);
  const result = scan(original, [product()], {});
  assert.deepEqual(result.notified, original.notified);
  assert.deepEqual(result.outbox, {});
});

test('existing seen+pending 10397 recovers from date-only fix exactly once', () => {
  const original = state();
  const firstSeen = '2026-11-04T11:13:25+00:00';
  const held = product('10397', {release_date: null, eligible: false, reason: 'missing_release_date'});
  original.seen['10397'] = firstSeen;
  original.pending['10397'] = {first_seen: firstSeen, reason: 'missing_release_date', product: held};
  original.notified['10001'] = {issue_url: 'https://github.com/a/b/issues/3'};
  const saved = plain(original);
  assert.deepEqual(plain(engine.candidateSkus(original, [held])), ['10397']);
  const result = scan(original, [held], {'10397': product()});
  assert.deepEqual(Object.keys(result.outbox), ['10397']);
  assert.equal(result.outbox['10397'].first_seen, firstSeen);
  assert.equal(result.seen['10397'], firstSeen);
  assert.deepEqual(result.pending, {});
  assert.deepEqual(result.notified, original.notified);
  assert.equal(result.baseline_at, original.baseline_at);
  assert.equal(result.baseline_max_sku, 10396);
  assert.deepEqual(scan(result, [product()], {}, NOW), result);
  assert.deepEqual(original, saved);
});

test('all imported prebaseline stock stays quiet despite new dates and prices', () => {
  const original = state();
  original.seen['10398'] = original.baseline_at;
  const listed = product('10398', {release_date: '2026-11-05', price_jpy: 999999});
  assert.deepEqual(plain(engine.candidateSkus(original, [listed])), []);
  assert.deepEqual(scan(original, [listed], {}).outbox, {});
});

test('unseen low catalogue IDs remain held without automatic notification', () => {
  const original = state();
  const listed = product('2445');
  assert.deepEqual(plain(engine.candidateSkus(original, [listed])), []);
  const result = scan(original, [listed], {});
  assert.equal(result.pending['2445'].reason, 'old_sku_needs_official_new_arrival_evidence');
  assert.equal(result.pending['2445'].first_seen, NOW);
  const later = scan(result, [listed], {}, '2026-11-05T01:05:00Z');
  assert.equal(later.pending['2445'].first_seen, NOW);
  assert.deepEqual(later.outbox, {});
});

test('date-only and full official ISO datetimes both qualify', () => {
  for (const release of ['2026-11-04', '2026-11-04T19:15:00', '2026-11-04T19:15:00+09:00']) {
    const item = product('10397', {release_date: release});
    assert.ok(scan(state(), [item], {'10397': item}).outbox['10397']);
  }
});

test('release comparisons use the Japanese calendar day around UTC midnight', () => {
  const item = product('10397', {release_date: '2026-11-05'});
  assert.ok(scan(state(), [item], {'10397': item}, '2026-11-04T16:00:00Z').outbox['10397']);
  const zoned = product('10397', {release_date: '2026-11-04T16:00:00Z'});
  assert.ok(scan(state(), [zoned], {'10397': zoned}, '2026-11-04T16:05:00Z').outbox['10397']);
});

test('future, stale and invalid release dates are held', () => {
  for (const release of ['2026-11-06', '2026-10-21', '2026-02-30', '2026-11-04T25:01:00']) {
    const item = product('10397', {release_date: release});
    const result = scan(state(), [item], {'10397': item});
    assert.deepEqual(result.outbox, {});
    assert.ok(result.pending['10397']);
  }
  const cutoff = product('10397', {release_date: '2026-10-22'});
  assert.ok(scan(state(), [cutoff], {'10397': cutoff}).outbox['10397']);
});

test('missing required metadata or deactivation proof never becomes confirmed mail', () => {
  for (const fields of [
    {release_date: null, eligible: false, reason: 'missing_release_date'},
    {branch: ''}, {price_jpy: null}, {status: '状態不明'},
    {eligible: false, reason: 'missing_deactivation_evidence'},
    {category: '登録証付古式銃'}, {title: 'モデルガン'},
  ]) {
    const item = product('10397', fields);
    const result = scan(state(), [product()], {'10397': item});
    assert.deepEqual(result.outbox, {});
    assert.ok(result.pending['10397']);
  }
});

test('excluded category listings do not request details', () => {
  const item = product('10397', {title: '代表ページ', reason: 'excluded_title'});
  assert.deepEqual(plain(engine.candidateSkus(state(), [item])), []);
  const result = scan(state(), [item], {});
  assert.equal(result.pending['10397'].reason, 'excluded_title');
});

test('missing any candidate detail aborts the entire transition without state changes', () => {
  const original = state();
  const saved = plain(original);
  assert.throws(() => scan(original, [product(), product('10398')], {'10397': product()}), /detail result missing/);
  assert.deepEqual(original, saved);
});

test('detail identity and exact official URL are mandatory', () => {
  for (const fields of [
    {sku: '10398'},
    {url: 'https://evil.example/shop/g/g10397/'},
    {url: 'https://www.regimentals.jp.evil.example/shop/g/g10397/'},
    {url: 'https://www.regimentals.jp/shop/g/g10398/'},
    {url: 'https://www.regimentals.jp/shop/g/g10397/?token=secret'},
  ]) {
    const original = state();
    const saved = plain(original);
    assert.throws(() => scan(original, [product()], {'10397': product('10397', fields)}));
    assert.deepEqual(original, saved);
  }
});

test('pending review annotations and first observation survive repeated holds', () => {
  const original = state();
  original.seen['10397'] = '2026-11-04T11:13:25Z';
  original.pending['10397'] = {first_seen: '2026-11-04T11:13:25Z', review_receipt: 'mail-warning-1'};
  const missing = product('10397', {release_date: null, eligible: false, reason: 'missing_release_date'});
  const result = scan(original, [product()], {'10397': missing});
  assert.equal(result.pending['10397'].first_seen, original.pending['10397'].first_seen);
  assert.equal(result.pending['10397'].review_receipt, 'mail-warning-1');
});

test('markNotified consumes only the durable outbox item and is idempotent', () => {
  const original = scan(state(), [product()], {'10397': product()});
  const receipt = {channel: 'MailApp', recipient: 'collector@example.com', subject_id: 'sku-10397'};
  const result = plain(engine.markNotified(original, '10397', receipt, NOW));
  assert.deepEqual(result.outbox, {});
  assert.deepEqual(result.notified['10397'], {receipt, notified_at: NOW});
  assert.ok(original.outbox['10397']);
  assert.deepEqual(plain(engine.markNotified(result, '10397', {ignored: true}, '2026-11-05T02:00:00Z')), result);
  assert.throws(() => engine.markNotified(state(), '10397', receipt, NOW), /not in the durable outbox/);
});

test('delivery status annotations survive subsequent scans for runtime recovery', () => {
  const original = state();
  original.outbox['10397'] = product('10397', {delivery_status: 'SENDING', sending_at: NOW});
  assert.deepEqual(plain(engine.candidateSkus(original, [product()])), []);
  assert.deepEqual(scan(original, [product()], {}).outbox, original.outbox);
});

test('unchanged scans only update the actual success heartbeat every six hours', () => {
  const original = state();
  const item = product('10000');
  assert.deepEqual(scan(original, [item], {}), original);
  const result = scan(original, [item], {}, '2026-11-05T06:00:00Z');
  assert.equal(result.last_success_heartbeat, '2026-11-05T06:00:00Z');
});

test('empty scans, duplicate identities and damaged baselines fail closed', () => {
  assert.throws(() => scan(state(), [], {}), /empty/);
  assert.throws(() => scan(state(), [product(), product()], {'10397': product()}), /duplicate SKU/);
  assert.throws(() => engine.candidateSkus(Object.assign(state(), {initialized: false}), [product()]), /existing complete baseline/);
  assert.throws(() => engine.candidateSkus(Object.assign(state(), {seen: {}}), [product()]), /lost its baseline/);
  assert.throws(() => scan(state(), [product('10000')], {}, '2026-11-05T01:00:00'), /explicit timezone/);
});
