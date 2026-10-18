"""Find hauling opportunities: buy from sell orders at A, carry to B, sell into buy orders at B.

Both legs are instant transactions, so only sales tax applies (no broker fees).
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass

from .models import MarketStats, Order
from .universe import ItemType, Station, Universe

# type_id -> station_id -> orders, best price first
OrderBooks = dict[int, dict[int, list[Order]]]


@dataclass(frozen=True)
class ScanParams:
    max_jumps: int = 5             # radius around the origin for both pickup and drop-off
    min_security: float = 0.5      # 0.5 = high-sec only, -1.0 = anywhere
    sales_tax: float = 0.075       # fraction taken when selling; lower it for Accounting skill
    cargo_m3: float | None = None
    max_isk: float | None = None
    min_profit: float = 1_000_000
    # Haul at most this many days of the destination region's average traded volume; None disables.
    volume_cap: float | None = 1.0
    history_days: int = 30
    # Ignore buy orders priced above this multiple of the destination region's average price
    # (bait or manipulated orders); None disables.
    max_price_ratio: float | None = 2.0

    @property
    def needs_history(self) -> bool:
        return self.volume_cap is not None or self.max_price_ratio is not None


@dataclass(frozen=True)
class Fill:
    units: int
    cost: float
    revenue: float         # after sales tax
    gross: float           # before sales tax
    max_buy_price: float   # most expensive sell order we bought from
    min_sell_price: float  # cheapest buy order we sold into

    @property
    def profit(self) -> float:
        return self.revenue - self.cost

    @property
    def avg_sell_price(self) -> float:
        return self.gross / self.units


@dataclass(frozen=True)
class Opportunity:
    item: ItemType
    source: Station
    destination: Station
    fill: Fill
    jumps_to_source: int
    jumps_to_destination: int
    daily_volume: float | None = None   # destination region, units per day
    average_price: float | None = None  # destination region, volume-weighted
    max_bid_price: float | None = None  # buy orders above this were ignored by the price check

    @property
    def total_jumps(self) -> int:
        return self.jumps_to_source + self.jumps_to_destination

    @property
    def profit_per_jump(self) -> float:
        return self.fill.profit / max(1, self.total_jumps)

    @property
    def roi(self) -> float:
        return self.fill.profit / self.fill.cost

    @property
    def volume_m3(self) -> float:
        return self.fill.units * self.item.volume

    @property
    def price_premium(self) -> float | None:
        """How far our average sale price lies above the regional average (0.25 = 25 % above)."""
        if not self.average_price:
            return None
        return self.fill.avg_sell_price / self.average_price - 1


@dataclass(frozen=True)
class OrderIndex:
    asks: OrderBooks  # sell orders (is_buy_order=False): what you can buy, cheapest first
    bids: OrderBooks  # buy orders (is_buy_order=True): what you can sell into, highest first


def plan_fill(
    asks: Sequence[Order],
    bids: Sequence[Order],
    *,
    sales_tax: float,
    unit_volume: float,
    cargo_m3: float | None = None,
    max_isk: float | None = None,
    max_units: int | None = None,
    max_bid_price: float | None = None,
) -> Fill | None:
    """Match the cheapest asks against the highest bids while each unit stays profitable.

    ``asks`` must be sorted by ascending price, ``bids`` by descending price.
    Because the per-unit margin only shrinks as we go, greedy matching is
    optimal for a single source/destination pair under cargo and ISK caps.
    Bids above ``max_bid_price`` are skipped as implausible.
    """
    keep = 1.0 - sales_tax
    unit_cap = math.floor(cargo_m3 / unit_volume) if cargo_m3 and unit_volume > 0 else math.inf
    if max_units is not None:
        unit_cap = min(unit_cap, max_units)
    isk_left = max_isk if max_isk else math.inf
    ask_left = [a.volume_remain for a in asks]
    i = 0
    units, cost, revenue, gross = 0, 0.0, 0.0, 0.0
    max_buy, min_sell = 0.0, math.inf

    def deliverable(net: float, want: int) -> int:
        """Units we could still deliver to a bid paying ``net`` per unit, stopping once ``want`` is reached."""
        total, isk, j = 0, isk_left, i
        while total < want and j < len(asks) and asks[j].price < net:
            q = min(ask_left[j], want - total, unit_cap - units - total, isk // asks[j].price)
            if q <= 0:
                break
            total += q
            isk -= q * asks[j].price
            j += 1
        return int(total)

    for bid in bids:
        if max_bid_price is not None and bid.price > max_bid_price:
            continue
        net = bid.price * keep
        if i == len(asks) or asks[i].price >= net or units >= unit_cap:
            break
        # A buy order with a minimum volume rejects smaller sales, so skip it if we can't meet it.
        if bid.min_volume > 1 and deliverable(net, bid.min_volume) < bid.min_volume:
            continue
        bid_left = bid.volume_remain
        while bid_left and i < len(asks) and asks[i].price < net:
            q = int(min(bid_left, ask_left[i], unit_cap - units, isk_left // asks[i].price))
            if q <= 0:
                break
            units += q
            cost += q * asks[i].price
            revenue += q * net
            gross += q * bid.price
            isk_left -= q * asks[i].price
            max_buy = max(max_buy, asks[i].price)
            min_sell = min(min_sell, bid.price)
            bid_left -= q
            ask_left[i] -= q
            if ask_left[i] == 0:
                i += 1
        if bid_left and i < len(asks) and asks[i].price < net:
            break  # stopped by cargo, ISK or volume cap, nothing more fits

    if units == 0:
        return None
    return Fill(units, cost, revenue, gross, max_buy, min_sell)


def index_orders(universe: Universe, orders: Iterable[Order], systems: Collection[int]) -> OrderIndex:
    """Group orders in ``systems`` by item and station. Player structures are skipped (not in the SDE)."""
    asks: OrderBooks = defaultdict(lambda: defaultdict(list))
    bids: OrderBooks = defaultdict(lambda: defaultdict(list))
    for o in orders:
        if o.location_id in universe.stations and o.system_id in systems:
            (bids if o.is_buy_order else asks)[o.type_id][o.location_id].append(o)
    for books in asks.values():
        for book in books.values():
            book.sort(key=lambda o: o.price)
    for books in bids.values():
        for book in books.values():
            book.sort(key=lambda o: -o.price)
    return OrderIndex(asks, bids)


def find_opportunities(
    universe: Universe,
    index: OrderIndex,
    origin_id: int,
    params: ScanParams,
    stats: Mapping[tuple[int, int], MarketStats] | None = None,
) -> list[Opportunity]:
    """All profitable source/destination pairs within ``params.max_jumps`` of the origin, best profit first.

    With ``stats`` (keyed by destination region and type) each trade is capped
    at ``params.volume_cap`` days of traded volume and buy orders above
    ``params.max_price_ratio`` times the average price are ignored. Items
    without stats are dropped.
    """
    reachable = universe.distances_from(origin_id, params.min_security, params.max_jumps)
    keep = 1.0 - params.sales_tax
    results: list[Opportunity] = []

    for type_id, ask_stations in index.asks.items():
        bid_stations = index.bids.get(type_id)
        item = universe.types.get(type_id)
        if not bid_stations or item is None:
            continue
        for src_id, src_book in ask_stations.items():
            src = universe.stations[src_id]
            if src.system_id not in reachable:
                continue
            for dst_id, dst_book in bid_stations.items():
                if dst_book[0].price * keep <= src_book[0].price:
                    continue
                dst = universe.stations[dst_id]
                if dst.system_id not in reachable:
                    continue
                market = max_units = max_bid = None
                if stats is not None:
                    market = stats.get((universe.systems[dst.system_id].region_id, type_id))
                    if market is None:
                        continue
                    if params.volume_cap is not None:
                        max_units = math.floor(market.daily_volume * params.volume_cap)
                        if max_units < 1:
                            continue
                    if params.max_price_ratio is not None:
                        if not market.average_price:
                            continue  # never traded recently, no reference price
                        max_bid = market.average_price * params.max_price_ratio
                        if max_bid * keep <= src_book[0].price:
                            continue
                route = universe.jumps(src.system_id, dst.system_id, params.min_security)
                if route is None:
                    continue
                fill = plan_fill(
                    src_book, dst_book,
                    sales_tax=params.sales_tax, unit_volume=item.volume,
                    cargo_m3=params.cargo_m3, max_isk=params.max_isk,
                    max_units=max_units, max_bid_price=max_bid,
                )
                if fill is None or fill.profit < params.min_profit:
                    continue
                results.append(Opportunity(
                    item, src, dst, fill, reachable[src.system_id], route,
                    daily_volume=market.daily_volume if market else None,
                    average_price=market.average_price if market else None,
                    max_bid_price=max_bid,
                ))

    results.sort(key=lambda o: o.fill.profit, reverse=True)
    return results
