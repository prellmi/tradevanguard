// Unit tests for the browser engine, mirroring tests/test_trade.py and tests/test_station.py.
// Run with: npm test --prefix web   (or: node --test web/tests/*.test.mjs)

import assert from "node:assert/strict";
import { test } from "node:test";

import { ESIClient, memoryStore } from "../engine/esi.js";
import { Market, marketStats } from "../engine/market.js";
import { findStationTrades, outbid, priceTick, STATION_DEFAULTS, undercut } from "../engine/station.js";
import { findOpportunities, indexOrders, planFill, SCAN_DEFAULTS } from "../engine/trade.js";
import { displaySecurity, Universe } from "../engine/universe.js";

let nextId = 1;
const order = (price, qty, { buy, station, system, type = 34, minVolume = 1 }) => ({
  order_id: nextId++, type_id: type, location_id: station, system_id: system, price,
  volume_remain: qty, min_volume: minVolume, is_buy_order: buy, range: "region",
});
const ask = (price, qty, opts = {}) => order(price, qty, { buy: false, station: 101, system: 1, ...opts });
const bid = (price, qty, opts = {}) => order(price, qty, { buy: true, station: 102, system: 2, ...opts });

// Chain 1 - 2 - 3 - 4, where system 3 is low-sec.
const universe = () => new Universe({
  build: 1,
  regions: { 10: "Test Region" },
  systems: { 1: ["Alpha", 0.9, 10], 2: ["Beta", 0.7, 10], 3: ["Gamma", 0.3, 10], 4: ["Delta", 0.8, 10] },
  stations: { 101: ["Alpha I", 1], 102: ["Beta I", 2], 104: ["Delta I", 4] },
  types: { 34: ["Tritanium", 0.01], 587: ["Rifter", 2500] },
  gates: [[1, 2], [2, 3], [3, 4]],
});

const haul = (overrides) => ({ ...SCAN_DEFAULTS, salesTax: 0, minProfit: 0, ...overrides });
const scan = (u, orders, params, stats = null) =>
  findOpportunities(u, indexOrders(u, orders, u.systems), 1, params, stats);

test("display security rounds like the game", () => {
  assert.equal(displaySecurity(0.45), 0.5);
  assert.equal(displaySecurity(0.44), 0.4);
  assert.equal(displaySecurity(0.01), 0.1);
  assert.equal(displaySecurity(-0.35), -0.3);
});

test("fill walks the order book until unprofitable", () => {
  const fill = planFill([ask(10, 100), ask(12, 100), ask(20, 100)], [bid(30, 50), bid(15, 1000)],
                        { salesTax: 0, unitVolume: 1 });
  assert.equal(fill.units, 200);
  assert.equal(fill.cost, 50 * 10 + 50 * 10 + 100 * 12);
  assert.equal(fill.revenue, 50 * 30 + 150 * 15);
  assert.equal(fill.maxBuyPrice, 12);
  assert.equal(fill.minSellPrice, 15);
});

test("fill respects tax, cargo, ISK, min volume and price cap", () => {
  assert.equal(planFill([ask(10, 5)], [bid(11, 5)], { salesTax: 0.1, unitVolume: 1 }), null);
  const asks = [ask(10, 1000)], bids = [bid(20, 1000)];
  assert.equal(planFill(asks, bids, { salesTax: 0, unitVolume: 5, cargoM3: 100 }).units, 20);
  assert.equal(planFill(asks, bids, { salesTax: 0, unitVolume: 1, maxIsk: 255 }).units, 25);
  const minVol = planFill([ask(10, 30)], [bid(50, 100, { minVolume: 50 }), bid(20, 100)], { salesTax: 0, unitVolume: 1 });
  assert.equal(minVol.units, 30);
  assert.equal(minVol.minSellPrice, 20);
  const capped = planFill([ask(10, 100)], [bid(1000, 5), bid(20, 50)], { salesTax: 0, unitVolume: 1, maxBidPrice: 30 });
  assert.equal(capped.units, 50);
});

test("opportunities respect security and radius", () => {
  const u = universe();
  const orders = [ask(5, 1_000_000), bid(10, 1_000_000), bid(50, 1_000_000, { station: 104, system: 4 })];
  const [opp, ...rest] = scan(u, orders, haul({ minSecurity: 0.5 }));
  assert.equal(rest.length, 0);
  assert.deepEqual([opp.source.id, opp.destination.id, opp.fill.profit], [101, 102, 5_000_000]);
  const best = scan(u, orders, haul({ minSecurity: -1 }))[0];
  assert.equal(best.destination.id, 104);
  assert.equal(best.jumpsToSource + best.jumpsToDestination, 3);
  assert.deepEqual(scan(u, orders, haul({ minSecurity: -1, maxJumps: 1 })).map((o) => o.destination.id), [102]);
});

test("sell orders are bought, buy orders are sold into; structures ignored", () => {
  const u = universe();
  const index = indexOrders(u, [ask(5, 100), bid(8, 100), ask(1, 100, { station: 1_035_466_617_946 })], u.systems);
  assert.equal(index.asks.get(34).get(101)[0].is_buy_order, false);
  assert.equal(index.bids.get(34).get(102)[0].is_buy_order, true);
  assert.equal(index.asks.get(34).size, 1);
});

