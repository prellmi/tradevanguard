"""Command line entry point: ``tradevanguard scan Jita --jumps 5 --cargo 10000``."""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

from . import config, sde
from .api import SORT_KEYS, STATION_SORT_KEYS, rank
from .esi import ESIClient
from .market import Market, ScanResult, StationScanResult
from .station import StationParams, StationTrade
from .trade import Opportunity, ScanParams
from .universe import Universe

ISK_SUFFIXES = {"k": 1e3, "m": 1e6, "b": 1e9}


def parse_isk(text: str) -> float:
    text = text.strip().lower().replace(",", "").replace("_", "")
    if text and text[-1] in ISK_SUFFIXES:
        return float(text[:-1]) * ISK_SUFFIXES[text[-1]]
    return float(text)


def fmt_isk(value: float) -> str:
    for suffix, factor in (("b", 1e9), ("m", 1e6), ("k", 1e3)):
        if abs(value) >= factor:
            return f"{value / factor:.2f}{suffix}"
    return f"{value:.2f}"


async def run_scan(universe: Universe, origin_id: int, params: ScanParams) -> ScanResult:
    async with ESIClient(config.DATA_DIR / "cache", config.user_agent()) as esi:
        return await Market(universe, esi).scan(origin_id, params)


def print_opportunity(rank: int, opp: Opportunity) -> None:
    f = opp.fill
    volume = f", sells ~{opp.daily_volume:,.0f}/day" if opp.daily_volume is not None else ""
    if opp.price_premium is not None:
        volume += f", {opp.price_premium:+.0%} vs avg"
    print(f"{rank:3}. {opp.item.name} x {f.units:,}   profit {fmt_isk(f.profit)}"
          f"   (ROI {opp.roi:.1%}, {opp.total_jumps} jumps, {fmt_isk(opp.profit_per_jump)}/jump,"
          f" {opp.volume_m3:,.0f} m3, invest {fmt_isk(f.cost)}{volume})")
    print(f"       buy from sell orders @ {opp.source.name}  [{opp.jumps_to_source}j from origin]"
          f"  up to {f.max_buy_price:,.2f} ISK")
    print(f"       sell to buy orders   @ {opp.destination.name}  [{opp.jumps_to_destination}j]"
          f"  down to {f.min_sell_price:,.2f} ISK")


def cmd_update_sde(args: argparse.Namespace) -> None:
    path = sde.ensure_universe(config.DATA_DIR, update=True)
    print(f"Universe data: {path}")


def cmd_export_universe(args: argparse.Namespace) -> None:
    import shutil

    source = sde.ensure_universe(config.DATA_DIR, update=args.update)
    args.target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, args.target)
    print(f"Wrote {args.target} ({args.target.stat().st_size / 1e6:.1f} MB) from {source.name}")


def cmd_scan(args: argparse.Namespace) -> None:
    universe = Universe.load(sde.ensure_universe(config.DATA_DIR))
    try:
        origin = universe.system_by_name(args.origin)
    except KeyError as exc:
        sys.exit(exc.args[0])

    params = ScanParams(
        max_jumps=args.jumps,
        min_security=args.min_security,
        sales_tax=args.sales_tax / 100,
        cargo_m3=args.cargo,
        max_isk=args.isk,
        min_profit=args.min_profit,
        volume_cap=None if args.no_volume_check else args.volume_cap,
        max_price_ratio=None if args.no_price_check else args.max_price_ratio,
        history_days=args.history_days,
    )
    started = time.perf_counter()
    result = asyncio.run(run_scan(universe, origin.id, params))
    print(f"Origin {origin.name} ({origin.display_security}), {args.jumps} jumps, "
          f"regions: {', '.join(sorted(universe.regions[r] for r in result.region_ids))}")
    print(f"Scanned {result.order_count:,} orders in {time.perf_counter() - started:.1f}s")

    opportunities = rank(result.opportunities, args.sort, args.all_routes)
    print(f"Found {len(opportunities):,} opportunities, showing top {min(args.limit, len(opportunities))}"
          f" by {args.sort}\n")
    for i, opp in enumerate(opportunities[: args.limit], 1):
        print_opportunity(i, opp)


async def run_station_scan(universe: Universe, origin_id: int, params: StationParams) -> StationScanResult:
    async with ESIClient(config.DATA_DIR / "cache", config.user_agent()) as esi:
        return await Market(universe, esi).station_scan(origin_id, params)


def print_station_trade(rank: int, t: StationTrade) -> None:
    print(f"{rank:3}. {t.item.name}   profit {fmt_isk(t.daily_profit)}/day"
          f"   (ROI {t.roi:.1%}, {t.units_per_day:,}/day of ~{t.daily_volume:,.0f} traded,"
          f" capital {fmt_isk(t.capital)})")
    print(f"       place buy order  @ {t.buy_price:,.2f}  (highest buy order {t.best_bid:,.2f},"
          f" {t.bid_orders} buy orders)")
    print(f"       place sell order @ {t.sell_price:,.2f}  (lowest sell order {t.best_ask:,.2f},"
          f" {t.ask_orders} sell orders)"
          f"   regional avg {t.average_price:,.2f}")
    print(f"       at {t.station.name}" + (f"  [{t.jumps}j]" if t.jumps else ""))


