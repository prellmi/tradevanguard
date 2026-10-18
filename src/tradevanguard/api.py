"""Web app: ``tradevanguard serve`` then open http://127.0.0.1:8000 (API docs at /docs)."""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from . import config, sde
from .esi import ESIClient
from .market import Market
from .station import StationParams, StationTrade
from .trade import Opportunity, ScanParams
from .universe import Station, Universe

STATIC_DIR = Path(__file__).parent / "static"


class RevalidatingStaticFiles(StaticFiles):
    """Static files the browser must revalidate, so a code update is never hidden by a stale cache."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


SORT_KEYS = {
    "profit": lambda o: o.fill.profit,
    "jump": lambda o: o.profit_per_jump,
    "roi": lambda o: o.roi,
}
STATION_SORT_KEYS = {
    "profit": lambda t: t.daily_profit or 0,
    "roi": lambda t: t.roi,
}


def create_app(market: Market | None = None) -> FastAPI:
    """Build the app. Pass a ``market`` in tests; otherwise one is created on startup."""

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if market is not None:
            app.state.market = market
            yield
            return
        universe = Universe.load(sde.ensure_universe(config.DATA_DIR))
        async with ESIClient(config.DATA_DIR / "cache", config.user_agent()) as esi:
            app.state.market = Market(universe, esi)
            refresher = asyncio.create_task(app.state.market.keep_fresh())
            try:
                yield
            finally:
                refresher.cancel()

    app = FastAPI(title="TradeVanguard", lifespan=lifespan)

    def get_market() -> Market:
        return app.state.market

    @app.get("/api/systems")
    def systems(q: str = Query(min_length=1), limit: int = Query(10, ge=1, le=50)) -> list[dict]:
        """Solar systems whose name starts with ``q`` (for autocomplete)."""
        universe = get_market().universe
        prefix = q.strip().lower()
        matches = sorted((s for s in universe.systems.values() if s.name.lower().startswith(prefix)),
                         key=lambda s: s.name)
        return [{"id": s.id, "name": s.name, "security": s.display_security,
                 "region": universe.regions[s.region_id]} for s in matches[:limit]]

    @app.get("/api/scan")
    async def scan(
        origin: str,
        jumps: int = Query(5, ge=0, le=30),
        min_security: float = Query(0.5, ge=-1.0, le=1.0),
        cargo: float | None = Query(None, gt=0, description="cargo capacity in m3"),
        isk: float | None = Query(None, gt=0, description="max ISK to invest per trade"),
        sales_tax: float = Query(7.5, ge=0, le=100, description="percent"),
        min_profit: float = Query(1_000_000, ge=0),
        volume_cap: float | None = Query(1.0, gt=0, description="max days of destination volume per trade"),
        volume_check: bool = True,
        max_price_ratio: float | None = Query(2.0, ge=1.0, description="ignore buy orders above this × regional average price"),
        price_check: bool = True,
        sort: Literal["profit", "jump", "roi"] = "profit",
        all_routes: bool = False,
        limit: int = Query(50, ge=1, le=500),
    ) -> dict:
        market = get_market()
        try:
            origin_system = market.universe.system_by_name(origin)
        except KeyError as exc:
            raise HTTPException(404, exc.args[0]) from None

        params = ScanParams(
            max_jumps=jumps, min_security=min_security, sales_tax=sales_tax / 100,
            cargo_m3=cargo, max_isk=isk, min_profit=min_profit,
            volume_cap=volume_cap if volume_check else None,
            max_price_ratio=max_price_ratio if price_check else None,
        )
        started = time.perf_counter()
        result = await market.scan(origin_system.id, params)
        found = rank(result.opportunities, sort, all_routes)
        return {
            "origin": {"id": origin_system.id, "name": origin_system.name,
                       "security": origin_system.display_security},
            "regions": sorted(market.universe.regions[r] for r in result.region_ids),
            "order_count": result.order_count,
            "total": len(found),
            "elapsed": round(time.perf_counter() - started, 2),
            "opportunities": [opportunity_json(market.universe, o) for o in found[:limit]],
        }

    @app.get("/api/station")
    async def station_scan(
        origin: str,
        jumps: int = Query(0, ge=0, le=30),
        min_security: float = Query(0.5, ge=-1.0, le=1.0),
        isk: float | None = Query(None, gt=0, description="max capital per item and day"),
        sales_tax: float = Query(7.5, ge=0, le=100, description="percent"),
        broker_fee: float = Query(3.0, ge=0, le=100, description="percent per order"),
        volume_share: float = Query(10.0, gt=0, le=100, description="percent of daily volume you expect to trade"),
        min_margin: float = Query(5.0, ge=0, description="minimum ROI per unit, percent"),
        min_profit: float = Query(1_000_000, ge=0, description="minimum profit per day"),
        max_price_ratio: float | None = Query(2.0, ge=1.0),
        price_check: bool = True,
        sort: Literal["profit", "roi"] = "profit",
        limit: int = Query(100, ge=1, le=1000),
    ) -> dict:
        market = get_market()
        try:
            origin_system = market.universe.system_by_name(origin)
        except KeyError as exc:
            raise HTTPException(404, exc.args[0]) from None

        params = StationParams(
            max_jumps=jumps, min_security=min_security, sales_tax=sales_tax / 100,
            broker_fee=broker_fee / 100, max_isk=isk, volume_share=volume_share / 100,
            min_margin=min_margin / 100, min_daily_profit=min_profit,
            max_price_ratio=max_price_ratio if price_check else None,
        )
        started = time.perf_counter()
        result = await market.station_scan(origin_system.id, params)
        trades = sorted(result.trades, key=STATION_SORT_KEYS[sort], reverse=True)
        return {
            "origin": {"id": origin_system.id, "name": origin_system.name,
                       "security": origin_system.display_security},
            "regions": sorted(market.universe.regions[r] for r in result.region_ids),
            "order_count": result.order_count,
            "candidates": result.candidates,
            "total": len(trades),
            "elapsed": round(time.perf_counter() - started, 2),
            "trades": [station_trade_json(market.universe, t) for t in trades[:limit]],
        }

    @app.get("/api/status")
    def status() -> dict:
        market = get_market()
        now = time.time()
        return {"regions": [
            {"id": s.region_id, "name": market.universe.regions.get(s.region_id), "orders": s.order_count,
             "expires_in": round(s.expires - now), "idle": round(now - s.last_used)}
            for s in market.status()
        ]}

    # Mounted last so the API routes above take precedence.
    app.mount("/", RevalidatingStaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


def rank(opportunities: list[Opportunity], sort: str, all_routes: bool) -> list[Opportunity]:
    """Sort, and unless ``all_routes`` keep only the best route per item."""
    ranked = sorted(opportunities, key=SORT_KEYS[sort], reverse=True)
    if all_routes:
        return ranked
    best: dict[int, Opportunity] = {}
    for opp in ranked:
        best.setdefault(opp.item.id, opp)
    return list(best.values())


def _station_json(universe: Universe, station: Station) -> dict:
    system = universe.systems[station.system_id]
    return {"id": station.id, "name": station.name, "system": system.name,
            "security": system.display_security, "region": universe.regions[system.region_id]}


def station_trade_json(universe: Universe, t: StationTrade) -> dict:
    return {
        "item": {"id": t.item.id, "name": t.item.name, "volume": t.item.volume},
        "station": _station_json(universe, t.station) | {"jumps_from_origin": t.jumps},
        "best_bid": t.best_bid,
        "best_ask": t.best_ask,
        "buy_price": t.buy_price,
        "sell_price": t.sell_price,
        "unit_cost": round(t.unit_cost, 2),
        "margin": round(t.margin, 2),
        "roi": round(t.roi, 4),
        "bid_orders": t.bid_orders,
        "ask_orders": t.ask_orders,
        "daily_volume": None if t.daily_volume is None else round(t.daily_volume, 1),
        "average_price": None if t.average_price is None else round(t.average_price, 2),
        "units_per_day": t.units_per_day,
        "daily_profit": None if t.daily_profit is None else round(t.daily_profit, 2),
        "capital": None if t.capital is None else round(t.capital, 2),
    }


def opportunity_json(universe: Universe, opp: Opportunity) -> dict:
    f = opp.fill
    return {
        "item": {"id": opp.item.id, "name": opp.item.name, "volume": opp.item.volume},
        "source": _station_json(universe, opp.source) | {"jumps_from_origin": opp.jumps_to_source},
        "destination": _station_json(universe, opp.destination) | {"jumps_from_source": opp.jumps_to_destination},
        "units": f.units,
        "cost": round(f.cost, 2),
        "revenue": round(f.revenue, 2),
        "profit": round(f.profit, 2),
        "roi": round(opp.roi, 4),
        "total_jumps": opp.total_jumps,
        "profit_per_jump": round(opp.profit_per_jump, 2),
        "volume_m3": round(opp.volume_m3, 2),
        "max_buy_price": f.max_buy_price,
        "min_sell_price": f.min_sell_price,
        "avg_sell_price": round(f.avg_sell_price, 2),
        "daily_volume": None if opp.daily_volume is None else round(opp.daily_volume, 1),
        "average_price": None if opp.average_price is None else round(opp.average_price, 2),
        "price_premium": None if opp.price_premium is None else round(opp.price_premium, 4),
        "max_bid_price": None if opp.max_bid_price is None else round(opp.max_bid_price, 2),
    }
