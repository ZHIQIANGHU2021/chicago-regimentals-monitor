"""Send owner-assigned GitHub Issues; GitHub delivers notification emails.

No Gmail credentials are needed. Delivery depends on the recipient's GitHub
notification settings and verified notification email, and is tested separately.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from urllib.parse import urlparse

import requests


class NotifyError(RuntimeError):
    """An issue notification could not be confirmed; safe to retry next run."""


def _plain(value: object) -> str:
    """Render external product text without creating mentions or Markdown links."""
    text = re.sub(r"[\r\n\t]+", " ", str(value)).strip()
    return text.replace("@", "＠").replace("`", "｀").replace("<", "＜").replace(">", "＞").replace("[", "［").replace("]", "］")


class GitHubNotifier:
    API = "https://api.github.com"

    def __init__(self, token=None, repository=None, notify_user=None, session=None):
        self.token = token or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        self.repository = repository or os.environ.get("GITHUB_REPOSITORY", "")
        if not self.token:
            raise NotifyError("GitHub token is missing")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.repository):
            raise NotifyError("GITHUB_REPOSITORY must be owner/name")
        self.notify_user = notify_user or os.environ.get("MONITOR_NOTIFY_USER") or self.repository.split("/")[0]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", self.notify_user):
            raise NotifyError("Notification recipient must be one GitHub login")
        self.session = session or requests.Session()
        self.headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "chicago-regimentals-monitor",
        }

    @staticmethod
    def _marker(kind: str, identity: str) -> str:
        digest = hashlib.sha256(identity.strip().upper().encode("utf-8")).hexdigest()
        return f"<!-- chicago-monitor:{kind}:{digest} -->"

    def _request(self, method, *, params=None, json=None):
        """Fixed API destination; redirects are forbidden to protect the token."""
        kwargs = {"headers": self.headers, "timeout": (10, 30), "allow_redirects": False}
        if params is not None:
            kwargs["params"] = params
        if json is not None:
            kwargs["json"] = json
        return getattr(self.session, method)(f"{self.API}/repos/{self.repository}/issues", **kwargs)

    @staticmethod
    def _status_error(response):
        if response.status_code in (403, 429):
            retry = response.headers.get("Retry-After", "")
            suffix = f"; retry after {retry} seconds" if retry.isdigit() else ""
            return NotifyError(f"GitHub refused the request (HTTP {response.status_code}){suffix}")
        return NotifyError(f"GitHub request failed (HTTP {response.status_code})")

    def _get_page(self, page):
        # Only read requests may be retried directly. Rate limits are left for the
        # next scheduled run rather than repeatedly consuming the same limit.
        for attempt in range(2):
            try:
                response = self._request("get", params={"state": "all", "per_page": 100, "page": page})
            except requests.RequestException:
                if attempt == 0:
                    time.sleep(1)
                    continue
                raise NotifyError("GitHub issue lookup failed due to a network error") from None
            if 500 <= response.status_code <= 599 and attempt == 0:
                time.sleep(1)
                continue
            if response.status_code != 200:
                raise self._status_error(response)
            try:
                items = response.json()
            except (ValueError, TypeError):
                raise NotifyError("GitHub issue lookup returned invalid JSON") from None
            if not isinstance(items, list):
                raise NotifyError("GitHub issue lookup returned an unexpected result")
            return items
        raise NotifyError("GitHub issue lookup failed")

    def _issue_url(self, issue):
        url = issue.get("html_url", "")
        expected = f"https://github.com/{self.repository}/issues/"
        if not isinstance(url, str) or not url.startswith(expected) or not url[len(expected):].isdigit():
            raise NotifyError("GitHub returned an unexpected issue URL")
        return url

    def _find(self, marker):
        # state=all includes closed issues. Never follow an API-supplied Link URL
        # with credentials; construct each page against our fixed API endpoint.
        for page in range(1, 1001):
            issues = self._get_page(page)
            for issue in issues:
                if not isinstance(issue, dict):
                    raise NotifyError("GitHub issue lookup contained an invalid item")
                # Public repositories accept issues from strangers. Their copied
                # marker must not be able to suppress a genuine notification.
                author = (issue.get("user") or {}).get("login", "").lower()
                trusted = {"github-actions[bot]", self.repository.split("/")[0].lower()}
                if "pull_request" not in issue and author in trusted and marker in (issue.get("body") or ""):
                    return self._issue_url(issue)
            if len(issues) < 100:
                return None
        raise NotifyError("GitHub issue lookup exceeded the pagination safety limit")

    def _send(self, title, body, marker):
        existing = self._find(marker)
        if existing:
            return existing
        payload = {"title": title[:240], "body": body + "\n\n" + marker, "assignees": [self.notify_user]}
        try:
            response = self._request("post", json=payload)
        except requests.RequestException:
            # A timeout may happen after GitHub accepts the issue. Look it up
            # before returning failure; never blindly repeat the POST.
            recovered = self._find(marker)
            if recovered:
                return recovered
            raise NotifyError("GitHub issue creation was not confirmed; POST was not repeated") from None
        if response.status_code != 201:
            recovered = self._find(marker)
            if recovered:
                return recovered
            raise self._status_error(response)
        try:
            issue = response.json()
        except (ValueError, TypeError):
            issue = None
        if not isinstance(issue, dict):
            recovered = self._find(marker)
            if recovered:
                return recovered
            raise NotifyError("GitHub issue creation returned invalid JSON; POST was not repeated")
        return self._issue_url(issue)

    def send_product(self, product: dict) -> str:
        required = ("sku", "title", "url", "price_jpy", "branch", "status", "release_date")
        if not isinstance(product, dict) or any(product.get(k) in (None, "") for k in required):
            raise NotifyError("Confirmed product is missing required notification fields")
        parsed = urlparse(str(product["url"]))
        if parsed.scheme != "https" or parsed.netloc not in ("regimentals.jp", "www.regimentals.jp") or not parsed.path.startswith("/shop/g/") or re.search(r"[\s()<>]", str(product["url"])):
            raise NotifyError("Product URL must be an official Regimentals product page")
        price = product["price_jpy"]
        if isinstance(price, bool) or not isinstance(price, int) or price <= 0:
            raise NotifyError("Confirmed product must have a positive integer tax-inclusive price")
        sku = _plain(product["sku"])
        name = _plain(product["title"])
        focus = "⭐ " if re.search(r"MG\s*34|MG\s*42|M\s*53|ZB\s*26|BREN|MAXIM|BAR|PPS\s*43", name, re.I) else ""
        title = f"{focus}无可动实銃新上架｜{name}｜{sku}"
        body = (
            f"@{self.notify_user}，官网「無可動実銃」分类首次发现并确认以下商品。\n\n"
            f"- 型号：{name}\n"
            f"- SKU：{sku}\n"
            f"- 含税价格：¥{price:,} JPY\n"
            f"- 分店：{_plain(product['branch'])}\n"
            f"- 状态：{_plain(product['status'])}\n"
            f"- 発売日：{_plain(product['release_date'])}\n\n"
            f"[查看官方商品页]({product['url']})\n\n"
            "此通知仅对应已永久去除发射功能的收藏展示品。"
        )
        return self._send(title, body, self._marker("sku", str(product["sku"])))

    def send_test(self, test_id: str = "deployment-v1") -> str:
        if not isinstance(test_id, str) or not test_id.strip():
            raise NotifyError("Deployment test ID is required")
        body = (
            f"@{self.notify_user}，这是监控部署的邮件送达测试，**不是新品通知**。\n\n"
            "若在 Gmail 收到这条 GitHub 通知，说明 GitHub → Gmail 通道已送达。\n"
            "新品通知只会在无可动实銃分类出现已确认的新 SKU 时发送；首次扫描的旧商品不会推送。\n\n"
            "计划检查间隔不等于送达保证；GitHub Actions 调度和邮件传递可能延迟。"
        )
        return self._send("[部署测试] 芝加哥无可动实銃监控邮件", body, self._marker("test", test_id))
