"""Station trading: buy with a buy order and resell with a sell order at the same station.

Both orders pay a broker fee when placed; the sale also pays sales tax.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from .models import MarketStats
from .trade import OrderIndex
from .universe import ItemType, Station, Universe


@dataclass(frozen=True)
class StationParams:
    max_jumps: int = 0             # 0 = stations in the origin system only
    min_security: float = 0.5
    sales_tax: float = 0.075
    broker_fee: float = 0.03       # per order placed; lower with Broker Relations and standings
    max_isk: float | None = None   # capital to tie up per item and day
    volume_share: float = 0.1      # share of the region's daily volume you expect to trade
    min_margin: float = 0.05       # minimum return per unit after fees
    min_daily_profit: float = 1_000_000
    max_price_ratio: float | None = 2.0
    history_days: int = 30


@dataclass(frozen=True)
class StationTrade:
    item: ItemType
    station: Station
    jumps: int                 # from the origin
    best_bid: float
    best_ask: float
    buy_price: float           # one tick above the best bid
    sell_price: float          # one tick below the best ask
    unit_cost: float           # buy price including broker fee
    margin: float              # ISK per unit after broker fees and tax
    bid_orders: int            # competing orders on each side
    ask_orders: int
    daily_volume: float | None = None
    average_price: float | None = None
    units_per_day: int | None = None

    @property
    def roi(self) -> float:
        return self.margin / self.unit_cost

    @property
    def daily_profit(self) -> float | None:
        return None if self.units_per_day is None else self.units_per_day * self.margin

    @property
    def capital(self) -> float | None:
        return None if self.units_per_day is None else self.units_per_day * self.unit_cost


def price_tick(price: float) -> float:
    """Smallest allowed price step at ``price``: orders are limited to 4 significant digits."""
    if price <= 0:
        return 0.01
    return max(0.01, 10 ** (math.floor(math.log10(price)) - 3))


def outbid(price: float) -> float:
    return round(price + price_tick(price), 2)


def undercut(price: float) -> float:
    # Use the step just below the price, so 1,000.00 undercuts to 999.90 rather than 999.00.
    return round(price - price_tick(price * (1 - 1e-9)), 2)


def _plausible(best_bid: float, best_ask: float, average: float, ratio: float) -> bool:
    """Both sides of the spread lie within ``ratio`` of the average price; otherwise it's built on outliers."""
    return average / ratio <= best_bid and best_ask <= average * ratio


def find_station_trades(
    universe: Universe,
    index: OrderIndex,
    origin_id: int,
    params: StationParams,
    stats: Mapping[tuple[int, int], MarketStats] | None = None,
    reference_prices: Mapping[int, float] | None = None,
) -> list[StationTrade]:
    """Items whose bid/ask spread pays at least ``params.min_margin`` after fees, best first.

    Without ``stats`` this is the candidate pass: margins only, no volume, and
    with ``reference_prices`` (universe-wide averages per type) spreads built on
    outlier orders are dropped early. With ``stats`` (keyed by region and type)
    trades get an expected daily volume and profit, and are checked against the
    regional average price instead.
    """
    reachable = universe.distances_from(origin_id, params.min_security, params.max_jumps)
    buy_fee = 1 + params.broker_fee
    sell_keep = 1 - params.broker_fee - params.sales_tax
    results: list[StationTrade] = []

    for type_id, ask_stations in index.asks.items():
        bid_stations = index.bids.get(type_id)
        item = universe.types.get(type_id)
        if not bid_stations or item is None:
            continue
        for station_id, asks in ask_stations.items():
            bids = bid_stations.get(station_id)
            station = universe.stations[station_id]
            if not bids or station.system_id not in reachable:
                continue
            best_bid, best_ask = bids[0].price, asks[0].price
            buy_price, sell_price = outbid(best_bid), undercut(best_ask)
            if buy_price >= sell_price:
                continue
            unit_cost = buy_price * buy_fee
            margin = sell_price * sell_keep - unit_cost
            if margin <= 0 or margin / unit_cost < params.min_margin:
                continue

            ratio = params.max_price_ratio
            market = units = None
            if stats is not None:
                market = stats.get((universe.systems[station.system_id].region_id, type_id))
                if market is None or not market.average_price:
                    continue
                if ratio is not None and not _plausible(best_bid, best_ask, market.average_price, ratio):
                    continue
                units = math.floor(market.daily_volume * params.volume_share)
                if params.max_isk:
                    units = min(units, math.floor(params.max_isk / unit_cost))
                if units < 1 or units * margin < params.min_daily_profit:
                    continue
            elif reference_prices is not None and ratio is not None:
                reference = reference_prices.get(type_id)
                if not reference or not _plausible(best_bid, best_ask, reference, ratio):
                    continue

            results.append(StationTrade(
                item, station, reachable[station.system_id], best_bid, best_ask,
                buy_price, sell_price, unit_cost, margin, len(bids), len(asks),
                daily_volume=market.daily_volume if market else None,
                average_price=market.average_price if market else None,
                units_per_day=units,
            ))

    results.sort(key=lambda t: (-(t.daily_profit or 0), -t.roi, t.item.id, t.station.id))
    return results
