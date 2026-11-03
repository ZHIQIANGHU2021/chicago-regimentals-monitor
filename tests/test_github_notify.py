import unittest
from unittest.mock import Mock, patch

import requests

from github_notify import GitHubNotifier, NotifyError


def response(status=200, data=None, headers=None):
    result = Mock()
    result.status_code = status
    result.json.return_value = data
    result.headers = headers or {}
    return result


class GitHubNotifierTests(unittest.TestCase):
    def setUp(self):
        self.session = Mock()
        self.notifier = GitHubNotifier("secret-token", "owner/monitor", session=self.session)
        self.product = {
            "sku": "1234N", "title": "Bren", "url": "https://www.regimentals.jp/shop/g/g1234N/",
            "price_jpy": 100000, "branch": "東京店", "status": "販売中", "release_date": "2026-11-03",
        }

    def issue(self, number, marker=None):
        return {"body": marker or "unrelated", "state": "closed", "user": {"login": "github-actions[bot]"}, "html_url": f"https://github.com/owner/monitor/issues/{number}"}

    def test_closed_existing_issue_is_reused_without_another_email(self):
        marker = self.notifier._marker("sku", "1234N")
        self.session.get.return_value = response(data=[self.issue(7, marker)])
        self.assertEqual(self.notifier.send_product(self.product), "https://github.com/owner/monitor/issues/7")
        self.session.post.assert_not_called()
        self.assertEqual(self.session.get.call_args.kwargs["params"]["state"], "all")

    def test_all_pages_are_checked_before_creation(self):
        marker = self.notifier._marker("sku", "1234N")
        self.session.get.side_effect = [response(data=[self.issue(i) for i in range(100)]), response(data=[self.issue(101, marker)])]
        self.assertTrue(self.notifier.send_product(self.product).endswith("/101"))
        self.assertEqual(self.session.get.call_args_list[1].kwargs["params"]["page"], 2)
        self.session.post.assert_not_called()

    def test_timeout_after_acceptance_recovers_without_second_post(self):
        marker = self.notifier._marker("sku", "1234N")
        self.session.get.side_effect = [response(data=[]), response(data=[self.issue(8, marker)])]
        self.session.post.side_effect = requests.Timeout("secret-token should never be printed")
        self.assertTrue(self.notifier.send_product(self.product).endswith("/8"))
        self.assertEqual(self.session.post.call_count, 1)

    def test_failed_post_without_recovery_does_not_retry_or_expose_token(self):
        self.session.get.return_value = response(data=[])
        self.session.post.side_effect = requests.Timeout("secret-token")
        with self.assertRaises(NotifyError) as error:
            self.notifier.send_product(self.product)
        self.assertNotIn("secret-token", str(error.exception))
        self.assertEqual(self.session.post.call_count, 1)

    def test_success_assigns_and_mentions_owner(self):
        self.session.get.return_value = response(data=[])
        self.session.post.return_value = response(201, self.issue(9))
        self.assertTrue(self.notifier.send_product(self.product).endswith("/9"))
        args = self.session.post.call_args.kwargs
        self.assertEqual(args["json"]["assignees"], ["owner"])
        self.assertIn("@owner", args["json"]["body"])
        self.assertIn("¥100,000", args["json"]["body"])
        self.assertFalse(args["allow_redirects"])

    def test_deployment_test_has_independent_stable_marker(self):
        self.session.get.return_value = response(data=[])
        self.session.post.return_value = response(201, self.issue(10))
        self.notifier.send_test()
        payload = self.session.post.call_args.kwargs["json"]
        self.assertIn("不是新品通知", payload["body"])
        self.assertIn(self.notifier._marker("test", "deployment-v1"), payload["body"])

    def test_rate_limit_does_not_post(self):
        self.session.get.return_value = response(429, {}, {"Retry-After": "120"})
        with self.assertRaisesRegex(NotifyError, "retry after 120"):
            self.notifier.send_product(self.product)
        self.session.post.assert_not_called()
        self.assertEqual(self.session.get.call_count, 1)

    def test_unsafe_or_incomplete_products_fail_before_remote_call(self):
        for changed in ({"url": "https://example.com/shop/g/g1234/"}, {"price_jpy": None}, {"release_date": ""}):
            with self.subTest(changed=changed), self.assertRaises(NotifyError):
                self.notifier.send_product({**self.product, **changed})
        self.session.get.assert_not_called()
        self.session.post.assert_not_called()

    def test_external_mentions_are_neutralized(self):
        self.session.get.return_value = response(data=[])
        self.session.post.return_value = response(201, self.issue(11))
        self.notifier.send_product({**self.product, "title": "Title @someone [link](bad)"})
        body = self.session.post.call_args.kwargs["json"]["body"]
        self.assertNotIn("@someone", body)
        self.assertIn("＠someone", body)

    def test_stranger_cannot_suppress_notification_by_copying_marker(self):
        copied = self.issue(12, self.notifier._marker("sku", "1234N"))
        copied["user"] = {"login": "stranger"}
        self.session.get.return_value = response(data=[copied])
        self.session.post.return_value = response(201, self.issue(13))
        self.assertTrue(self.notifier.send_product(self.product).endswith("/13"))
        self.session.post.assert_called_once()


if __name__ == "__main__":
    unittest.main()
