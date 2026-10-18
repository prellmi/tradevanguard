import time

import pytest
from fastapi.testclient import TestClient

from tradevanguard.api import create_app
from tradevanguard.market import Market
from tradevanguard.models import Order
from tradevanguard.universe import ItemType, Station, System, Universe


class FakeESI:
    def __init__(self, orders, history):
        self.orders, self.history = orders, history
        self.order_calls = 0

    async def region_orders(self, region_id):
        self.order_calls += 1
        return self.orders, time.time() + 300

    async def average_prices(self):
        return {type_id: rows[-1][1] for type_id, rows in self.history.items()}, time.time() + 3600

    async def region_history(self, region_id, type_ids):
        return {t: self.history.get(t, []) for t in type_ids}


@pytest.fixture
def esi():
    today = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))
    orders = [Order(1, 34, 101, 1, 5.0, 100_000, 1, False, "region"),
              Order(2, 34, 102, 2, 10.0, 100_000, 1, True, "station")]
    return FakeESI(orders, {34: [[today, 9.0, 3000]]})


@pytest.fixture
def client(esi):
    universe = Universe(
        regions={10: "Test Region"},
        systems=[System(1, "Alpha", 0.9, 10), System(2, "Beta", 0.7, 10)],
        stations=[Station(101, "Alpha I", 1), Station(102, "Beta I", 2)],
        types=[ItemType(34, "Tritanium", 0.01)],
        gates=[(1, 2)],
    )
    with TestClient(create_app(Market(universe, esi))) as c:
        yield c


def test_scan_applies_volume_cap(client):
    body = client.get("/api/scan", params={"origin": "alpha", "sales_tax": 0, "min_profit": 0}).json()
    [opp] = body["opportunities"]
    assert opp["units"] == 100  # 3000 units over 30 days = 100/day
    assert opp["profit"] == 500.0
    assert opp["source"]["name"] == "Alpha I" and opp["destination"]["jumps_from_source"] == 1
    assert body["regions"] == ["Test Region"]

    unchecked = client.get("/api/scan", params={"origin": "Alpha", "sales_tax": 0, "min_profit": 0,
                                                    "volume_check": False}).json()
    assert unchecked["opportunities"][0]["units"] == 100_000
    assert opp["average_price"] == 9.0 and opp["price_premium"] == pytest.approx(10 / 9 - 1, abs=1e-4)


def test_price_check_can_be_tuned_or_disabled(client):
    base = {"origin": "Alpha", "sales_tax": 0, "min_profit": 0}
    # The 10 ISK bid is 1.11x the 9 ISK average, so a 1.05x cap rejects it.
    assert client.get("/api/scan", params=base | {"max_price_ratio": 1.05}).json()["opportunities"] == []
    [opp] = client.get("/api/scan", params=base | {"max_price_ratio": 1.05, "price_check": False}).json()["opportunities"]
    assert opp["max_bid_price"] is None


def test_orders_are_cached_in_memory(client, esi):
    client.get("/api/scan", params={"origin": "Alpha"})
    client.get("/api/scan", params={"origin": "Alpha"})
    assert esi.order_calls == 1
    [region] = client.get("/api/status").json()["regions"]
    assert region["orders"] == 2 and region["expires_in"] > 0


def test_unknown_system_and_autocomplete(client):
    assert client.get("/api/scan", params={"origin": "Nowhere"}).status_code == 404
    assert [s["name"] for s in client.get("/api/systems", params={"q": "be"}).json()] == ["Beta"]


def test_frontend_is_served(client):
    page = client.get("/")
    assert page.status_code == 200 and "<title>TradeVanguard</title>" in page.text
    script = client.get("/app.js")
    assert script.status_code == 200 and script.headers["cache-control"] == "no-cache"


def test_station_endpoint(client, esi):
    # Beta I already has a 10 ISK buy order; a 14 ISK sell order there opens a spread.
    esi.orders.append(Order(3, 34, 102, 2, 14.0, 100_000, 1, False, "region"))
    params = {"origin": "Alpha", "sales_tax": 0, "broker_fee": 0, "min_profit": 0, "volume_share": 50}
    assert client.get("/api/station", params=params).json()["trades"] == []  # Beta is 1 jump away

    body = client.get("/api/station", params=params | {"jumps": 1}).json()
    [t] = body["trades"]
    assert t["station"]["name"] == "Beta I"
    assert (t["buy_price"], t["sell_price"]) == (10.01, 13.99)
    assert t["units_per_day"] == 50 and t["daily_profit"] == pytest.approx(50 * 3.98)
    assert body["candidates"] == 1
