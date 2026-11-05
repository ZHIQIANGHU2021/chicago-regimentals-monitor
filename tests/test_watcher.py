import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import watcher

NOW = datetime(2026, 11, 3, 1, 0, tzinfo=timezone.utc)


def product(sku='101', **changes):
    value = dict(sku=sku, title='Deactivated collector item',
                 url='https://www.regimentals.jp/shop/g/g' + sku + '/',
                 price_jpy=100000, branch='東京店', status='在庫あり',
                 release_date='2026-11-02T19:15:00', eligible=True,
                 reason='', category='無可動実銃')
    value.update(changes)
    return value


def baseline():
    state = watcher.initial_state()
    site = Mock()
    site.scan.return_value = [product('100')]
    return watcher.scan_state(state, site, NOW)


class WatcherTests(unittest.TestCase):
    def test_baseline_is_silent_and_covers_excluded_identities(self):
        site = Mock()
        site.scan.return_value = [product('100'), product('102', eligible=False, reason='excluded_model')]
        result = watcher.scan_state(watcher.initial_state(), site, NOW)
        self.assertEqual(result['baseline_max_sku'], 102)
        self.assertEqual(set(result['seen']), {'100', '102'})
        self.assertFalse(result['outbox'])
        site.detail.assert_not_called()
        site.scan.assert_called_once_with(baseline=True)

    def test_full_scan_failure_does_not_change_state(self):
        original = baseline()
        before = copy.deepcopy(original)
        site = Mock()
        site.scan.side_effect = RuntimeError('network unavailable')
        with self.assertRaises(RuntimeError):
            watcher.scan_state(original, site, NOW)
        self.assertEqual(original, before)

    def test_detail_failure_after_valid_candidate_does_not_change_state(self):
        original = baseline()
        before = copy.deepcopy(original)
        site = Mock()
        site.scan.return_value = [product('101'), product('102')]
        site.detail.side_effect = [product('101'), RuntimeError('network unavailable')]
        with self.assertRaises(RuntimeError):
            watcher.scan_state(original, site, NOW)
        self.assertEqual(original, before)

    def test_actual_parser_iso_datetime_queues_recent_new_sku(self):
        site = Mock()
        site.scan.return_value = [product()]
        site.detail.return_value = product()
        result = watcher.scan_state(baseline(), site, NOW)
        self.assertIn('101', result['outbox'])
        self.assertFalse(result['notified'])

    def test_old_sku_is_held_without_automatic_notification(self):
        site = Mock()
        site.scan.return_value = [product('90')]
        result = watcher.scan_state(baseline(), site, NOW)
        self.assertIn('90', result['pending'])
        self.assertFalse(result['outbox'])
        site.detail.assert_not_called()

    def test_prebaseline_stock_is_never_notified_after_price_change(self):
        site = Mock()
        site.scan.return_value = [product('100', price_jpy=200000)]
        result = watcher.scan_state(baseline(), site, NOW)
        self.assertFalse(result['outbox'])
        site.detail.assert_not_called()

    def test_missing_metadata_candidate_can_be_corrected_later(self):
        site = Mock()
        site.scan.return_value = [product()]
        site.detail.return_value = product(eligible=False, release_date=None, reason='missing_release_date')
        first = watcher.scan_state(baseline(), site, NOW)
        self.assertIn('101', first['pending'])
        self.assertFalse(first['outbox'])
        site.detail.return_value = product()
        second = watcher.scan_state(first, site, NOW + timedelta(minutes=5))
        self.assertIn('101', second['outbox'])
        self.assertNotIn('101', second['pending'])

    def test_existing_vz37_pending_recovers_when_date_only_release_is_parsed(self):
        state = baseline()
        state['baseline_max_sku'] = 10396
        first_seen = '2026-11-04T11:13:25+00:00'
        held = product('10397', title='Vz.37 重機関銃 #1436',
                       release_date=None, eligible=False, reason='missing_release_date')
        state['seen']['10397'] = first_seen
        state['pending']['10397'] = {
            'product': held, 'reason': 'missing_release_date', 'first_seen': first_seen}
        state['notified']['10390'] = {'issue_url': 'https://github.com/a/b/issues/4'}
        prior_notified = copy.deepcopy(state['notified'])
        prior_baseline = (state['baseline_at'], state['baseline_max_sku'])
        site = Mock()
        site.scan.return_value = [held]
        site.detail.return_value = product('10397', title='Vz.37 重機関銃 #1436',
                                           release_date='2026-11-04')
        run_at = datetime(2026, 11, 5, 1, 0, tzinfo=timezone.utc)
        recovered = watcher.scan_state(state, site, run_at)
        self.assertEqual(set(recovered['outbox']), {'10397'})
        self.assertNotIn('10397', recovered['pending'])
        self.assertEqual(recovered['seen']['10397'], first_seen)
        self.assertEqual(recovered['notified'], prior_notified)
        self.assertEqual((recovered['baseline_at'], recovered['baseline_max_sku']), prior_baseline)
        repeated = watcher.scan_state(recovered, site, run_at + timedelta(minutes=5))
        self.assertEqual(repeated['outbox'], recovered['outbox'])
        site.detail.assert_called_once()

    def test_notified_sku_and_pending_outbox_are_not_reprocessed(self):
        state = baseline()
        state['notified']['101'] = {'issue_url': 'https://github.com/a/b/issues/1'}
        state['outbox']['102'] = product('102')
        site = Mock()
        site.scan.return_value = [product('101'), product('102')]
        result = watcher.scan_state(state, site, NOW)
        self.assertEqual(set(result['outbox']), {'102'})
        site.detail.assert_not_called()

    def test_future_stale_and_unverified_products_are_held(self):
        for changes in ({'release_date': '2026-11-04T12:00:00'},
                        {'release_date': '2026-10-01T12:00:00'},
                        {'eligible': False, 'reason': 'missing_deactivation_evidence'},
                        {'price_jpy': None}, {'branch': ''}):
            with self.subTest(changes=changes):
                site = Mock()
                site.scan.return_value = [product()]
                site.detail.return_value = product(**changes)
                result = watcher.scan_state(baseline(), site, NOW)
                self.assertFalse(result['outbox'])
                self.assertIn('101', result['pending'])

    def test_release_today_in_japan_is_accepted_before_utc_midnight(self):
        now = datetime(2026, 11, 2, 16, 0, tzinfo=timezone.utc)
        site = Mock()
        site.scan.return_value = [product()]
        site.detail.return_value = product(release_date='2026-11-03T00:15:00')
        self.assertIn('101', watcher.scan_state(baseline(), site, now)['outbox'])

    def test_unchanged_poll_only_updates_six_hour_heartbeat(self):
        state = baseline()
        site = Mock()
        site.scan.return_value = [product('100')]
        self.assertEqual(state, watcher.scan_state(state, site, NOW + timedelta(minutes=5)))
        later = watcher.scan_state(state, site, NOW + timedelta(hours=6))
        self.assertNotEqual(state['last_success_heartbeat'], later['last_success_heartbeat'])

    def test_partial_notification_failure_persists_completed_sends(self):
        state = baseline()
        state['outbox'] = {'101': product('101'), '102': product('102')}
        notifier = Mock()
        notifier.send_product.side_effect = ['https://github.com/a/b/issues/1', RuntimeError('temporary failure')]
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            path = Path(directory) / 'state.json'
            watcher.save_state(path, state)
            with self.assertRaises(RuntimeError):
                watcher.deliver(state, notifier, path)
            restored = watcher.load_state(path)
            self.assertIn('101', restored['notified'])
            self.assertEqual(set(restored['outbox']), {'102'})
            notifier.send_product.side_effect = None
            notifier.send_product.return_value = 'https://github.com/a/b/issues/2'
            watcher.deliver(restored, notifier, path)
            self.assertFalse(watcher.load_state(path)['outbox'])

    def test_missing_corrupt_and_damaged_baseline_fail_closed(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            path = Path(directory) / 'state.json'
            with self.assertRaises(watcher.StateError):
                watcher.load_state(path)
            path.write_text('{broken', encoding='utf-8')
            with self.assertRaises(watcher.StateError):
                watcher.load_state(path)
            value = baseline()
            value['seen'] = {}
            path.write_text(json.dumps(value), encoding='utf-8')
            with self.assertRaises(watcher.StateError):
                watcher.load_state(path)

    def test_dry_run_never_writes_or_sends(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            path = Path(directory) / 'state.json'
            watcher.save_state(path, watcher.initial_state())
            original = path.read_bytes()
            fake_site = Mock()
            fake_site.scan.return_value = [product('100')]
            with patch('regimentals_site.SiteClient', return_value=fake_site):
                self.assertEqual(watcher.main(['--state', str(path), '--dry-run']), 0)
            self.assertEqual(path.read_bytes(), original)
            fake_site.detail.assert_not_called()


if __name__ == '__main__':
    unittest.main()
