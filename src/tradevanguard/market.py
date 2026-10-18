"""Market data service shared by the CLI and the web API.

Keeps region orders in memory on top of the ESI client's disk cache, fetches
history for volume checks, and (in the server) refreshes recently used regions
in the background so scans stay fast.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .esi import ESIClient
from .models import MarketStats, Order
from .station import StationParams, StationTrade, find_station_trades
from .trade import Opportunity, ScanParams, find_opportunities, index_orders
from .universe import Universe

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ScanResult:
    region_ids: set[int]
    order_count: int
    opportunities: list[Opportunity]


@dataclass(frozen=True)
class StationScanResult:
    region_ids: set[int]
    order_count: int
    candidates: int  # items with a wide enough spread, before volume and price checks
    trades: list[StationTrade]


@dataclass(frozen=True)
class RegionStatus:
    region_id: int
    order_count: int
    expires: float
    last_used: float


class Market:
    def __init__(self, universe: Universe, esi: ESIClient):
        self.universe = universe
        self.esi = esi
        self._orders: dict[int, tuple[float, list[Order]]] = {}  # region -> (expires, orders)
        self._locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._last_used: dict[int, float] = {}

    async def region_orders(self, region_id: int) -> list[Order]:
        self._last_used[region_id] = time.time()
        return await self._load(region_id)

    async def _load(self, region_id: int) -> list[Order]:
        async with self._locks[region_id]:  # concurrent requests share one fetch
            cached = self._orders.get(region_id)
            if cached and cached[0] > time.time():
                return cached[1]
            started = time.perf_counter()
            orders, expires = await self.esi.region_orders(region_id)
            self._orders[region_id] = (expires, orders)
            log.info("Loaded %s orders for %s in %.1fs", f"{len(orders):,}",
                     self.universe.regions.get(region_id, region_id), time.perf_counter() - started)
            return orders

    async def orders(self, region_ids: set[int]) -> list[Order]:
        per_region = await asyncio.gather(*(self.region_orders(r) for r in region_ids))
        return [o for orders in per_region for o in orders]

    async def stats(self, keys: set[tuple[int, int]], days: int = 30) -> dict[tuple[int, int], MarketStats]:
        """Recent trading stats per ``(region_id, type_id)``."""
        since = (datetime.now(UTC).date() - timedelta(days=days)).isoformat()
        by_region: dict[int, set[int]] = defaultdict(set)
        for region_id, type_id in keys:
            by_region[region_id].add(type_id)
        regions = list(by_region)
        histories = await asyncio.gather(*(self.esi.region_history(r, by_region[r]) for r in regions))
        return {(region_id, type_id): MarketStats.from_history(rows, since, days)
                for region_id, per_type in zip(regions, histories)
                for type_id, rows in per_type.items()}

    async def scan(self, origin_id: int, params: ScanParams) -> ScanResult:
        reachable = self.universe.distances_from(origin_id, params.min_security, params.max_jumps)
        region_ids = {self.universe.systems[s].region_id for s in reachable}
        orders = await self.orders(region_ids)
        index = await asyncio.to_thread(index_orders, self.universe, orders, reachable)
        found = await asyncio.to_thread(find_opportunities, self.universe, index, origin_id, params)

        if params.needs_history and found:
            # Only fetch history for candidates that are profitable before the checks.
            keys = {(self.universe.systems[o.destination.system_id].region_id, o.item.id) for o in found}
            stats = await self.stats(keys, params.history_days)
            found = await asyncio.to_thread(find_opportunities, self.universe, index, origin_id, params, stats)
        return ScanResult(region_ids, len(orders), found)

    async def station_scan(self, origin_id: int, params: StationParams) -> StationScanResult:
        reachable = self.universe.distances_from(origin_id, params.min_security, params.max_jumps)
        region_ids = {self.universe.systems[s].region_id for s in reachable}
        orders = await self.orders(region_ids)
        index = await asyncio.to_thread(index_orders, self.universe, orders, reachable)
        # Wide spreads are everywhere on illiquid items; screen them against CCP's
        # universe-wide average prices before spending one history request per item.
        reference = (await self.esi.average_prices())[0] if params.max_price_ratio is not None else None
        candidates = await asyncio.to_thread(
            find_station_trades, self.universe, index, origin_id, params, None, reference)
        keys = {(self.universe.systems[t.station.system_id].region_id, t.item.id) for t in candidates}
        started = time.perf_counter()
        stats = await self.stats(keys, params.history_days)
        log.info("History for %d items ready in %.1fs", len(keys), time.perf_counter() - started)
        trades = await asyncio.to_thread(find_station_trades, self.universe, index, origin_id, params, stats)
        return StationScanResult(region_ids, len(orders), len(candidates), trades)

    def status(self) -> list[RegionStatus]:
        return [RegionStatus(r, len(orders), expires, self._last_used.get(r, 0.0))
                for r, (expires, orders) in sorted(self._orders.items())]

    async def keep_fresh(self, idle_after: float = 3600, interval: float = 15) -> None:
        """Reload expired regions used within ``idle_after`` seconds; drop idle ones from memory."""
        while True:
            now = time.time()
            for region_id, last_used in list(self._last_used.items()):
                if now - last_used > idle_after:
                    self._orders.pop(region_id, None)
                    del self._last_used[region_id]
                    continue
                cached = self._orders.get(region_id)
                if cached is None or cached[0] <= now:
                    try:
                        await self._load(region_id)
                    except Exception:
                        log.exception("Background refresh of region %s failed", region_id)
            await asyncio.sleep(interval)
