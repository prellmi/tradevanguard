import pytest

from tradevanguard.models import MarketStats, Order
from tradevanguard.station import StationParams, find_station_trades, outbid, price_tick, undercut
from tradevanguard.trade import index_orders
from tradevanguard.universe import ItemType, Station, System, Universe

_ids = iter(range(1, 10_000))


def order(price, is_buy, station=101, system=1, type_id=34, qty=1000):
    return Order(next(_ids), type_id, station, system, price, qty, 1, is_buy, "station")


@pytest.fixture
def universe():
    return Universe(
        regions={10: "Test Region"},
        systems=[System(1, "Alpha", 0.9, 10), System(2, "Beta", 0.8, 10)],
        stations=[Station(101, "Alpha I", 1), Station(201, "Beta I", 2)],
        types=[ItemType(34, "Tritanium", 0.01)],
        gates=[(1, 2)],
    )


def trades(universe, orders, params, stats=None, reference=None):
    index = index_orders(universe, orders, universe.systems)
    return find_station_trades(universe, index, 1, params, stats, reference)


@pytest.mark.parametrize("price, tick", [(5.0, 0.01), (1234.0, 1.0), (1_234_000.0, 1000.0), (99_990.0, 10.0)])
def test_price_tick_keeps_four_significant_digits(price, tick):
    assert price_tick(price) == tick


def test_outbid_and_undercut():
    assert outbid(1234.0) == 1235.0
    assert undercut(1234.0) == 1233.0
    assert undercut(1000.0) == 999.9  # the step below a power of ten is smaller
    assert outbid(9.99) == 10.0


def test_margin_includes_broker_fees_and_tax(universe):
    orders = [order(100.0, True), order(99.0, True), order(130.0, False), order(150.0, False)]
    params = StationParams(sales_tax=0.05, broker_fee=0.02, min_margin=0, min_daily_profit=0)
    [t] = trades(universe, orders, params)
    assert (t.buy_price, t.sell_price) == (100.1, 129.9)
    assert t.unit_cost == pytest.approx(100.1 * 1.02)
    assert t.margin == pytest.approx(129.9 * 0.93 - 100.1 * 1.02)
    assert (t.bid_orders, t.ask_orders) == (2, 2)
    assert t.daily_profit is None  # no volume known in the candidate pass


def test_spread_too_thin_after_fees_is_skipped(universe):
    orders = [order(100.0, True), order(105.0, False)]
    assert trades(universe, orders, StationParams(min_margin=0, min_daily_profit=0)) == []


def test_volume_share_and_capital_limit_daily_units(universe):
    orders = [order(100.0, True), order(150.0, False)]
    stats = {(10, 34): MarketStats(daily_volume=1000, average_price=120.0)}
    params = StationParams(sales_tax=0, broker_fee=0, volume_share=0.1, min_daily_profit=0)
    [t] = trades(universe, orders, params, stats)
    assert t.units_per_day == 100
    assert t.daily_profit == pytest.approx(100 * (149.9 - 100.1))

    capped = StationParams(sales_tax=0, broker_fee=0, volume_share=0.1, min_daily_profit=0, max_isk=2002)
    assert trades(universe, orders, capped, stats)[0].units_per_day == 20


def test_price_check_rejects_spreads_built_on_outliers(universe):
    orders = [order(0.5, True), order(150.0, False)]  # junk 0.50 ISK bid
    stats = {(10, 34): MarketStats(daily_volume=1000, average_price=120.0)}
    params = StationParams(min_daily_profit=0)
    assert trades(universe, orders, params, stats) == []
    assert trades(universe, orders, params, reference={34: 120.0}) == []
    assert len(trades(universe, orders, StationParams(min_daily_profit=0, max_price_ratio=None), stats)) == 1


def test_only_stations_within_radius(universe):
    orders = [order(100.0, True, station=201, system=2), order(150.0, False, station=201, system=2)]
    params = StationParams(min_margin=0, min_daily_profit=0)
    assert trades(universe, orders, params) == []
    assert len(trades(universe, orders, StationParams(max_jumps=1, min_margin=0, min_daily_profit=0))) == 1
