'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const site = require('../site_parser.js');
const fixtures = path.join(__dirname, '../../tests/fixtures');
const CATEGORY = fs.readFileSync(path.join(fixtures, 'category-live.html'), 'utf8');
const DETAIL = fs.readFileSync(path.join(fixtures, 'detail-live.html'), 'utf8');
const PRODUCT = site.parseCategory(CATEGORY).products[0];
const TITLE = 'フィンランド マキシム M/09-21 重機関銃 (#64387)';
const assertSiteError = callback => assert.throws(callback, {name: 'SiteError'});

test('runs as plain Apps Script V8 global without Node, DOM, or network', () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../site_parser.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.RegimentalsSite.parseCategory, 'function');
  assert.equal(sandbox.RegimentalsSite.parseDetail(DETAIL, PRODUCT).eligible, true);
});

test('real category verifies SKU, gross price, branch, status and dynamic pagination', () => {
  const page = site.parseCategory(CATEGORY);
  assert.equal(page.total_count, 548);
  assert.equal(page.total_pages, 28);
  assert.equal(page.current_page, 1);
  assert.deepEqual(PRODUCT, {sku:'10379',title:TITLE,url:'https://www.regimentals.jp/shop/g/g10379/',
    price_jpy:440000,branch:'東京店',status:'お客様ご連絡中',release_date:null,
    eligible:false,reason:'detail_not_checked',category:'無可動実銃'});
  assert.equal(site.parseCategory(CATEGORY.replace('<span>548</span>', '<span>549</span>')).total_count, 549);
});

test('official category URL keeps release sort and validates page bounds', () => {
  assert.equal(site.categoryUrl(), 'https://www.regimentals.jp/shop/c/c10_srd/');
  assert.equal(site.categoryUrl(3), 'https://www.regimentals.jp/shop/c/c10_srd_p3/');
  [0,201,1.2,'2'].forEach(value => assertSiteError(() => site.categoryUrl(value)));
});

test('live nested pager-count span reads only the direct numeric child', () => {
  const html = CATEGORY.replace('<div class="pager-count"><span>548</span>件あります</div>',
    '<span class="pager-count"><span>548</span>件あります</span>');
  assert.equal(site.parseCategory(html).total_count,548);
});

test('full timestamp remains eligible and uses gross rather than net price', () => {
  const product = site.parseDetail(DETAIL, PRODUCT);
  assert.equal(product.eligible, true);
  assert.equal(product.reason, 'verified');
  assert.equal(product.release_date, '2026-11-02T19:15:00');
  assert.equal(product.price_jpy, 440000);
});

test('Vz37 date-only release remains date-only and eligible', () => {
  const html = DETAIL.replaceAll('10379','10397').replaceAll(TITLE,'Vz.37 重機関銃 (#1436)')
    .replace('2026/11/02 19:15:00','2026/11/04').replace('￥440,000','￥550,000').replace('￥400,000','￥500,000');
  const listing = {...PRODUCT,sku:'10397',title:'Vz.37 重機関銃 (#1436)',url:'https://www.regimentals.jp/shop/g/g10397/'};
  const product = site.parseDetail(html, listing);
  assert.equal(product.eligible,true);
  assert.equal(product.release_date,'2026-11-04');
  assert.equal(product.sku,'10397'); // Serial #1436 is not the SKU.
  assert.equal(product.price_jpy,550000);
  assert.equal(product.branch,'東京店');
  assert.equal(product.status,'お客様ご連絡中');
});

test('malformed and impossible date values are held', () => {
  ['2026/11','2026/02/30','2026/11/04 25:00:00','未定','2026/11/04 extra'].forEach(value => {
    const product = site.parseDetail(DETAIL.replace('2026/11/02 19:15:00',value),PRODUCT);
    assert.equal(product.eligible,false);
    assert.equal(product.reason,'missing_release_date');
    assert.equal(product.release_date,null);
  });
});

test('navigation mentioning deactivation cannot substitute for item evidence', () => {
  const html = DETAIL.replace('日本国内の基準に準じた加工が施された無可動実銃です','装飾品です');
  const product = site.parseDetail(html,PRODUCT);
  assert.equal(product.eligible,false);
  assert.equal(product.reason,'missing_deactivation_evidence');
});