test("volume cap and price check use regional stats", () => {
  const u = universe();
  const orders = [ask(5, 1000), bid(500, 10), bid(12, 100)];
  const stats = new Map([["10:34", { dailyVolume: 10_000, averagePrice: 10 }]]);
  const [opp] = scan(u, orders, haul({ maxPriceRatio: 2 }), stats);
  assert.equal(opp.fill.units, 100);
  assert.equal(opp.fill.profit, 700);
  const [capped] = scan(u, [ask(5, 1_000_000), bid(10, 1_000_000)], haul({ volumeCap: 0.5, maxPriceRatio: null }),
                        new Map([["10:34", { dailyVolume: 1000, averagePrice: 9 }]]));
  assert.equal(capped.fill.units, 500);
});

test("market stats count days without trades", () => {
  const rows = [["2026-09-01", 100, 10], ["2026-10-01", 10, 30], ["2026-10-10", 20, 30]];
  assert.deepEqual(marketStats(rows, "2026-09-17", 30), { dailyVolume: 2, averagePrice: 15 });
});

test("price ticks keep four significant digits", () => {
  assert.equal(priceTick(5), 0.01);
  assert.equal(priceTick(1234), 1);
  assert.equal(priceTick(1_234_000), 1000);
  assert.equal(outbid(1234), 1235);
  assert.equal(undercut(1000), 999.9);
  assert.equal(outbid(9.99), 10);
});

test("station trades include broker fees, tax, volume share and capital", () => {
  const u = universe();
  const orders = [bid(100, 1000, { station: 101, system: 1 }), ask(130, 1000), ask(150, 1000)];
  const params = { ...STATION_DEFAULTS, salesTax: 0.05, brokerFee: 0.02, minMargin: 0, minDailyProfit: 0 };
  const [t] = findStationTrades(u, indexOrders(u, orders, u.systems), 1, params);
  assert.deepEqual([t.buyPrice, t.sellPrice], [100.1, 129.9]);
  assert.ok(Math.abs(t.margin - (129.9 * 0.93 - 100.1 * 1.02)) < 1e-9);

  const stats = new Map([["10:34", { dailyVolume: 1000, averagePrice: 120 }]]);
  const capped = { ...params, salesTax: 0, brokerFee: 0, maxIsk: 2002 };
  assert.equal(findStationTrades(u, indexOrders(u, orders, u.systems), 1, capped, stats)[0].unitsPerDay, 20);
  const junk = [bid(0.5, 1000, { station: 101, system: 1 }), ask(150, 1000)];
  assert.deepEqual(findStationTrades(u, indexOrders(u, junk, u.systems), 1, { ...params, maxPriceRatio: 2 }, stats), []);
});

test("market pipeline returns API-shaped results without network", async () => {
  const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const orders = [ask(5, 100_000), bid(10, 100_000)];
  const esi = {
    regionOrders: async () => ({ orders, expires: Date.now() + 300_000 }),
    regionHistory: async (region, typeIds) => new Map([...typeIds].map((t) => [t, [[today, 9, 3000]]])),
    averagePrices: async () => new Map([[34, 9]]),
  };
  const market = new Market(universe(), esi);
  const body = await market.scan({ origin: "alpha", sales_tax: "0", min_profit: "0" });
  assert.equal(body.opportunities[0].units, 100);  // 3000 units over 30 days
  assert.equal(body.opportunities[0].source.name, "Alpha I");
  await assert.rejects(market.scan({ origin: "Nowhere" }), /Unknown system 'Nowhere'/);
  assert.deepEqual(market.systems("be").map((s) => s.name), ["Beta"]);
});

test("ESI client pages through orders and caches history in the store", async () => {
  const calls = [];
  const respond = (body, headers = {}) => new Response(JSON.stringify(body), {
    headers: { Expires: new Date(Date.now() + 300_000).toUTCString(), "Last-Modified": "x", ...headers },
  });
  const fakeFetch = async (url) => {
    calls.push(url.toString());
    if (url.pathname.endsWith("/orders/")) {
      const page = Number(url.searchParams.get("page"));
      return respond([{ ...ask(page, 1), extra: "dropped" }], { "X-Pages": "3" });
    }
    return respond([{ date: new Date().toISOString().slice(0, 10), average: 5, volume: 7, order_count: 1 }]);
  };
  const store = memoryStore();
  const esi = new ESIClient({ userAgent: "test-agent", store, fetch: fakeFetch });
  const { orders } = await esi.regionOrders(10);
  assert.deepEqual(orders.map((o) => o.price).sort(), [1, 2, 3]);
  assert.equal(orders[0].extra, undefined);
  assert.ok(calls.every((c) => c.includes("user_agent=test-agent")));

  await esi.regionHistory(10, [34]);
  const fresh = new ESIClient({ userAgent: "test-agent", store, fetch: fakeFetch });
  const before = calls.length;
  const history = await fresh.regionHistory(10, [34]);
  assert.equal(calls.length, before);  // served from the store, no request
  assert.equal(history.get(34)[0][2], 7);
});
