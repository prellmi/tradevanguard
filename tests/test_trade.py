import pytest

from tradevanguard.models import MarketStats, Order
from tradevanguard.trade import ScanParams, find_opportunities, index_orders, plan_fill
from tradevanguard.universe import ItemType, Station, System, Universe, display_security

_next_id = iter(range(1, 10_000))


def ask(price, qty, station=101, system=1, type_id=34):
    return Order(next(_next_id), type_id, station, system, price, qty, 1, False, "region")


def bid(price, qty, station=102, system=2, type_id=34, min_volume=1):
    return Order(next(_next_id), type_id, station, system, price, qty, min_volume, True, "station")


def scan(universe, orders, origin, params, stats=None):
    index = index_orders(universe, orders, universe.systems)
    return find_opportunities(universe, index, origin, params, stats)


@pytest.fixture
def universe():
    # Chain 1 - 2 - 3 - 4, where system 3 is low-sec.
    return Universe(
        regions={10: "Test Region"},
        systems=[System(1, "Alpha", 0.9, 10), System(2, "Beta", 0.7, 10),
                 System(3, "Gamma", 0.3, 10), System(4, "Delta", 0.8, 10)],
        stations=[Station(101, "Alpha I", 1), Station(102, "Beta I", 2), Station(104, "Delta I", 4)],
        types=[ItemType(34, "Tritanium", 0.01), ItemType(587, "Rifter", 2500.0)],
        gates=[(1, 2), (2, 3), (3, 4)],
    )


def test_display_security():
    assert display_security(0.45) == 0.5
    assert display_security(0.44) == 0.4
    assert display_security(0.01) == 0.1
    assert display_security(-0.35) == -0.3


def test_fill_walks_order_book_until_unprofitable():
    asks = [ask(10, 100), ask(12, 100), ask(20, 100)]
    bids = [bid(30, 50), bid(15, 1000)]
    fill = plan_fill(asks, bids, sales_tax=0.0, unit_volume=1)
    # 50 @ 10 -> 30, 50 @ 10 -> 15, 100 @ 12 -> 15; the 20 ISK ask is never profitable.
    assert fill.units == 200
    assert fill.cost == 50 * 10 + 50 * 10 + 100 * 12
    assert fill.revenue == 50 * 30 + 150 * 15
    assert fill.max_buy_price == 12
    assert fill.min_sell_price == 15


def test_fill_applies_sales_tax():
    # 10% tax makes a 10 -> 11 trade a loss.
    assert plan_fill([ask(10, 5)], [bid(11, 5)], sales_tax=0.1, unit_volume=1) is None


def test_fill_respects_cargo_and_isk():
    asks, bids = [ask(10, 1000)], [bid(20, 1000)]
    assert plan_fill(asks, bids, sales_tax=0, unit_volume=5, cargo_m3=100).units == 20
    assert plan_fill(asks, bids, sales_tax=0, unit_volume=1, max_isk=255).units == 25


def test_fill_skips_bid_whose_min_volume_cannot_be_met():
    asks = [ask(10, 30)]
    bids = [bid(50, 100, min_volume=50), bid(20, 100)]
    fill = plan_fill(asks, bids, sales_tax=0, unit_volume=1)
    assert fill.units == 30
    assert fill.min_sell_price == 20


def test_find_opportunities_respects_security_and_radius(universe):
    orders = [ask(5, 1_000_000, station=101, system=1),
              bid(10, 1_000_000, station=102, system=2),
              bid(50, 1_000_000, station=104, system=4)]
    params = ScanParams(max_jumps=5, min_security=0.5, sales_tax=0, min_profit=0)

    # Delta is only reachable through low-sec Gamma, so only Alpha -> Beta counts.
    [opp] = scan(universe, orders, 1, params)
    assert (opp.source.id, opp.destination.id) == (101, 102)
    assert opp.fill.profit == 5_000_000
    assert opp.total_jumps == 1

    anywhere = ScanParams(max_jumps=5, min_security=-1, sales_tax=0, min_profit=0)
    best = scan(universe, orders, 1, anywhere)[0]
    assert best.destination.id == 104 and best.total_jumps == 3

    nearby = ScanParams(max_jumps=1, min_security=-1, sales_tax=0, min_profit=0)
    assert {o.destination.id for o in scan(universe, orders, 1, nearby)} == {102}