test('functional antique breadcrumb is excluded even when title and navigation match', () => {
  const html = DETAIL.replace('https://www.regimentals.jp/shop/c/c10/','https://www.regimentals.jp/shop/c/c20/');
  assert.equal(site.parseDetail(html,PRODUCT).reason,'excluded_detail_category');
});

test('missing stock/contact status is held', () => {
  const html = DETAIL.replace('<dd id="spec_stock_msg">0</dd>','')
    .replace('<div class="block-icon"><img alt="お客様ご連絡中"></div>','');
  const product = site.parseDetail(html,PRODUCT);
  assert.equal(product.eligible,false);
  assert.equal(product.reason,'missing_status');
});

test('missing branch or tax price basis is held', () => {
  const noBranch = DETAIL.replace('<dd id="spec_variation_name2" class="js-enhanced-ecommerce-variation-name">東京店</dd>',
    '<dd id="spec_variation_name2">未詳</dd>');
  assert.equal(site.parseDetail(noBranch,PRODUCT).reason,'missing_branch');
  assert.equal(site.parseDetail(DETAIL.replace('税抜 ￥400,000','価格応談'),PRODUCT).reason,'missing_tax_inclusive_price');
});

test('representative, model, registered antique and muzzleloader titles are excluded', () => {
  ['代表ページ','モデルガン','模型','火縄銃','管打銃','登録証付古式銃'].forEach(title => {
    assert.equal(site.parseCategory(CATEGORY.replaceAll(TITLE,title)).products[0].reason,'excluded_title');
    assert.equal(site.parseDetail(DETAIL.replaceAll(TITLE,title),PRODUCT).reason,'excluded_title');
  });
});

test('wrong category, sort, current page, empty cards and error pages fail closed', () => {
  const variants = [
    CATEGORY.replace('<dd class="active">発売日</dd>','<dd class="active">商品名</dd>'),
    CATEGORY.replace('data-category="無可動実銃(10)"','data-category="登録証付古式銃(20)"'),
    CATEGORY.replace('<span>1</span>','<span>2</span>'),
    CATEGORY.replace('block-goods-list-d--items','other-items'),
    CATEGORY.replace('<span>548</span>','<span>0</span>'),
    '<html><title>Access denied</title></html>'
  ];
  variants.forEach(html => assertSiteError(() => site.parseCategory(html)));
});

test('nonofficial URL, mismatched SKU and duplicate cards fail closed', () => {
  assertSiteError(() => site.parseCategory(CATEGORY.replaceAll('/shop/g/g10379/','https://example.com/shop/g/g10379/')));
  assertSiteError(() => site.parseCategory(CATEGORY.replace('商品番号：10379','商品番号：99999')));
  const card = CATEGORY.slice(CATEGORY.indexOf('<li>',CATEGORY.indexOf('<ul class="block-goods-list-d--items">')),CATEGORY.lastIndexOf('</li></ul>')+5);
  assertSiteError(() => site.parseCategory(CATEGORY.replace('</li></ul>','</li>'+card+'</ul>')));
  assertSiteError(() => site.parseDetail(DETAIL,{...PRODUCT,sku:'99999'}));
});

test('quoted greater-than and encoded entities parse without creating markup', () => {
  const title = 'Vz.37 &amp; &quot;A &gt; B&quot; &#35;1436';
  const parsed = site.parseCategory(CATEGORY.replaceAll(TITLE,title)).products[0];
  assert.equal(parsed.title,'Vz.37 & "A > B" #1436');
});

test('truncated tags, comments, raw elements and duplicate attributes fail closed', () => {
  [CATEGORY+'<div data-x="unfinished',CATEGORY+'<!--unfinished',CATEGORY+'<script>unfinished',
    CATEGORY.replace('data-category="無可動実銃(10)"','data-category="無可動実銃(10)" data-category="other"')]
    .forEach(html => assertSiteError(() => site.parseCategory(html)));
});
