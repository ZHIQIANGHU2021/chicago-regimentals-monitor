"""Fail-closed checks using sanitized snippets of real official HTML."""
from dataclasses import replace
from pathlib import Path
import unittest

from regimentals_site import (
    CATEGORY_URL, Product, SiteClient, SiteError, parse_category, parse_detail,
)

FIXTURES = Path(__file__).parent / "fixtures"
CATEGORY = (FIXTURES / "category-live.html").read_text(encoding="utf-8")
DETAIL = (FIXTURES / "detail-live.html").read_text(encoding="utf-8")


class OfficialHtmlTests(unittest.TestCase):
    def setUp(self):
        self.product = parse_category(CATEGORY).products[0]

    def test_real_category_identity_gross_price_and_pagination(self):
        page = parse_category(CATEGORY)
        self.assertEqual((page.total_count, page.total_pages, page.current_page), (548, 28, 1))
        self.assertEqual(self.product.sku, "10379")
        self.assertEqual(self.product.price_jpy, 440000)  # Net 400000 is separate.
        self.assertEqual(self.product.branch, "東京店")
        self.assertEqual(self.product.status, "お客様ご連絡中")
        self.assertFalse(self.product.eligible)

    def test_detail_requires_specific_deactivation_evidence(self):
        product = parse_detail(DETAIL, self.product)
        self.assertTrue(product.eligible)
        self.assertEqual(product.release_date, "2026-11-02T19:15:00")
        self.assertEqual(product.price_jpy, 440000)
        no_evidence = DETAIL.replace("日本国内の基準に準じた加工が施された無可動実銃です", "装飾品です")
        self.assertEqual(parse_detail(no_evidence, self.product).reason, "missing_deactivation_evidence")

    def test_real_vz37_date_only_release_is_eligible_without_invented_time(self):
        # SKU 10397's official 発売日 was 2026/11/04, without a time.
        # Reuse sanitized structure while retaining the actual identifying
        # fields, price, branch, status and deactivation disclaimer.
        html = (DETAIL.replace("10379", "10397")
                .replace("フィンランド マキシム M/09-21 重機関銃 (#64387)", "Vz.37 重機関銃 (#1436)")
                .replace("2026/11/02 19:15:00", "2026/11/04")
                .replace("￥440,000", "￥550,000")
                .replace("￥400,000", "￥500,000"))
        listing = replace(self.product, sku="10397", title="Vz.37 重機関銃 (#1436)",
                          url="https://www.regimentals.jp/shop/g/g10397/")
        product = parse_detail(html, listing)
        self.assertTrue(product.eligible)
        self.assertEqual(product.reason, "verified")
        self.assertEqual(product.release_date, "2026-11-04")
        self.assertEqual(product.price_jpy, 550000)
        self.assertEqual(product.branch, "東京店")
        self.assertEqual(product.status, "お客様ご連絡中")

    def test_malformed_and_impossible_release_dates_remain_held(self):
        for invalid in ("2026/11", "2026/02/30", "2026/11/04 25:00:00", "未定"):
            with self.subTest(release=invalid):
                product = parse_detail(DETAIL.replace("2026/11/02 19:15:00", invalid), self.product)
                self.assertFalse(product.eligible)
                self.assertEqual(product.reason, "missing_release_date")
                self.assertIsNone(product.release_date)

    def test_changed_sort_category_and_page_fail(self):
        for html in (
            CATEGORY.replace('<dd class="active">発売日</dd>', '<dd class="active">商品名</dd>'),
            CATEGORY.replace('data-category="無可動実銃(10)"', 'data-category="登録証付古式銃(20)"'),
            CATEGORY.replace('<span>1</span>', '<span>2</span>'),
            '<html><title>Access denied</title></html>',
        ):
            with self.subTest(html=html[:40]), self.assertRaises(SiteError):
                parse_category(html)

    def test_outside_product_link_and_mismatched_sku_fail(self):
        for html in (
            CATEGORY.replace('/shop/g/g10379/', 'https://example.com/shop/g/g10379/'),
            CATEGORY.replace('商品番号：10379', '商品番号：99999'),
        ):
            with self.assertRaises(SiteError):
                parse_category(html)

    def test_registered_antique_does_not_pass_with_header_navigation(self):
        html = DETAIL.replace('https://www.regimentals.jp/shop/c/c10/',
                              'https://www.regimentals.jp/shop/c/c20/')
        self.assertEqual(parse_detail(html, self.product).reason, "excluded_detail_category")

    def test_missing_date_or_tax_basis_keeps_review_candidate(self):
        for html, reason in (
            (DETAIL.replace('2026/11/02 19:15:00', '未定'), 'missing_release_date'),
            (DETAIL.replace('税抜 ￥400,000', '価格応談'), 'missing_tax_inclusive_price'),
        ):
            product = parse_detail(html, self.product)
            self.assertFalse(product.eligible)
            self.assertEqual(product.reason, reason)

    def test_representative_model_and_unmodified_antique_excluded(self):
        for excluded in ('代表ページ', 'モデルガン', '火縄銃', '管打銃', '登録証付古式銃'):
            html = CATEGORY.replace('フィンランド マキシム M/09-21 重機関銃 (#64387)', excluded)
            self.assertEqual(parse_category(html).products[0].reason, "excluded_title")

    def test_detail_sku_mismatch_fails(self):
        with self.assertRaises(SiteError):
            parse_detail(DETAIL, replace(self.product, sku="99999"))

    def test_missing_stock_status_requires_review(self):
        html = DETAIL.replace('<dd id="spec_stock_msg">0</dd>', '')
        html = html.replace('<div class="block-icon"><img alt="お客様ご連絡中"></div>', '')
        product = parse_detail(html, self.product)
        self.assertFalse(product.eligible)
        self.assertEqual(product.reason, "missing_status")
        self.assertEqual(product.status, "状態不明")

    def test_partial_or_duplicate_full_baseline_is_never_success(self):
        # One factual card cannot cover the advertised 548 products. All pages
        # returning that same card must fail rather than recording a baseline.
        class RepeatedClient(SiteClient):
            def _get(self, url):
                if url == CATEGORY_URL:
                    return CATEGORY
                number = url.rsplit('_p', 1)[1].split('/')[0]
                return CATEGORY.replace('<span>1</span>', f'<span>{number}</span>')
        with self.assertRaises(SiteError):
            RepeatedClient().scan(baseline=True)


if __name__ == "__main__":
    unittest.main()
