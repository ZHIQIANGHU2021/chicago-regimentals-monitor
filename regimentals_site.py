"""Read-only parser for the official 無可動実銃 catalogue.

Selectors verified against official HTML on 2026-11-03. Structural/network
failures raise SiteError; they must never be interpreted as an empty catalogue.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
import math
import re
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://www.regimentals.jp"
CATEGORY_URL = BASE_URL + "/shop/c/c10_srd/"
SKU_PATH = re.compile(r"^/shop/g/g([A-Za-z0-9_-]+)/?$")
PAGE_PATH = re.compile(r"^/shop/c/c10_srd(?:_p(\d+))?/$")
EXCLUDED_TITLE = re.compile(
    r"代表ページ|代表頁|モデルガン|模型|レプリカ|登録証|火縄|管打|"
    r"パーカッション|フリントロック|非無可動|未加工"
)


class SiteError(RuntimeError):
    """A request or structural validation failed."""


@dataclass(frozen=True)
class Product:
    sku: str
    title: str
    url: str
    price_jpy: int | None = None
    branch: str = ""
    status: str = ""
    release_date: str | None = None
    eligible: bool = False
    reason: str = "detail_not_checked"
    category: str = "無可動実銃"


@dataclass(frozen=True)
class CategoryPage:
    products: list[Product]
    total_count: int
    total_pages: int
    current_page: int


def _text(node) -> str:
    return node.get_text(" ", strip=True) if node else ""


def _official_url(href: str) -> str:
    parsed = urlparse(urljoin(BASE_URL, href))
    if parsed.scheme != "https" or parsed.hostname not in {
        "www.regimentals.jp", "regimentals.jp"
    } or parsed.username or parsed.password:
        raise SiteError("Unexpected non-official URL in catalogue")
    return BASE_URL + parsed.path


def _price(node) -> int | None:
    value = _text(node)
    match = re.fullmatch(r"[￥¥]\s*([\d,]+)", value)
    return int(match.group(1).replace(",", "")) if match else None


def _branch(text: str) -> str:
    match = re.search(r"(東京店|大阪店)", text)
    return match.group(1) if match else ""


def _status(container, stock: str, variation: str = "") -> str:
    labels = [img.get("alt", "") for img in container.select(".block-icon img")]
    if "商談中" in variation:
        return "商談中"
    for label in labels:
        if any(word in label for word in ("連絡中", "予約", "商談", "売約", "販売済")):
            return label
    if stock.isdigit():
        return "在庫あり" if int(stock) > 0 else "在庫なし"
    return stock or "状態不明"


def _soup(html: str) -> BeautifulSoup:
    soup = BeautifulSoup(html, "html.parser")
    title = _text(soup.title).lower()
    if any(marker in title for marker in (
        "access denied", "just a moment", "captcha", "error", "メンテナンス"
    )):
        raise SiteError("Official site returned an error or challenge page")
    return soup


def parse_category(html: str, page_number: int = 1) -> CategoryPage:
    soup = _soup(html)
    if _text(soup.select_one("h1.block-category-list--header")) != "無可動実銃":
        raise SiteError("Expected the exact 無可動実銃 category")
    if _text(soup.select_one(".block-goods-list--sort-order-items dd.active")) != "発売日":
        raise SiteError("Catalogue is not sorted by 発売日")
    count = _text(soup.select_one(".pager-count > span"))
    current = _text(soup.select_one(".pager-current > span"))
    if not count.isdigit() or not current.isdigit() or int(current) != page_number:
        raise SiteError("Missing or unexpected catalogue pagination")
    total_count = int(count)
    if not 1 <= total_count <= 100_000:
        raise SiteError("Unexpected empty or oversized catalogue")
    numbers = [page_number]
    for anchor in soup.select(".pagination a[href]"):
        path = urlparse(_official_url(anchor["href"])).path
        match = PAGE_PATH.fullmatch(path)
        if not match:
            raise SiteError("Unexpected category or sort in pagination")
        numbers.append(int(match.group(1) or 1))
    total_pages = max(numbers)
    if not 1 <= total_pages <= 200:
        raise SiteError("Unexpected catalogue page count")
    cards = soup.select(".block-goods-list-d--items > li")
    if not cards:
        raise SiteError("Catalogue cards missing")
    products = []
    seen = set()
    for card in cards:
        anchor = card.select_one(".block-goods-list-d--goods-name a[href]")
        if not anchor or not _text(anchor):
            raise SiteError("A catalogue card has no product identity")
        url = _official_url(anchor["href"])
        match = SKU_PATH.fullmatch(urlparse(url).path)
        if not match:
            raise SiteError("Unexpected product detail URL")
        sku = match.group(1)
        if sku in seen:
            raise SiteError("Duplicate product identity within catalogue page")
        seen.add(sku)
        category = anchor.get("data-category", "")
        if category != "無可動実銃(10)":
            raise SiteError("A card is outside the exact 無可動実銃 category")
        comment = _text(card.select_one(".block-goods-list-d--goods-comment"))
        comment_sku = re.search(r"商品番号\s*[:：]\s*([A-Za-z0-9_-]+)", comment)
        if not comment_sku or comment_sku.group(1) != sku:
            raise SiteError("Product URL and printed SKU disagree")
        title = _text(anchor)
        variation = _text(card.select_one(".variation-name"))
        reason = "excluded_title" if EXCLUDED_TITLE.search(title) else "detail_not_checked"
        products.append(Product(
            sku=sku, title=title, url=url,
            price_jpy=_price(card.select_one(".block-goods-list-d--price")),
            branch=_branch(comment + " " + variation),
            status=_status(card, _text(card.select_one(".block-goods-list-d--stock")), variation),
            reason=reason,
        ))
    return CategoryPage(products, total_count, total_pages, page_number)


def parse_detail(html: str, product: Product) -> Product:
    soup = _soup(html)
    title_node = soup.select_one("h1.block-goods-name--text")
    sku = _text(soup.select_one("#spec_goods"))
    if not title_node or not sku:
        raise SiteError("Product detail identity missing")
    if sku != product.sku:
        raise SiteError("Product detail SKU changed or redirected")
    title = _text(title_node)
    breadcrumbs = soup.select("#bread-crumb-list a[href]")
    categories = {urlparse(_official_url(a["href"])).path: _text(a) for a in breadcrumbs}
    if categories.get("/shop/c/c10/") != "無可動実銃":
        return replace(product, eligible=False, reason="excluded_detail_category")
    if EXCLUDED_TITLE.search(title):
        return replace(product, title=title, eligible=False, reason="excluded_title")
    # Require item-specific positive evidence. A header/footer link saying 無可動
    # does not prove that an antique or training item has been deactivated.
    description = _text(soup.select_one(".block-goods-comment6"))
    deactivated = re.search(
        r"本ページに掲載の商品は[、,]?\s*日本国内の基準に準じた加工が施された無可動実銃です",
        description,
    )
    release = _text(soup.select_one("#spec_release_dt"))
    try:
        release_date = datetime.strptime(release, "%Y/%m/%d %H:%M:%S").isoformat()
    except ValueError:
        release_date = None
    branch = _branch(_text(soup.select_one("#spec_variation_name2")))
    price = _price(soup.select_one(".block-goods-price--price"))
    # The website's gross price is followed by a separately labelled net price.
    # Require that distinction rather than silently relabelling a net quote.
    net_node = soup.select_one(".block-goods-price--net-price")
    gross_confirmed = bool(net_node and re.fullmatch(r"税抜\s*[￥¥]\s*[\d,]+", _text(net_node)))
    status = _status(soup.select_one(".pane-goods-right-side") or soup,
                     _text(soup.select_one("#spec_stock_msg")),
                     _text(soup.select_one("#spec_variation_name2")))
    reason = (
        "missing_deactivation_evidence" if not deactivated else
        "missing_release_date" if release_date is None else
        "missing_branch" if not branch else
        "missing_tax_inclusive_price" if price is None or not gross_confirmed else
        "missing_status" if not status or status == "状態不明" else
        "verified"
    )
    return replace(
        product, title=title, price_jpy=price, branch=branch,
        status=status,
        release_date=release_date, eligible=(reason == "verified"), reason=reason,
    )


class SiteClient:
    def __init__(self, session=None, *, timeout: int = 25, delay: float = 0.2):
        self.session = session or requests.Session()
        self.timeout = timeout
        self.delay = delay
        if session is None:
            retries = Retry(total=2, backoff_factor=0.5,
                            status_forcelist=(429, 500, 502, 503, 504),
                            allowed_methods=("GET",), respect_retry_after_header=False)
            self.session.mount("https://", HTTPAdapter(max_retries=retries))
            self.session.headers.update({
                "User-Agent": "ChicagoCatalogueMonitor/1.0 (read-only; 5-minute minimum interval)",
                "Accept-Language": "ja,en;q=0.5",
            })

    def _get(self, url: str) -> str:
        requested = _official_url(url)
        try:
            response = self.session.get(requested, timeout=self.timeout)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise SiteError(f"Official catalogue request failed: {type(exc).__name__}") from exc
        actual = _official_url(response.url)
        if actual != requested:
            raise SiteError("Unexpected redirect from official catalogue page")
        if "text/html" not in response.headers.get("Content-Type", "").lower():
            raise SiteError("Official site did not return HTML")
        response.encoding = "utf-8"
        if self.delay:
            time.sleep(self.delay)
        return response.text

    def scan(self, baseline: bool = False) -> list[Product]:
        first = parse_category(self._get(CATEGORY_URL))
        pages = first.total_pages if baseline else min(first.total_pages, 3)
        products = list(first.products)
        per_page = len(first.products)
        if math.ceil(first.total_count / per_page) != first.total_pages:
            raise SiteError("First catalogue page is incomplete or pagination changed")
        for page_number in range(2, pages + 1):
            url = BASE_URL + f"/shop/c/c10_srd_p{page_number}/"
            page = parse_category(self._get(url), page_number)
            if page.total_count != first.total_count or page.total_pages != first.total_pages:
                raise SiteError("Catalogue pagination changed during scan; retry required")
            expected = min(per_page, first.total_count - per_page * (page_number - 1))
            if len(page.products) != expected:
                raise SiteError("Catalogue page is incomplete")
            products.extend(page.products)
        skus = [p.sku for p in products]
        if len(set(skus)) != len(skus):
            raise SiteError("Products moved across pages during scan; retry required")
        if baseline and len(products) != first.total_count:
            raise SiteError("Silent baseline did not cover the full catalogue")
        return products

    def detail(self, product: Product) -> Product:
        if product.reason.startswith("excluded_"):
            return product
        return parse_detail(self._get(product.url), product)