def cmd_station(args: argparse.Namespace) -> None:
    universe = Universe.load(sde.ensure_universe(config.DATA_DIR))
    try:
        origin = universe.system_by_name(args.origin)
    except KeyError as exc:
        sys.exit(exc.args[0])

    params = StationParams(
        max_jumps=args.jumps,
        min_security=args.min_security,
        sales_tax=args.sales_tax / 100,
        broker_fee=args.broker_fee / 100,
        max_isk=args.isk,
        volume_share=args.volume_share / 100,
        min_margin=args.min_margin / 100,
        min_daily_profit=args.min_profit,
        max_price_ratio=None if args.no_price_check else args.max_price_ratio,
    )
    started = time.perf_counter()
    result = asyncio.run(run_station_scan(universe, origin.id, params))
    print(f"Station trading around {origin.name} ({origin.display_security}), {args.jumps} jumps")
    print(f"Scanned {result.order_count:,} orders, {result.candidates:,} items with a wide spread,"
          f" in {time.perf_counter() - started:.1f}s")
    trades = sorted(result.trades, key=STATION_SORT_KEYS[args.sort], reverse=True)
    print(f"Found {len(trades):,} station trades, showing top {min(args.limit, len(trades))} by {args.sort}\n")
    for i, trade in enumerate(trades[: args.limit], 1):
        print_station_trade(i, trade)


def cmd_serve(args: argparse.Namespace) -> None:
    import logging

    import uvicorn

    from .api import create_app

    # uvicorn only configures its own loggers; this surfaces the market service's messages too.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
    print(f"TradeVanguard running at http://{args.host}:{args.port}")
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="tradevanguard", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("update-sde", help="download the latest Static Data Export").set_defaults(func=cmd_update_sde)

    export = sub.add_parser("export-universe", help="write the universe data file for the browser version")
    export.add_argument("target", type=Path, nargs="?", default=Path("web/data/universe.json"),
                        help="output file (default web/data/universe.json)")
    export.add_argument("--update", action="store_true", help="check for a newer SDE first")
    export.set_defaults(func=cmd_export_universe)

    scan = sub.add_parser("scan", help="find hauling opportunities around a system")
    scan.add_argument("origin", help="starting solar system, e.g. Jita")
    scan.add_argument("--jumps", type=int, default=5, help="search radius in jumps (default 5)")
    scan.add_argument("--min-security", type=float, default=0.5,
                      help="lowest system security to route through (default 0.5 = high-sec; -1 = anywhere)")
    scan.add_argument("--cargo", type=float, help="cargo capacity in m3")
    scan.add_argument("--isk", type=parse_isk, help="max ISK to invest per trade, e.g. 500m")
    scan.add_argument("--sales-tax", type=float, default=7.5,
                      help="sales tax in percent (default 7.5; lower with Accounting skill)")
    scan.add_argument("--min-profit", type=parse_isk, default=1e6, help="minimum profit per trade (default 1m)")
    scan.add_argument("--volume-cap", type=float, default=1.0,
                      help="haul at most this many days of the destination region's traded volume (default 1)")
    scan.add_argument("--history-days", type=int, default=30, help="days of history for the volume average")
    scan.add_argument("--no-volume-check", action="store_true", help="skip the trade volume cap")
    scan.add_argument("--max-price-ratio", type=float, default=2.0,
                      help="ignore buy orders priced above this multiple of the regional average (default 2)")
    scan.add_argument("--no-price-check", action="store_true", help="trust buy orders at any price")
    scan.add_argument("--sort", choices=SORT_KEYS, default="profit", help="ranking (default profit)")
    scan.add_argument("--limit", type=int, default=25, help="number of results to show")
    scan.add_argument("--all-routes", action="store_true",
                      help="list every station pair instead of only the best route per item")
    scan.set_defaults(func=cmd_scan)

    station = sub.add_parser("station", help="find station trading margins (buy order + sell order)")
    station.add_argument("origin", help="system to trade in, e.g. Jita")
    station.add_argument("--jumps", type=int, default=0, help="also include stations this many jumps away")
    station.add_argument("--min-security", type=float, default=0.5, help="lowest system security (default 0.5)")
    station.add_argument("--isk", type=parse_isk, help="max capital per item and day, e.g. 500m")
    station.add_argument("--sales-tax", type=float, default=7.5, help="sales tax in percent (default 7.5)")
    station.add_argument("--broker-fee", type=float, default=3.0,
                         help="broker fee per order in percent (default 3; lower with Broker Relations)")
    station.add_argument("--volume-share", type=float, default=10.0,
                         help="percent of the region's daily volume you expect to trade (default 10)")
    station.add_argument("--min-margin", type=float, default=5.0, help="minimum ROI per unit in percent (default 5)")
    station.add_argument("--min-profit", type=parse_isk, default=1e6, help="minimum profit per day (default 1m)")
    station.add_argument("--max-price-ratio", type=float, default=2.0,
                         help="skip spreads with prices beyond this multiple of the regional average (default 2)")
    station.add_argument("--no-price-check", action="store_true", help="trust any spread")
    station.add_argument("--sort", choices=STATION_SORT_KEYS, default="profit", help="ranking (default profit)")
    station.add_argument("--limit", type=int, default=25, help="number of results to show")
    station.set_defaults(func=cmd_station)

    serve = sub.add_parser("serve", help="run the web app (API docs at /docs)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.set_defaults(func=cmd_serve)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
