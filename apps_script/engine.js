/* Pure catalogue state transitions shared by Apps Script and Node tests.
 * All public transitions return JSON copies. No network, mail, storage or clock API.
 * A previously imported complete baseline is required; this engine never resets it.
 */
var RegimentalsEngine = (function () {
  'use strict';
  var DAY_MS = 86400000;
  var HEARTBEAT_MS = 6 * 60 * 60 * 1000;
  var RECENT_DAYS = 14;
  var EXCLUDED_TITLE = /代表ページ|代表頁|モデルガン|模型|レプリカ|登録証|火縄|管打|パーカッション|フリントロック|非無可動|未加工/;
  var own = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function dictionary(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function fail(message) { throw new Error('RegimentalsEngine: ' + message); }
  function timestamp(value, label) {
    if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      fail(label + ' requires an explicit timezone');
    }
    var milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) fail('invalid ' + label);
    return milliseconds;
  }
  function clock(nowISO) {
    var milliseconds = timestamp(nowISO, 'nowISO');
    return { milliseconds: milliseconds,
      iso: new Date(milliseconds).toISOString().replace('.000Z', 'Z'),
      jstDay: new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) };
  }
  function identity(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) ||
        value === '__proto__' || value === 'constructor' || value === 'prototype') {
      fail('invalid catalogue SKU');
    }
    return value;
  }
  function numericSku(sku) {
    var match = /^g?(\d+)$/i.exec(sku);
    if (!match) return null;
    var number = Number(match[1]);
    return Number.isSafeInteger(number) ? number : null;
  }
  function validateState(state) {
    if (!dictionary(state) || state.version !== 1) fail('unsupported state version');
    if (state.initialized !== true) fail('import the existing complete baseline before enabling monitoring');
    ['seen', 'pending', 'outbox', 'notified'].forEach(function (field) {
      if (!dictionary(state[field])) fail('invalid state field ' + field);
    });
    if (!Object.keys(state.seen).length || !Number.isSafeInteger(state.baseline_max_sku) ||
        state.baseline_max_sku < 0) fail('initialized state has lost its baseline');
    timestamp(state.baseline_at, 'baseline_at');
    if (state.last_success_heartbeat !== null && state.last_success_heartbeat !== undefined) {
      timestamp(state.last_success_heartbeat, 'last_success_heartbeat');
    }
    Object.keys(state.outbox).forEach(function (sku) {
      identity(sku);
      if (!dictionary(state.outbox[sku]) || state.outbox[sku].sku !== sku) fail('invalid outbox entry');
    });
    return true;
  }
  function catalogue(products) {
    if (!Array.isArray(products) || products.length === 0) fail('empty or invalid category scan');
    var seen = Object.create(null);
    return products.map(function (product) {
      if (!dictionary(product)) fail('invalid category product');
      var sku = identity(product.sku);
      if (own(seen, sku)) fail('duplicate SKU in completed category scan');
      seen[sku] = true;
      return product;
    });
  }
  function needsConsideration(state, sku) {
    if (own(state.notified, sku) || own(state.outbox, sku)) return false;
    return !own(state.seen, sku) || own(state.pending, sku);
  }
  function titleExcluded(product) {
    return EXCLUDED_TITLE.test(String(product.title || '')) ||
      String(product.reason || '').indexOf('excluded_') === 0;
  }
  function candidateSkus(state, products) {
    validateState(state);
    return catalogue(products).filter(function (product) {
      var number = numericSku(product.sku);
      return needsConsideration(state, product.sku) && number !== null &&
        number > state.baseline_max_sku && !titleExcluded(product);
    }).map(function (product) { return product.sku; });
  }
  function hold(state, product, reason, now) {
    var sku = product.sku;
    var previous = own(state.pending, sku) && dictionary(state.pending[sku]) ? state.pending[sku] : {};
    var entry = clone(previous);
    entry.product = clone(product);
    entry.reason = reason;
    entry.first_seen = previous.first_seen || state.seen[sku] || now.iso;
    state.pending[sku] = entry;
  }
  function releaseDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return null;
    var day = value.slice(0, 10);
    var milliseconds = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== day) return null;
    // A naive official datetime is Japanese local time; explicit offsets are
    // converted to a Japanese date before the same calendar-day comparison.
    if (value.indexOf('T') !== -1) {
      var timeParts = /T(\d{2}):(\d{2}):(\d{2})/.exec(value);
      if (Number(timeParts[1]) > 23 || Number(timeParts[2]) > 59 || Number(timeParts[3]) > 59) return null;
      if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        var instant = Date.parse(value);
        if (!Number.isFinite(instant)) return null;
        return new Date(instant + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      }
    }
    return day;
  }
  function metadataReason(product, now) {
    if (titleExcluded(product)) return String(product.reason || '').indexOf('excluded_') === 0 ? product.reason : 'excluded_title';
    if (product.category !== '無可動実銃') return 'excluded_detail_category';
    var reason = product.eligible === true ? null : (product.reason || 'detail_not_verified');
    ['title', 'branch', 'status', 'release_date'].forEach(function (field) {
      if (typeof product[field] !== 'string' || !product[field].trim()) reason = reason || 'missing_' + field;
    });
    if (product.branch !== '東京店' && product.branch !== '大阪店') reason = reason || 'missing_branch';
    if (product.status === '状態不明') reason = reason || 'missing_status';
    if (!Number.isSafeInteger(product.price_jpy) || product.price_jpy <= 0) reason = reason || 'missing_tax_inclusive_price';
    var released = releaseDay(product.release_date);
    if (released === null) return reason || 'missing_release_date';
    var age = Date.parse(now.jstDay + 'T00:00:00Z') - Date.parse(released + 'T00:00:00Z');
    if (age < 0 || age > RECENT_DAYS * DAY_MS) reason = reason || 'release_date_not_recent';
    return reason;
  }
  function verifyDetailIdentity(product, expectedSku) {
    if (!dictionary(product) || identity(product.sku) !== expectedSku) fail('detail SKU differs from listing SKU');
    var url = typeof product.url === 'string' ? product.url : '';
    var match = /^https:\/\/(?:www\.)?regimentals\.jp\/shop\/g\/g([A-Za-z0-9_-]+)\/?$/.exec(url);
    if (!match || match[1] !== expectedSku) fail('detail URL is not the matching official product page');
  }
  function scanState(state, products, detailBySku, nowISO) {
    validateState(state);
    var listed = catalogue(products);
    var now = clock(nowISO);
    if (!dictionary(detailBySku)) fail('detailBySku must contain completed detail results');
    var updated = clone(state);
    listed.forEach(function (listing) {
      var sku = listing.sku;
      if (!needsConsideration(state, sku)) return;
      if (!own(updated.seen, sku)) updated.seen[sku] = now.iso;
      var number = numericSku(sku);
      if (number === null || number <= state.baseline_max_sku) {
        hold(updated, listing, 'old_sku_needs_official_new_arrival_evidence', now);
        return;
      }
      if (titleExcluded(listing)) {
        hold(updated, listing, String(listing.reason || '').indexOf('excluded_') === 0 ? listing.reason : 'excluded_title', now);
        return;
      }
      if (!own(detailBySku, sku)) fail('completed detail result missing for SKU ' + sku);
      var product = detailBySku[sku];
      verifyDetailIdentity(product, sku);
      var reason = metadataReason(product, now);
      if (reason) {
        hold(updated, product, reason, now);
        return;
      }
      var queued = clone(product);
      queued.first_seen = updated.seen[sku];
      queued.detected_at = now.iso;
      updated.outbox[sku] = queued;
      delete updated.pending[sku];
    });
    if (!updated.last_success_heartbeat ||
        now.milliseconds - timestamp(updated.last_success_heartbeat, 'last_success_heartbeat') >= HEARTBEAT_MS) {
      updated.last_success_heartbeat = now.iso;
    }
    return updated;
  }
  function markNotified(state, sku, receipt, nowISO) {
    validateState(state);
    identity(sku);
    var now = clock(nowISO);
    var updated = clone(state);
    if (own(updated.notified, sku)) return updated;
    if (!own(updated.outbox, sku)) fail('cannot mark a SKU that is not in the durable outbox');
    if (receipt === null || receipt === undefined || receipt === '') fail('mail receipt metadata is required');
    updated.notified[sku] = { receipt: clone(receipt), notified_at: now.iso };
    delete updated.outbox[sku];
    return updated;
  }
  return Object.freeze({ validateState: validateState, numericSku: numericSku,
    candidateSkus: candidateSkus, scanState: scanState, markNotified: markNotified });
}());
