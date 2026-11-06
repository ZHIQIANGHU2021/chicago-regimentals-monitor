/* Google Apps Script adapters. Recipient is substituted only in the private bundle. */
var REGIMENTALS_MONITOR_CFG = {
  recipient: '__MONITOR_RECIPIENT__',
  importUrl: 'https://raw.githubusercontent.com/ZHIQIANGHU2021/chicago-regimentals-monitor/main/state.json',
  prefix: 'regimentals.monitor.',
  handler: 'runFiveMinuteMonitor',
  testId: 'google-monitor-v1',
  chunkLength: 8000,
  maxEncodedState: 140000,
  historyLength: 60,
  activationRuntimeBudgetMinutes: 72
};

var RegimentalsRuntime = (function () {
  'use strict';
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function now() { return new Date().toISOString(); }
  function fail(message) { throw new Error('Monitor: ' + message); }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function validState(state) {
    if (!object(state) || state.version !== 1 || state.initialized !== true ||
        !Number.isInteger(state.baseline_max_sku) || state.baseline_max_sku < 1 ||
        !state.baseline_at || !Number.isFinite(Date.parse(state.baseline_at))) fail('invalid legacy baseline');
    ['seen', 'pending', 'outbox', 'notified'].forEach(function (key) {
      if (!object(state[key])) fail('invalid state field ' + key);
    });
    if (!Object.keys(state.seen).length) fail('empty baseline; refusing to reinitialize');
    RegimentalsEngine.validateState(state);
    return state;
  }
  function runtime(state) {
    if (!object(state.runtime)) state.runtime = {};
    var rt = state.runtime;
    if (typeof rt.shadow_mode !== 'boolean') rt.shadow_mode = true;
    if (!Array.isArray(rt.history)) rt.history = [];
    if (!object(rt.deployment_tests)) rt.deployment_tests = {};
    if (!object(rt.pending_alerted)) rt.pending_alerted = {};
    return rt;
  }
  function recipient() {
    var value = REGIMENTALS_MONITOR_CFG.recipient;
    if (typeof value !== 'string' || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value))
      fail('private recipient is not configured');
    return value;
  }
  function digest(value) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
      .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  }
  function store() { return PropertiesService.getScriptProperties(); }
  function pointer(props, snapshot) {
    var raw = snapshot ? (snapshot[REGIMENTALS_MONITOR_CFG.prefix + 'pointer'] || null) :
      props.getProperty(REGIMENTALS_MONITOR_CFG.prefix + 'pointer');
    if (raw === null) return null;
    try {
      var ptr = JSON.parse(raw);
      if (!object(ptr) || !/^[A-Za-z0-9_-]+$/.test(ptr.current) ||
          (ptr.previous !== null && !/^[A-Za-z0-9_-]+$/.test(ptr.previous))) fail('invalid state pointer');
      return ptr;
    } catch (error) { fail('state pointer is corrupt; restore only after mail reconciliation'); }
  }
  function load() {
    var props = store(), snapshot = props.getProperties(), ptr = pointer(props, snapshot);
    if (!ptr) return null;
    var base = REGIMENTALS_MONITOR_CFG.prefix + 'g.' + ptr.current + '.';
    try {
      var meta = JSON.parse(snapshot[base + 'meta']);
      if (!meta || !Number.isInteger(meta.chunks) || meta.chunks < 1 || meta.chunks > 30) fail('invalid state chunks');
      var parts = [];
      for (var i = 0; i < meta.chunks; i++) {
        var part = snapshot[base + i];
        if (typeof part !== 'string') fail('missing state chunk');
        parts.push(part);
      }
      var encoded = parts.join('');
      if (encoded.length > REGIMENTALS_MONITOR_CFG.maxEncodedState || digest(encoded) !== meta.digest)
        fail('state digest mismatch');
      return validState(JSON.parse(Utilities.newBlob(Utilities.base64Decode(encoded)).getDataAsString('UTF-8')));
    } catch (error) {
      fail('saved state is incomplete or corrupt; refusing stale fallback or new baseline');
    }
  }
  function cleanup(props, ptr) {
    if (!ptr) return;
    var prefix = REGIMENTALS_MONITOR_CFG.prefix + 'g.';
    Object.keys(props.getProperties()).forEach(function (key) {
      if (key.indexOf(prefix) !== 0) return;
      var generation = key.slice(prefix.length).split('.')[0];
      if (generation !== ptr.current && generation !== ptr.previous) props.deleteProperty(key);
    });
  }
  function save(state) {
    validState(state);
    var props = store(), old = pointer(props);
    cleanup(props, old); // Remove abandoned, uncommitted generations first.
    var encoded = Utilities.base64Encode(JSON.stringify(state), Utilities.Charset.UTF_8);
    if (encoded.length > REGIMENTALS_MONITOR_CFG.maxEncodedState) fail('state exceeds safe storage budget');
    var snapshot = props.getProperties();
    var oldSize = Object.keys(snapshot).reduce(function (sum, key) {
      return sum + key.length + String(snapshot[key]).length;
    }, 0);
    if (oldSize + encoded.length + 3000 > 470000) fail('script property storage budget is nearly full');
    var generation = String(Date.now()) + '_' + Utilities.getUuid().replace(/-/g, '');
    var base = REGIMENTALS_MONITOR_CFG.prefix + 'g.' + generation + '.', chunks = [];
    for (var offset = 0; offset < encoded.length; offset += REGIMENTALS_MONITOR_CFG.chunkLength)
      chunks.push(encoded.slice(offset, offset + REGIMENTALS_MONITOR_CFG.chunkLength));
    chunks.forEach(function (value, index) { props.setProperty(base + index, value); });
    props.setProperty(base + 'meta', JSON.stringify({chunks: chunks.length, digest: digest(encoded), at: now()}));
    var saved = props.getProperties();
    var check = chunks.map(function (_, index) { return saved[base + index]; }).join('');
    if (digest(check) !== digest(encoded)) fail('new state generation could not be verified');
    var next = {current: generation, previous: old ? old.current : null};
    // One final property is the commit point. Earlier failures preserve the old pointer.
    props.setProperty(REGIMENTALS_MONITOR_CFG.prefix + 'pointer', JSON.stringify(next));
    try { cleanup(props, next); } catch (ignored) { console.warn('Monitor: deferred old-generation cleanup'); }
  }
  function request(url) {
    var rawPrefix = REGIMENTALS_MONITOR_CFG.importUrl + '?monitor_sync=';
    var imported = url === REGIMENTALS_MONITOR_CFG.importUrl ||
      (url.indexOf(rawPrefix) === 0 && /^\d{1,16}$/.test(url.slice(rawPrefix.length)));
    if (!imported &&
        !/^https:\/\/www\.regimentals\.jp\/shop\/(?:c\/c10_srd(?:_p\d+)?|g\/g[A-Za-z0-9_-]+)\/$/.test(url))
      fail('request URL is outside the fixed official sources');
    return {url: url, method: 'get', followRedirects: false, validateHttpsCertificates: true,
      muteHttpExceptions: true, timeoutSeconds: 12};
  }
  function readResponse(response, json) {
    if (response.getResponseCode() !== 200) fail('source request failed HTTP ' + response.getResponseCode());
    var headers = response.getHeaders(), contentType = '';
    Object.keys(headers).forEach(function (key) { if (key.toLowerCase() === 'content-type') contentType = String(headers[key]); });
    if (!json && contentType.toLowerCase().indexOf('text/html') < 0) fail('official page is not HTML');
    var text = response.getContentText('UTF-8');
    if (Utilities.newBlob(text).getBytes().length > (json ? 100000 : 1500000)) fail('source response is unexpectedly large');
    return text;
  }
  function get(url, json) {
    var req = request(url);
    var target = req.url; delete req.url;
    return readResponse(UrlFetchApp.fetch(target, req), json);
  }
  function importLegacy() {
    // A fresh cache key avoids importing a pre-cutover CDN snapshot of notified.
    var text = get(REGIMENTALS_MONITOR_CFG.importUrl + '?monitor_sync=' + Date.now(), true), state;
    try { state = JSON.parse(text); } catch (error) { fail('legacy state is not valid JSON'); }
    validState(state);
    // Only the private runtime controls its mode and mail bookkeeping.
    delete state.runtime;
    return state;
  }
  function withLock(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) fail('another monitoring run is active');
    try { return fn(); } finally { lock.releaseLock(); }
  }
  function triggers() {
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === REGIMENTALS_MONITOR_CFG.handler;
    });
  }
  function checkTriggers() {
    var existing = triggers();
    if (existing.length > 1) fail('multiple monitor triggers exist; remove duplicates before continuing');
    return existing;
  }
  function fetchCatalogue(metrics) {
    var first = RegimentalsSite.parseCategory(get(RegimentalsSite.categoryUrl(1), false), 1);
    metrics.pages = 1;
    var perPage = first.products.length;
    if (!perPage || Math.ceil(first.total_count / perPage) !== first.total_pages) fail('first catalogue page is incomplete');
    var pages = Math.min(3, first.total_pages), products = first.products.slice(), requests = [];
    for (var n = 2; n <= pages; n++) requests.push(request(RegimentalsSite.categoryUrl(n)));
    var responses = requests.length ? UrlFetchApp.fetchAll(requests) : [];
    if (responses.length !== requests.length) fail('catalogue batch response is incomplete');
    responses.forEach(function (response, index) {
      var number = index + 2, page = RegimentalsSite.parseCategory(readResponse(response, false), number);
      metrics.pages++;
      var expected = Math.min(perPage, first.total_count - perPage * (number - 1));
      if (page.total_count !== first.total_count || page.total_pages !== first.total_pages || page.products.length !== expected)
        fail('catalogue pagination changed during scan');
      products = products.concat(page.products);
    });
    var seen = {};
    products.forEach(function (product) {
      if (seen[product.sku]) fail('catalogue identities moved across pages');
      seen[product.sku] = true;
    });
    metrics.items = products.length;
    return products;
  }
  function fetchDetails(state, products, metrics) {
    var skus = RegimentalsEngine.candidateSkus(state, products), bySku = {}, listings = {};
    products.forEach(function (product) { listings[product.sku] = product; });
    var responses = skus.length ? UrlFetchApp.fetchAll(skus.map(function (sku) { return request(listings[sku].url); })) : [];
    if (responses.length !== skus.length) fail('detail batch response is incomplete');
    responses.forEach(function (response, index) {
      var sku = skus[index];
      bySku[sku] = RegimentalsSite.parseDetail(readResponse(response, false), listings[sku]);
      metrics.details++;
    });
    return bySku;
  }
  function mail(subject, body) {
    MailApp.sendEmail({to: recipient(), subject: subject, body: body, name: '芝加哥无可动实銃监控'});
  }
  function productMail(product) {
    var clean = function (value) { return String(value).replace(/[\r\n]+/g, ' '); };
    return {subject: '无可动实銃新上架｜' + clean(product.title) + '｜SKU ' + clean(product.sku),
      body: ['官网「無可動実銃」分类确认以下新商品：', '',
        '型号：' + clean(product.title), 'SKU：' + clean(product.sku),
        '含税价格：¥' + Number(product.price_jpy).toLocaleString('en-US') + ' JPY',
        '分店：' + clean(product.branch), '状态：' + clean(product.status),
        '発売日：' + clean(product.release_date), '', product.url,
        '', '这是已永久去除发射功能的收藏展示品通知。'].join('\n')};
  }
  function deliver(state) {
    var rt = runtime(state);
    if (rt.shadow_mode) return state;
    var skus = Object.keys(state.outbox);
    skus.forEach(function (sku) {
      if (state.notified[sku]) { delete state.outbox[sku]; return; }
      if (state.outbox[sku].delivery_status === 'sending')
        fail('mail outcome uncertain for SKU ' + sku + '; reconcile Gmail before any resend');
    });
    skus = Object.keys(state.outbox);
    if (MailApp.getRemainingDailyQuota() < skus.length) fail('mail quota insufficient; outbox retained');
    skus.forEach(function (sku) {
      var product = state.outbox[sku], message = productMail(product);
      product.delivery_status = 'sending'; product.delivery_started_at = now();
      save(state); // Crash after this point is ambiguous, so future runs must stop.
      mail(message.subject, message.body);
      state = RegimentalsEngine.markNotified(state, sku, {channel: 'MailApp', accepted_at: now()}, now());
      save(state);
    });
    return state;
  }
  function addHistory(state, metrics, status, error) {
    var finish = now();
    runtime(state).history.push({source: metrics.source, started: metrics.started, finished: finish,
      elapsedMs: Math.max(0, Date.parse(finish) - Date.parse(metrics.started)), pages: metrics.pages,
      itemcount: metrics.items, details: metrics.details, status: status,
      error: error ? String(error.message || error).slice(0, 350) : null});
    runtime(state).history = runtime(state).history.slice(-REGIMENTALS_MONITOR_CFG.historyLength);
  }
  function scanUnlocked(initial, event) {
    var state = initial, metrics = {source: event && event.triggerUid ? 'timer' : 'manual',
      started: now(), pages: 0, items: 0, details: 0}, recorded = false;
    try {
      var products = fetchCatalogue(metrics), details = fetchDetails(state, products, metrics);
      state = RegimentalsEngine.scanState(state, products, details, now());
      save(state); // No partially fetched catalogue can reach this commit.
      state = deliver(state);
      var rt = runtime(state), alerts = [];
      Object.keys(state.pending).forEach(function (sku) {
        var reason = String(state.pending[sku].reason || ''), key = sku + ':' + reason;
        if (Number(sku) > state.baseline_max_sku && !/^excluded_|^old_sku/.test(reason) && !rt.pending_alerted[key]) {
          rt.pending_alerted[key] = now(); alerts.push(sku + ' (' + reason + ')');
        }
      });
      addHistory(state, metrics, alerts.length ? 'verification_hold' : (rt.shadow_mode ? 'shadow_success' : 'success'));
      save(state); recorded = true;
      console.log(JSON.stringify(health(state)));
      if (alerts.length) fail('new SKU verification requires review: ' + alerts.join(', '));
      return state;
    } catch (error) {
      if (!recorded) {
        // Reload the committed generation: MailApp may have accepted a message
        // before a later persistence operation failed. Never overwrite it using
        // an older in-memory outbox.
        var committed = load();
        if (committed) state = committed;
        addHistory(state, metrics, 'failure', error); save(state);
      }
      console.error('Monitor failed: ' + String(error.message || error).slice(0, 350));
      throw error;
    }
  }
  function deploymentTest(state) {
    var rt = runtime(state), previous = rt.deployment_tests[REGIMENTALS_MONITOR_CFG.testId];
    if (previous && previous.status === 'sent') return state;
    if (previous) fail('deployment test mail outcome uncertain; reconcile Gmail before retrying');
    if (MailApp.getRemainingDailyQuota() < 1) fail('mail quota insufficient for deployment test');
    rt.deployment_tests[REGIMENTALS_MONITOR_CFG.testId] = {status: 'sending', started_at: now()}; save(state);
    mail('[部署测试] 芝加哥监控 Google 每5分钟检查',
      '这是 Google Apps Script 邮件送达测试，不是新品通知。\n\n当前处于影子验证模式：会实际检查官网，但尚不发送新品邮件。\n' +
      '确认自然定时运行正常并完成跨渠道去重后，再启用正式通知。');
    rt.deployment_tests[REGIMENTALS_MONITOR_CFG.testId] = {status: 'sent', accepted_at: now()}; save(state);
    return state;
  }
  function health(state) {
    var rt = runtime(state), timers = rt.history.filter(function (run) { return run.source === 'timer'; });
    var times = timers.map(function (run) { return Date.parse(run.started); }).sort(function (a, b) { return a - b; }), gaps = [];
    for (var i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000);
    gaps.sort(function (a, b) { return a - b; });
    var mid = Math.floor(gaps.length / 2), median = !gaps.length ? null : (gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
    var average = timers.length ? timers.reduce(function (sum, run) { return sum + run.elapsedMs; }, 0) / timers.length : null;
    return {mode: rt.shadow_mode ? 'SHADOW' : 'PRODUCTION', seen: Object.keys(state.seen).length,
      pending: Object.keys(state.pending).length, queued: Object.keys(state.outbox).length,
      notified: Object.keys(state.notified).length, timer_runs: timers.length,
      median_gap_seconds: median, max_gap_seconds: gaps.length ? gaps[gaps.length - 1] : null,
      projected_trigger_minutes_per_day: average === null ? null : average * 288 / 60000,
      activation_runtime_budget_minutes_per_day: REGIMENTALS_MONITOR_CFG.activationRuntimeBudgetMinutes,
      runtime_measurement_excludes: ['lock_and_initial_state_load', 'trigger_checks', 'final_history_save',
        'health_and_quota_calls', 'trigger_platform_overhead'],
      verify_actual_duration_in_google_execution_history: true,
      mail_remaining_quota: MailApp.getRemainingDailyQuota(),
      deployment_test: clone(rt.deployment_tests), last_run: rt.history.length ? clone(rt.history[rt.history.length - 1]) : null,
      history: clone(rt.history)};
  }
  function setup() {
    return withLock(function () {
      recipient(); var existing = checkTriggers(), state = load();
      if (!state) { state = importLegacy(); runtime(state).shadow_mode = true; save(state); }
      state = scanUnlocked(state, null); state = deploymentTest(state);
      if (!existing.length) ScriptApp.newTrigger(REGIMENTALS_MONITOR_CFG.handler).timeBased().everyMinutes(5).create();
      console.log(JSON.stringify(health(state))); return health(state);
    });
  }
  function run(event) {
    return withLock(function () {
      recipient(); checkTriggers(); var state = load();
      if (!state) fail('run setup first; automatic runs never import or reinitialize');
      return health(scanUnlocked(state, event));
    });
  }
  function printHealth() {
    return withLock(function () {
      var state = load(); if (!state) fail('monitor is not initialized');
      var result = health(state); result.monitor_trigger_count = triggers().length;
      console.log(JSON.stringify(result)); return result;
    });
  }
  function activate() {
    return withLock(function () {
      recipient(); if (checkTriggers().length !== 1) fail('exactly one natural timer is required');
      var state = load(); if (!state) fail('monitor is not initialized');
      var rt = runtime(state);
      if (!rt.shadow_mode) { console.log(JSON.stringify(health(state))); return health(state); }
      var recent = rt.history.filter(function (run) { return run.source === 'timer'; }).slice(-3);
      if (recent.length < 3 || recent.some(function (run) { return run.status !== 'shadow_success'; }))
        fail('verify at least three natural shadow runs consecutively before activation');
      if (Date.now() - Date.parse(recent[2].started) > 600000) fail('natural shadow verification is stale');
      for (var i = 1; i < recent.length; i++) {
        var gap = Date.parse(recent[i].started) - Date.parse(recent[i - 1].started);
        if (gap < 240000 || gap > 480000) fail('natural shadow timing has not demonstrated a five-minute cadence');
      }
      if (!rt.deployment_tests[REGIMENTALS_MONITOR_CFG.testId] ||
          rt.deployment_tests[REGIMENTALS_MONITOR_CFG.testId].status !== 'sent') fail('deployment test must be confirmed accepted before activation');
      var info = health(state);
      if (info.projected_trigger_minutes_per_day > REGIMENTALS_MONITOR_CFG.activationRuntimeBudgetMinutes)
        fail('measured runtime exceeds the activation daily trigger quota budget');
      var legacy = importLegacy();
      if (legacy.baseline_max_sku !== state.baseline_max_sku || legacy.baseline_at !== state.baseline_at)
        fail('legacy baseline changed; review migration before activation');
      Object.keys(legacy.notified).forEach(function (sku) {
        if (!state.notified[sku]) state.notified[sku] = clone(legacy.notified[sku]);
      });
      Object.keys(legacy.outbox).forEach(function (sku) {
        if (!state.notified[sku] && !state.outbox[sku]) state.outbox[sku] = clone(legacy.outbox[sku]);
      });
      Object.keys(legacy.pending).forEach(function (sku) {
        if (!state.notified[sku] && !state.outbox[sku] && !state.pending[sku]) state.pending[sku] = clone(legacy.pending[sku]);
      });
      Object.keys(legacy.seen).forEach(function (sku) {
        if (!Object.prototype.hasOwnProperty.call(state.seen, sku)) {
          state.seen[sku] = legacy.seen[sku];
          // A legacy observation alone cannot turn a new SKU into silent old
          // stock. Keep a recheck candidate if its queue/review record is absent.
          if (Number(sku) > state.baseline_max_sku && !state.notified[sku] && !state.outbox[sku] && !state.pending[sku])
            state.pending[sku] = {product: {sku: sku}, reason: 'migration_seen_requires_recheck', first_seen: legacy.seen[sku]};
        }
      });
      Object.keys(state.notified).forEach(function (sku) { delete state.outbox[sku]; delete state.pending[sku]; });
      Object.keys(state.outbox).forEach(function (sku) { delete state.pending[sku]; });
      Object.keys(state.outbox).forEach(function (sku) {
        if (state.outbox[sku].delivery_status === 'sending') fail('unresolved mail outcome must be reconciled before activation');
      });
      rt.shadow_mode = false; rt.activated_at = now(); rt.legacy_notified_sync_at = now(); save(state);
      console.log(JSON.stringify(health(state))); return health(state);
    });
  }
  return {setup: setup, run: run, printHealth: printHealth, activate: activate,
    load_: load, save_: save, health_: health, importLegacy_: importLegacy, scanUnlocked_: scanUnlocked};
})();

function setupAndStartMonitor() { return RegimentalsRuntime.setup(); }
function runFiveMinuteMonitor(event) { return RegimentalsRuntime.run(event); }
function printMonitorHealth() { return RegimentalsRuntime.printHealth(); }
function activateProductionMonitor() { return RegimentalsRuntime.activate(); }
