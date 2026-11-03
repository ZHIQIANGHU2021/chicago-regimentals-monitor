"""Crash-safe catalogue monitoring; persist the outbox before sending notifications."""
from __future__ import annotations

import argparse
import copy
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys

JST = timezone(timedelta(hours=9))
RECENT_DAYS = 14
HEARTBEAT_HOURS = 6


class StateError(RuntimeError):
    pass


def initial_state():
    return {"version": 1, "initialized": False, "baseline_at": None,
            "baseline_max_sku": None, "seen": {}, "pending": {},
            "outbox": {}, "notified": {}, "last_success_heartbeat": None}


def stamp(now):
    return now.astimezone(timezone.utc).isoformat(timespec="seconds")


def numeric_sku(sku):
    match = re.fullmatch(r"g?(\d+)", str(sku), re.I)
    return int(match.group(1)) if match else None


def load_state(path):
    try:
        state = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise StateError("state.json is missing. Restore the committed state; do not silently reinitialize.") from exc
    except (ValueError, OSError) as exc:
        raise StateError("Cannot read a valid state.json; restore the last good committed state.") from exc
    if not isinstance(state, dict) or state.get("version") != 1:
        raise StateError("Unsupported state schema.")
    if type(state.get("initialized")) is not bool:
        raise StateError("Missing initialized flag.")
    for key in ("seen", "pending", "outbox", "notified"):
        if not isinstance(state.get(key), dict):
            raise StateError(f"Invalid state field: {key}.")
    if state["initialized"]:
        if not state["seen"] or type(state.get("baseline_max_sku")) is not int or not state.get("baseline_at"):
            raise StateError("Initialized state has lost its baseline.")
    elif any(state[key] for key in ("seen", "pending", "outbox", "notified")):
        raise StateError("Uninitialized state must be empty.")
    for key in ("baseline_at", "last_success_heartbeat"):
        value = state.get(key)
        if value is not None:
            try:
                parsed = datetime.fromisoformat(value)
                if parsed.tzinfo is None:
                    raise ValueError("timezone required")
            except (TypeError, ValueError) as exc:
                raise StateError(f"Invalid timestamp: {key}.") from exc
    for sku, entry in state["outbox"].items():
        if not isinstance(entry, dict) or str(entry.get("sku")) != sku:
            raise StateError("Invalid outbox entry.")
    return state


def save_state(path, state):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def product_dict(product):
    return asdict(product) if is_dataclass(product) else dict(product)


def _hold(state, product, reason, now):
    sku = str(product["sku"])
    old = state["pending"].get(sku, {})
    state["pending"][sku] = {"product": product, "reason": reason,
                             "first_seen": old.get("first_seen", stamp(now))}


def scan_state(state, site, now=None):
    """Return a new state only after every required HTTP/parse operation succeeds."""
    now = now or datetime.now(timezone.utc)
    updated = copy.deepcopy(state)
    baseline = not state["initialized"]
    products = site.scan(baseline=baseline)
    if not products:
        raise StateError("Empty category scan is not a successful baseline or monitoring result.")
    listed = {str(product_dict(p)["sku"]): p for p in products}
    if baseline:
        numbers = [number for sku in listed if (number := numeric_sku(sku)) is not None]
        if not numbers:
            raise StateError("No numeric catalogue identities in baseline.")
        updated["seen"] = {sku: stamp(now) for sku in listed}
        updated.update(initialized=True, baseline_at=stamp(now), baseline_max_sku=max(numbers),
                       last_success_heartbeat=stamp(now))
        print(f"Silent baseline: {len(listed)} catalogue identities; no old-item notifications.")
        return updated

    for sku, listing in listed.items():
        if sku in updated["notified"] or sku in updated["outbox"]:
            continue
        was_seen = sku in state["seen"]
        pending = state["pending"].get(sku)
        if was_seen and not pending:
            continue  # includes all pre-baseline stock, even if repriced/relisted
        candidate = product_dict(listing)
        updated["seen"].setdefault(sku, stamp(now))
        number = numeric_sku(sku)
        if number is None or number <= state["baseline_max_sku"]:
            _hold(updated, candidate, "old_sku_needs_official_new_arrival_evidence", now)
            continue
        if str(candidate.get("reason", "")).startswith("excluded_"):
            _hold(updated, candidate, candidate["reason"], now)
            continue
        candidate = product_dict(site.detail(listing))
        if str(candidate.get("sku")) != sku:
            raise StateError("Detail SKU differs from listing SKU.")
        reason = None
        if not candidate.get("eligible"):
            reason = candidate.get("reason") or "detail_not_verified"
        required = ("title", "url", "branch", "status", "release_date")
        if not all(candidate.get(key) for key in required):
            reason = reason or "missing_required_metadata"
        if type(candidate.get("price_jpy")) is not int or candidate["price_jpy"] <= 0:
            reason = reason or "missing_tax_inclusive_price"
        try:
            released = date.fromisoformat((candidate.get("release_date") or "").split("T", 1)[0])
            today = now.astimezone(JST).date()
            if not today - timedelta(days=RECENT_DAYS) <= released <= today:
                reason = reason or "release_date_not_recent"
        except (TypeError, ValueError):
            reason = reason or "missing_release_date"
        if reason:
            _hold(updated, candidate, reason, now)
            continue
        candidate["detected_at"] = stamp(now)
        updated["outbox"][sku] = candidate
        updated["pending"].pop(sku, None)

    last = updated.get("last_success_heartbeat")
    if last is None or now - datetime.fromisoformat(last) >= timedelta(hours=HEARTBEAT_HOURS):
        updated["last_success_heartbeat"] = stamp(now)
    print(f"Successful scan: {len(listed)} identities; {len(updated['outbox'])} queued; {len(updated['pending'])} held for review.")
    return updated


def deliver(state, notifier, path):
    if not state["initialized"]:
        raise StateError("Notifications require a completed baseline.")
    for sku, product in list(state["outbox"].items()):
        issue_url = notifier.send_product(product)
        state["notified"][sku] = {"issue_url": issue_url, "notified_at": stamp(datetime.now(timezone.utc))}
        del state["outbox"][sku]
        save_state(path, state)  # each accepted send survives a later partial failure
        print(f"Notification recorded: SKU {sku} -> {issue_url}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("scan", "notify"), nargs="?", default="scan")
    parser.add_argument("--state", default="state.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--test-notification", action="store_true")
    args = parser.parse_args(argv)
    state = load_state(args.state)
    if args.dry_run and args.test_notification:
        parser.error("--dry-run cannot send a test notification")
    if args.test_notification:
        if not state["initialized"]:
            raise StateError("Run and persist a successful baseline before testing notifications.")
        from github_notify import GitHubNotifier
        print("Deployment test: " + GitHubNotifier().send_test())
    elif args.command == "scan":
        from regimentals_site import SiteClient
        updated = scan_state(state, SiteClient())
        if args.dry_run:
            print("Dry run: no notifications and no state writes.")
        elif updated != state:
            save_state(args.state, updated)
    elif not args.dry_run:
        from github_notify import GitHubNotifier
        deliver(state, GitHubNotifier(), args.state)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # Do not dump HTTP bodies, credential-bearing request objects, or secrets.
        print(f"Monitor failed ({type(exc).__name__}): {exc}", file=sys.stderr)
        sys.exit(1)
