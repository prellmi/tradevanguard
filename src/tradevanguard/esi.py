"""Minimal async client for the public market endpoints of the EVE Swagger Interface (ESI).

Follows ESI etiquette: identifying User-Agent, honours ``Expires`` via an
on-disk cache, backs off on the error limit and on rate limiting.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import time
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

from .models import Order

ESI_BASE = "https://esi.evetech.net"
COMPATIBILITY_DATE = "2026-08-18"
HISTORY_KEEP_DAYS = 90
# Stop sending requests when fewer errors than this remain in the current window.
ERROR_LIMIT_FLOOR = 20


class ESIError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class ESIClient:
    def __init__(self, cache_dir: Path, user_agent: str, concurrency: int = 16):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._client = httpx.AsyncClient(
            base_url=ESI_BASE,
            headers={
                "User-Agent": user_agent,
                "X-Compatibility-Date": COMPATIBILITY_DATE,
                "Accept": "application/json",
            },
            timeout=30,
        )
        self._semaphore = asyncio.Semaphore(concurrency)
        self._pause_until = 0.0  # time.monotonic() before which no request may be sent
        self._history: dict[int, dict[int, tuple[float, list[list]]]] = {}  # region -> type -> (expires, rows)

    async def __aenter__(self) -> ESIClient:
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _get(self, path: str, params: dict) -> httpx.Response:
        for attempt in range(5):
            delay = self._pause_until - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            async with self._semaphore:
                try:
                    resp = await self._client.get(path, params=params)
                except httpx.TransportError:
                    await asyncio.sleep(2**attempt)
                    continue
            self._track_error_limit(resp)

            if resp.status_code == 200:
                return resp
            if resp.status_code in (420, 429):
                wait = float(resp.headers.get("Retry-After", 60))
                self._pause_until = max(self._pause_until, time.monotonic() + wait)
                continue
            if resp.status_code >= 500:
                await asyncio.sleep(2**attempt)
                continue
            raise ESIError(f"ESI {resp.status_code} for {path} {params}: {resp.text[:200]}", resp.status_code)
        raise ESIError(f"ESI request {path} {params} failed after retries")

    def _track_error_limit(self, resp: httpx.Response) -> None:
        remain = resp.headers.get("X-Esi-Error-Limit-Remain")
        if remain is not None and int(remain) < ERROR_LIMIT_FLOOR:
            reset = int(resp.headers.get("X-Esi-Error-Limit-Reset", 60))
            self._pause_until = max(self._pause_until, time.monotonic() + reset)

    async def region_orders(self, region_id: int) -> tuple[list[Order], float]:
        """All buy and sell orders in a region plus their expiry (epoch seconds).

        Served from the disk cache while ESI's copy is still current.
        """
        cache_file = self.cache_dir / f"orders-{region_id}.json.gz"
        cached = _read_cache(cache_file)
        if cached is not None:
            return [Order(*o) for o in cached["data"]], cached["expires"]

        # ESI may refresh the data while we page through it; retry for a consistent snapshot.
        for _ in range(3):
            orders, expires, consistent = await self._fetch_region(region_id)
            if consistent:
                break
        _write_cache(cache_file, expires, orders)
        return orders, expires

    async def average_prices(self) -> tuple[dict[int, float], float]:
        """CCP's universe-wide average price per type (one request for all items), plus expiry."""
        cache_file = self.cache_dir / "prices.json.gz"
        cached = _read_cache(cache_file)
        if cached is None:
            resp = await self._get("/markets/prices/", {})
            data = [[p["type_id"], p["average_price"]] for p in resp.json() if p.get("average_price")]
            cached = {"data": data, "expires": _expires(resp)}
            _write_cache(cache_file, cached["expires"], data)
        return {type_id: price for type_id, price in cached["data"]}, cached["expires"]

    async def region_history(self, region_id: int, type_ids: Iterable[int]) -> dict[int, list[list]]:
        """Daily ``[date, average_price, volume]`` rows for the last HISTORY_KEEP_DAYS days per type.

        Days without trades are absent. ESI only serves history one type per
        request and refreshes it once a day at downtime, so each region's
        histories are kept in memory and in a single cache file.
        """
        cache = self._region_history_cache(region_id)
        now = time.time()
        wanted = set(type_ids)
        missing = [t for t in wanted if t not in cache or cache[t][0] <= now]
        if missing:
            fetched = await asyncio.gather(*(self._fetch_history(region_id, t) for t in missing))
            cache.update(zip(missing, fetched))
            # Prune expired entries so the file doesn't grow forever.
            live = {t: entry for t, entry in cache.items() if entry[0] > now}
            cache.clear()
            cache.update(live)
            _write_cache(self._history_file(region_id), max((e[0] for e in live.values()), default=now),
                         [[t, e, rows] for t, (e, rows) in live.items()])
        return {t: cache[t][1] for t in wanted}

    def _history_file(self, region_id: int) -> Path:
        return self.cache_dir / f"history-{region_id}.json.gz"

    def _region_history_cache(self, region_id: int) -> dict[int, tuple[float, list[list]]]:
        if region_id not in self._history:
            cached = _read_cache(self._history_file(region_id))
            self._history[region_id] = {t: (e, rows) for t, e, rows in cached["data"]} if cached else {}
        return self._history[region_id]

    async def _fetch_history(self, region_id: int, type_id: int) -> tuple[float, list[list]]:
        try:
            resp = await self._get(f"/markets/{region_id}/history/", {"type_id": type_id})
            expires = _expires(resp)
            raw = resp.json()
        except ESIError as exc:
            if exc.status != 404:  # 404 = not a market type; cache the empty answer
                raise
            raw, expires = [], time.time() + 86400
        cutoff = (datetime.now(UTC).date() - timedelta(days=HISTORY_KEEP_DAYS)).isoformat()
        return expires, [[d["date"], d["average"], d["volume"]] for d in raw if d["date"] >= cutoff]

    async def _fetch_region(self, region_id: int) -> tuple[list[Order], float, bool]:
        path = f"/markets/{region_id}/orders/"
        first = await self._get(path, {"order_type": "all", "page": 1})
        pages = int(first.headers.get("X-Pages", 1))
        try:
            rest = await asyncio.gather(
                *(self._get(path, {"order_type": "all", "page": p}) for p in range(2, pages + 1))
            )
        except ESIError as exc:
            if exc.status == 404:  # page count shrank mid-fetch
                return [], 0.0, False
            raise

        responses = [first, *rest]
        consistent = len({r.headers.get("Last-Modified") for r in responses}) == 1
        orders = [Order.from_esi(o) for r in responses for o in r.json()]
        return orders, min(_expires(r) for r in responses), consistent


def _expires(resp: httpx.Response) -> float:
    if "Expires" in resp.headers:
        return parsedate_to_datetime(resp.headers["Expires"]).timestamp()
    return time.time() + 300


def _read_cache(path: Path) -> dict | None:
    """Cached ``{"expires": ..., "data": ...}``, or None if missing, unreadable or expired."""
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    if raw.get("expires", 0) <= time.time() or "data" not in raw:
        return None
    return raw


def _write_cache(path: Path, expires: float, data: list) -> None:
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=3) as fh:
        json.dump({"expires": expires, "data": data}, fh)
    tmp.replace(path)