def test_find_opportunities_ignores_structures(universe):
    orders = [ask(5, 100, station=1_035_466_617_946, system=1), bid(10, 100, station=102, system=2)]
    assert scan(universe, orders, 1, ScanParams(sales_tax=0, min_profit=0)) == []


def test_volume_cap_limits_units_and_drops_illiquid_items(universe):
    orders = [ask(5, 1_000_000, station=101, system=1), bid(10, 1_000_000, station=102, system=2),
              ask(1, 10, station=101, system=1, type_id=587), bid(1e9, 10, station=102, system=2, type_id=587)]
    params = ScanParams(sales_tax=0, min_profit=0, volume_cap=0.5)
    stats = {(10, 34): MarketStats(daily_volume=1000, average_price=9.0),
             (10, 587): MarketStats(daily_volume=0.2, average_price=1e6)}

    [opp] = scan(universe, orders, 1, params, stats)
    assert opp.item.id == 34
    assert opp.fill.units == 500
    assert opp.daily_volume == 1000


def test_market_stats_counts_days_without_trades():
    rows = [["2026-09-01", 100.0, 10], ["2026-10-01", 10.0, 30], ["2026-10-10", 20.0, 30]]
    stats = MarketStats.from_history(rows, since="2026-09-17", days=30)
    assert stats.daily_volume == 2.0
    assert stats.average_price == 15.0


def test_fill_skips_bids_above_price_cap():
    fill = plan_fill([ask(10, 100)], [bid(1000, 5), bid(20, 50)], sales_tax=0, unit_volume=1, max_bid_price=30)
    assert fill.units == 50 and fill.min_sell_price == 20 and fill.avg_sell_price == 20


def test_price_check_ignores_bait_orders_but_keeps_real_ones(universe):
    orders = [ask(5, 1000, station=101, system=1),
              bid(500, 10, station=102, system=2),      # bait: 50x the usual price
              bid(12, 100, station=102, system=2)]
    stats = {(10, 34): MarketStats(daily_volume=10_000, average_price=10.0)}

    [opp] = scan(universe, orders, 1, ScanParams(sales_tax=0, min_profit=0, max_price_ratio=2.0), stats)
    assert opp.fill.units == 100 and opp.fill.profit == 700
    assert opp.max_bid_price == 20.0
    assert opp.price_premium == pytest.approx(0.2)

    [trusting] = scan(universe, orders, 1, ScanParams(sales_tax=0, min_profit=0, max_price_ratio=None), stats)
    assert trusting.fill.units == 110 and trusting.max_bid_price is None


def test_price_check_drops_items_without_reference_price(universe):
    orders = [ask(5, 10, station=101, system=1), bid(10, 10, station=102, system=2)]
    stats = {(10, 34): MarketStats(daily_volume=0.0, average_price=0.0)}
    params = ScanParams(sales_tax=0, min_profit=0, volume_cap=None)
    assert scan(universe, orders, 1, params, stats) == []


def test_sell_orders_are_bought_and_buy_orders_are_sold_into(universe):
    # ESI: is_buy_order=False is a sell order (goods you can buy), True is a buy order (where you can sell).
    sell_order = Order(1, 34, 101, 1, 5.0, 100, 1, False, "region")
    buy_order = Order(2, 34, 102, 2, 8.0, 100, 1, True, "station")
    index = index_orders(universe, [sell_order, buy_order], universe.systems)
    assert index.asks[34][101] == [sell_order] and index.bids[34][102] == [buy_order]

    [opp] = find_opportunities(universe, index, 1, ScanParams(sales_tax=0, min_profit=0))
    assert opp.source.id == 101 and opp.fill.max_buy_price == 5.0       # bought from the sell order
    assert opp.destination.id == 102 and opp.fill.min_sell_price == 8.0  # sold to the buy order
