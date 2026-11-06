/* Pure V8 / Apps Script parser. No network, DOM, Node or third-party runtime.
 * Selectors and factual fields verified against official HTML, 2026-11-05.
 */
var RegimentalsSite = (function () {
  'use strict';
  var BASE = 'https://www.regimentals.jp';
  var EXCLUDED = /代表ページ|代表頁|モデルガン|模型|レプリカ|登録証|火縄|管打|パーカッション|フリントロック|非無可動|未加工/;
  var VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;

  function fail(message) {
    var error = new Error(message);
    error.name = 'SiteError';
    throw error;
  }

  function decode(value) {
    var named = {amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', yen: '¥'};
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|yen);/gi, function (whole, key) {
      if (key.charAt(0) !== '#') return named[key.toLowerCase()];
      var code = key.charAt(1).toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    });
  }

  function attrs(source) {
    var result = {}, i = 0;
    while (i < source.length) {
      while (/\s/.test(source.charAt(i)) && i < source.length) i++;
      if (i >= source.length || /^\/\s*$/.test(source.slice(i))) break;
      var match = /^[^\s=<>/"']+/.exec(source.slice(i));
      if (!match) fail('Malformed HTML attribute');
      var key = match[0].toLowerCase();
      i += match[0].length;
      while (/\s/.test(source.charAt(i)) && i < source.length) i++;
      var value = '';
      if (source.charAt(i) === '=') {
        i++;
        while (/\s/.test(source.charAt(i)) && i < source.length) i++;
        var quote = source.charAt(i);
        if (quote === '"' || quote === "'") {
          var end = source.indexOf(quote, i + 1);
          if (end < 0) fail('Unterminated HTML attribute');
          value = source.slice(i + 1, end);
          i = end + 1;
        } else {
          var unquoted = /^[^\s<>]+/.exec(source.slice(i));
          if (!unquoted) fail('Missing HTML attribute value');
          value = unquoted[0];
          i += value.length;
        }
      }
      if (Object.prototype.hasOwnProperty.call(result, key)) fail('Duplicate HTML attribute');
      result[key] = decode(value);
    }
    return result;
  }

  function tree(html) {
    if (typeof html !== 'string' || !html || html.length > 3000000) fail('Missing or oversized HTML');
    var root = {tag: '#document', attrs: {}, children: []}, stack = [root], i = 0;
    var lower = html.toLowerCase();
    while (i < html.length) {
      if (html.slice(i, i + 4) === '<!--') {
        var commentEnd = html.indexOf('-->', i + 4);
        if (commentEnd < 0) fail('Unterminated HTML comment');
        i = commentEnd + 3;
        continue;
      }
      if (html.charAt(i) !== '<') {
        var next = html.indexOf('<', i);
        if (next < 0) next = html.length;
        stack[stack.length - 1].children.push(decode(html.slice(i, next)));
        i = next;
        continue;
      }
      var quote = '', end = i + 1;
      for (; end < html.length; end++) {
        var ch = html.charAt(end);
        if (quote) { if (ch === quote) quote = ''; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
      }
      if (end >= html.length) fail('Unterminated HTML tag');
      var raw = html.slice(i + 1, end);
      i = end + 1;
      if (/^!doctype\b/i.test(raw) || /^\?/.test(raw)) continue;
      var closing = /^\/\s*([a-z][\w:-]*)\s*$/i.exec(raw);
      if (closing) {
        var closingTag = closing[1].toLowerCase(), position = stack.length - 1;
        while (position > 0 && stack[position].tag !== closingTag) position--;
        if (position > 0) stack.length = position;
        continue;
      }
      var opening = /^([a-z][\w:-]*)([\s\S]*)$/i.exec(raw);
      if (!opening) fail('Malformed HTML tag');
      var tag = opening[1].toLowerCase();
      var node = {tag: tag, attrs: attrs(opening[2]), children: []};
      stack[stack.length - 1].children.push(node);
      if (tag === 'script' || tag === 'style') {
        var closeStart = lower.indexOf('</' + tag, i);
        if (closeStart < 0) fail('Unterminated raw HTML element');
        var closeEnd = html.indexOf('>', closeStart);
        if (closeEnd < 0) fail('Unterminated raw HTML element');
        i = closeEnd + 1; // Script/style contents can never provide product evidence.
      } else if (!VOID.test(tag) && !/\/\s*$/.test(raw)) stack.push(node);
    }
    // Real HTML permits omitted close tags, so required product fields below
    // provide the structural checks rather than rejecting browser-valid markup.
    var title = text(first(root, function (n) { return n.tag === 'title'; })).toLowerCase();
    if (/access denied|just a moment|captcha|error|メンテナンス/.test(title)) fail('Official site returned an error or challenge page');
    return root;
  }

  function all(node, predicate) {
    var out = [];
    function visit(current) {
      if (!current || typeof current === 'string') return;
      if (predicate(current)) out.push(current);
      current.children.forEach(visit);
    }
    visit(node);
    return out;
  }
  function first(node, predicate) { return all(node, predicate)[0] || null; }
  function hasClass(node, name) { return (' ' + (node.attrs['class'] || '').replace(/\s+/g, ' ') + ' ').indexOf(' ' + name + ' ') >= 0; }
  function byClass(node, name) { return first(node, function (n) { return hasClass(n, name); }); }
  function byId(node, id) { return first(node, function (n) { return n.attrs.id === id; }); }
  function text(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    return node.children.map(text).join(' ').replace(/\s+/g, ' ').trim();
  }
  function officialUrl(href) {
    if (typeof href !== 'string' || /[\s\\]/.test(href)) fail('Unexpected product URL');
    var path;
    if (/^\/(?!\/)/.test(href)) path = href.split(/[?#]/, 1)[0];
    else {
      var match = /^https:\/\/(?:www\.)?regimentals\.jp(\/[^?#]*)?(?:[?#][\s\S]*)?$/i.exec(href);
      if (!match) fail('Unexpected non-official URL in catalogue');
      path = match[1] || '/';
    }
    if (/(^|\/)\.\.?(\/|$)/.test(path)) fail('Unexpected path traversal in catalogue');
    return BASE + path;
  }
  function pathOf(url) { return url.slice(BASE.length); }
  function price(node) {
    var match = /^[￥¥]\s*([\d,]+)$/.exec(text(node));
    var value = match ? Number(match[1].replace(/,/g, '')) : null;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  function branch(value) { var match = /(東京店|大阪店)/.exec(value); return match ? match[1] : ''; }
  function status(container, stock, variation) {
    if ((variation || '').indexOf('商談中') >= 0) return '商談中';
    var icons = all(container, function (n) { return hasClass(n, 'block-icon'); });
    for (var i = 0; i < icons.length; i++) {
      var images = all(icons[i], function (n) { return n.tag === 'img'; });
      for (var j = 0; j < images.length; j++) {
        var label = images[j].attrs.alt || '';
        if (/連絡中|予約|商談|売約|販売済/.test(label)) return label;
      }
    }
    if (/^\d+$/.test(stock)) return Number(stock) > 0 ? '在庫あり' : '在庫なし';
    return stock || '状態不明';
  }
  function released(value) {
    var match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?: (\d{1,2}):(\d{1,2}):(\d{1,2}))?$/.exec(value);
    if (!match) return null;
    var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    var hour = Number(match[4] || 0), minute = Number(match[5] || 0), second = Number(match[6] || 0);
    var date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
    function pad(number) { return String(number).padStart(2, '0'); }
    var result = String(year).padStart(4, '0') + '-' + pad(month) + '-' + pad(day);
    return match[4] === undefined ? result : result + 'T' + pad(hour) + ':' + pad(minute) + ':' + pad(second);
  }
  function changed(product, updates) { return Object.assign({}, product, updates); }

  function categoryUrl(page) {
    page = page === undefined ? 1 : page;
    if (!Number.isInteger(page) || page < 1 || page > 200) fail('Unexpected catalogue page number');
    return BASE + '/shop/c/c10_srd' + (page === 1 ? '' : '_p' + page) + '/';
  }

  function parseCategory(html, pageNumber) {
    pageNumber = pageNumber === undefined ? 1 : pageNumber;
    categoryUrl(pageNumber); // Validate the expected page number.
    var root = tree(html);
    var heading = first(root, function (n) { return n.tag === 'h1' && hasClass(n, 'block-category-list--header'); });
    if (text(heading) !== '無可動実銃') fail('Expected the exact 無可動実銃 category');
    var active = first(byClass(root, 'block-goods-list--sort-order-items'), function (n) { return n.tag === 'dd' && hasClass(n, 'active'); });
    if (text(active) !== '発売日') fail('Catalogue is not sorted by 発売日');
    var countNode = byClass(root, 'pager-count'), currentNode = byClass(root, 'pager-current');
    function childSpan(node) {
      return node ? node.children.filter(function (n) { return typeof n !== 'string' && n.tag === 'span'; })[0] : null;
    }
    var count = text(childSpan(countNode));
    var current = text(childSpan(currentNode));
    if (!/^\d+$/.test(count) || !/^\d+$/.test(current) || Number(current) !== pageNumber) fail('Missing or unexpected catalogue pagination');
    var total = Number(count), pages = pageNumber;
    if (total < 1 || total > 100000) fail('Unexpected empty or oversized catalogue');
    all(root, function (n) { return hasClass(n, 'pagination'); }).forEach(function (pagination) {
      all(pagination, function (n) { return n.tag === 'a' && n.attrs.href !== undefined; }).forEach(function (anchor) {
        var match = /^\/shop\/c\/c10_srd(?:_p(\d+))?\/$/.exec(pathOf(officialUrl(anchor.attrs.href)));
        if (!match) fail('Unexpected category or sort in pagination');
        pages = Math.max(pages, Number(match[1] || 1));
      });
    });
    if (pages < 1 || pages > 200) fail('Unexpected catalogue page count');
    var lists = all(root, function (n) { return hasClass(n, 'block-goods-list-d--items'); });
    if (lists.length !== 1) fail('Catalogue cards missing or ambiguous');
    var cards = lists[0].children.filter(function (n) { return typeof n !== 'string' && n.tag === 'li'; });
    if (!cards.length) fail('Catalogue cards missing');
    var seen = {};
    var products = cards.map(function (card) {
      var anchor = first(byClass(card, 'block-goods-list-d--goods-name'), function (n) { return n.tag === 'a' && n.attrs.href !== undefined; });
      if (!anchor || !text(anchor)) fail('A catalogue card has no product identity');
      var url = officialUrl(anchor.attrs.href), match = /^\/shop\/g\/g([A-Za-z0-9_-]+)\/?$/.exec(pathOf(url));
      if (!match) fail('Unexpected product detail URL');
      var sku = match[1];
      if (seen[sku]) fail('Duplicate product identity within catalogue page');
      seen[sku] = true;
      if (anchor.attrs['data-category'] !== '無可動実銃(10)') fail('A card is outside the exact 無可動実銃 category');
      var comment = text(byClass(card, 'block-goods-list-d--goods-comment'));
      var printed = /商品番号\s*[:：]\s*([A-Za-z0-9_-]+)/.exec(comment);
      if (!printed || printed[1] !== sku) fail('Product URL and printed SKU disagree');
      var title = text(anchor), variation = text(byClass(card, 'variation-name'));
      return {sku: sku, title: title, url: url, price_jpy: price(byClass(card, 'block-goods-list-d--price')),
        branch: branch(comment + ' ' + variation),
        status: status(card, text(byClass(card, 'block-goods-list-d--stock')), variation),
        release_date: null, eligible: false, reason: EXCLUDED.test(title) ? 'excluded_title' : 'detail_not_checked', category: '無可動実銃'};
    });
    return {products: products, total_count: total, total_pages: pages, current_page: pageNumber};
  }

  function parseDetail(html, product) {
    if (!product || typeof product.sku !== 'string') fail('Missing expected product identity');
    var root = tree(html);
    var heading = first(root, function (n) { return n.tag === 'h1' && hasClass(n, 'block-goods-name--text'); });
    var sku = text(byId(root, 'spec_goods'));
    if (!heading || !sku) fail('Product detail identity missing');
    if (sku !== product.sku) fail('Product detail SKU changed or redirected');
    var title = text(heading), categories = {};
    all(byId(root, 'bread-crumb-list'), function (n) { return n.tag === 'a' && n.attrs.href !== undefined; }).forEach(function (anchor) {
      categories[pathOf(officialUrl(anchor.attrs.href))] = text(anchor);
    });
    if (categories['/shop/c/c10/'] !== '無可動実銃') return changed(product, {eligible: false, reason: 'excluded_detail_category'});
    if (EXCLUDED.test(title)) return changed(product, {title: title, eligible: false, reason: 'excluded_title'});
    var description = text(byClass(root, 'block-goods-comment6'));
    var deactivated = /本ページに掲載の商品は[、,]?\s*日本国内の基準に準じた加工が施された無可動実銃です/.test(description);
    var release = released(text(byId(root, 'spec_release_dt')));
    var shop = branch(text(byId(root, 'spec_variation_name2')));
    var gross = price(byClass(root, 'block-goods-price--price'));
    var grossConfirmed = /^税抜\s*[￥¥]\s*[\d,]+$/.test(text(byClass(root, 'block-goods-price--net-price')));
    var itemStatus = status(byClass(root, 'pane-goods-right-side') || root, text(byId(root, 'spec_stock_msg')), text(byId(root, 'spec_variation_name2')));
    var reason = !deactivated ? 'missing_deactivation_evidence' : !release ? 'missing_release_date' :
      !shop ? 'missing_branch' : gross === null || !grossConfirmed ? 'missing_tax_inclusive_price' :
      !itemStatus || itemStatus === '状態不明' ? 'missing_status' : 'verified';
    return changed(product, {title: title, price_jpy: gross, branch: shop, status: itemStatus,
      release_date: release, eligible: reason === 'verified', reason: reason, category: '無可動実銃'});
  }

  return {parseCategory: parseCategory, parseDetail: parseDetail, categoryUrl: categoryUrl};
}());
if (typeof module !== 'undefined' && module.exports) module.exports = RegimentalsSite;
