// Market data service and scan pipeline. Port of src/tradevanguard/market.py plus the JSON
// shaping from api.py, so the page receives the same responses as from the Python server.

import { findOpportunities, indexOrders, needsHistory, pricePremium, profitPerJump, roi, SCAN_DEFAULTS,
         totalJumps } from "./trade.js";
import { findStationTrades, STATION_DEFAULTS } from "./station.js";

/** Recent trading activity: average units per day (counting days without trades) and VWAP. */
export function marketStats(rows, since, days) {
  let volume = 0, value = 0;
  for (const [date, average, vol] of rows) {
    if (date >= since) {
      volume += vol;
      value += average * vol;
    }
  }
  return { dailyVolume: volume / days, averagePrice: volume ? value / volume : 0 };
}

const HAUL_SORT = {
  profit: (o) => o.fill.profit,
  jump: profitPerJump,
  roi,
};
const STATION_SORT = {
  profit: (t) => t.dailyProfit ?? 0,
  roi: (t) => t.roi,
};

// ---------- request parameters (same names and units as the Python API) ----------

function number(query, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = query[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid value for ${key}: ${raw}`);
  }
  return value;
}

const flag = (query, key, fallback = true) =>
  query[key] === undefined ? fallback : query[key] === true || query[key] === "true";

const choice = (query, key, options, fallback) => {
  const value = query[key] ?? fallback;
  if (!(value in options)) throw new Error(`Invalid value for ${key}: ${value}`);
  return value;
};

function haulParams(q) {
  return {
    maxJumps: number(q, "jumps", SCAN_DEFAULTS.maxJumps, { min: 0, max: 30 }),
    minSecurity: number(q, "min_security", SCAN_DEFAULTS.minSecurity, { min: -1, max: 1 }),
    salesTax: number(q, "sales_tax", 7.5, { min: 0, max: 100 }) / 100,
    cargoM3: number(q, "cargo", null, { min: 0 }),
    maxIsk: number(q, "isk", null, { min: 0 }),
    minProfit: number(q, "min_profit", SCAN_DEFAULTS.minProfit, { min: 0 }),
    volumeCap: flag(q, "volume_check") ? number(q, "volume_cap", 1.0, { min: 0 }) : null,
    historyDays: SCAN_DEFAULTS.historyDays,
    maxPriceRatio: flag(q, "price_check") ? number(q, "max_price_ratio", 2.0, { min: 1 }) : null,
  };
}

function stationParams(q) {
  return {
    maxJumps: number(q, "jumps", STATION_DEFAULTS.maxJumps, { min: 0, max: 30 }),
    minSecurity: number(q, "min_security", STATION_DEFAULTS.minSecurity, { min: -1, max: 1 }),
    salesTax: number(q, "sales_tax", 7.5, { min: 0, max: 100 }) / 100,
    brokerFee: number(q, "broker_fee", 3.0, { min: 0, max: 100 }) / 100,
    maxIsk: number(q, "isk", null, { min: 0 }),
    volumeShare: number(q, "volume_share", 10.0, { min: 0, max: 100 }) / 100,
    minMargin: number(q, "min_margin", 5.0, { min: 0 }) / 100,
    minDailyProfit: number(q, "min_profit", STATION_DEFAULTS.minDailyProfit, { min: 0 }),
    maxPriceRatio: flag(q, "price_check") ? number(q, "max_price_ratio", 2.0, { min: 1 }) : null,
    historyDays: STATION_DEFAULTS.historyDays,
  };
}

// ---------- JSON shaping ----------

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const roundOrNull = (value, digits) => (value === null ? null : round(value, digits));

function stationJson(universe, station) {
  const system = universe.systems.get(station.systemId);
  return { id: station.id, name: station.name, system: system.name, security: system.displaySecurity,
           region: universe.regions.get(system.regionId) };
}

const itemJson = (item) => ({ id: item.id, name: item.name, volume: item.volume });

function opportunityJson(universe, o) {
  const f = o.fill;
  const premium = pricePremium(o);
  return {
    item: itemJson(o.item),
    source: { ...stationJson(universe, o.source), jumps_from_origin: o.jumpsToSource },
    destination: { ...stationJson(universe, o.destination), jumps_from_source: o.jumpsToDestination },
    units: f.units,
    cost: round(f.cost, 2),
    revenue: round(f.revenue, 2),
    profit: round(f.profit, 2),
    roi: round(roi(o), 4),
    total_jumps: totalJumps(o),
    profit_per_jump: round(profitPerJump(o), 2),
    volume_m3: round(f.units * o.item.volume, 2),
    max_buy_price: f.maxBuyPrice,
    min_sell_price: f.minSellPrice,
    avg_sell_price: round(f.gross / f.units, 2),
    daily_volume: roundOrNull(o.dailyVolume, 1),
    average_price: roundOrNull(o.averagePrice, 2),
    price_premium: roundOrNull(premium, 4),
    max_bid_price: roundOrNull(o.maxBidPrice, 2),
  };
}

function stationTradeJson(universe, t) {
  return {
    item: itemJson(t.item),
    station: { ...stationJson(universe, t.station), jumps_from_origin: t.jumps },
    best_bid: t.bestBid,
    best_ask: t.bestAsk,
    buy_price: t.buyPrice,
    sell_price: t.sellPrice,
    unit_cost: round(t.unitCost, 2),
    margin: round(t.margin, 2),
    roi: round(t.roi, 4),
    bid_orders: t.bidOrders,
    ask_orders: t.askOrders,
    daily_volume: roundOrNull(t.dailyVolume, 1),
    average_price: roundOrNull(t.averagePrice, 2),
    units_per_day: t.unitsPerDay,
    daily_profit: roundOrNull(t.dailyProfit, 2),
    capital: roundOrNull(t.capital, 2),
  };
}

const originJson = (system) => ({ id: system.id, name: system.name, security: system.displaySecurity });

/** Sort, and unless `allRoutes` keep only the best route per item. */
export function rank(opportunities, sort, allRoutes) {
  const key = HAUL_SORT[sort];
  const ranked = [...opportunities].sort((a, b) => key(b) - key(a));
  if (allRoutes) return ranked;
  const best = new Map();
  for (const o of ranked) if (!best.has(o.item.id)) best.set(o.item.id, o);
  return [...best.values()];
}

// ---------- service ----------

export class Market {
  constructor(universe, esi) {
    this.universe = universe;
    this.esi = esi;
    this.ordersByRegion = new Map();  // regionId -> {expires, orders}
    this.loading = new Map();         // regionId -> Promise, so concurrent scans share a fetch
  }

  async regionOrders(regionId, progress) {
    const cached = this.ordersByRegion.get(regionId);
    if (cached && cached.expires > Date.now()) return cached.orders;
    if (!this.loading.has(regionId)) {
      const name = this.universe.regions.get(regionId);
      const load = this.esi.regionOrders(regionId, (done, total) => progress(`${name}: ${done}/${total} pages`))
        .then((result) => {
          this.ordersByRegion.set(regionId, result);
          return result.orders;
        })
        .finally(() => this.loading.delete(regionId));
      this.loading.set(regionId, load);
    }
    return this.loading.get(regionId);
  }

  async orders(regionIds, progress) {
    const perRegion = await Promise.all([...regionIds].map((r) => this.regionOrders(r, progress)));
    return perRegion.flat();
  }

  /** Recent trading stats per "regionId:typeId". */
  async stats(keys, days, progress) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const byRegion = new Map();
    for (const key of keys) {
      const [regionId, typeId] = key.split(":").map(Number);
      if (!byRegion.has(regionId)) byRegion.set(regionId, new Set());
      byRegion.get(regionId).add(typeId);
    }
    const result = new Map();
    await Promise.all([...byRegion].map(async ([regionId, typeIds]) => {
      const name = this.universe.regions.get(regionId);
      const histories = await this.esi.regionHistory(regionId, typeIds,
        (done, total) => progress(`Market history for ${name}: ${done}/${total} items`));
      for (const [typeId, rows] of histories) result.set(`${regionId}:${typeId}`, marketStats(rows, since, days));
    }));
    return result;
  }

  regionKey(station, typeId) {
    return `${this.universe.systems.get(station.systemId).regionId}:${typeId}`;
  }

  /** Hauling scan; `query` uses the Python API's parameter names and units. */
  async scan(query, progress = () => {}) {
    const started = performance.now();
    const origin = this.universe.systemByName(query.origin ?? "");
    const params = haulParams(query);
    const reachable = this.universe.distancesFrom(origin.id, params.minSecurity, params.maxJumps);
    const regionIds = new Set([...reachable.keys()].map((s) => this.universe.systems.get(s).regionId));
    const orders = await this.orders(regionIds, progress);
    progress(`Searching ${orders.length.toLocaleString()} orders…`);
    const index = indexOrders(this.universe, orders, reachable);
    let found = findOpportunities(this.universe, index, origin.id, params);
    if (needsHistory(params) && found.length) {
      // Only fetch history for candidates that are profitable before the checks.
      const keys = new Set(found.map((o) => this.regionKey(o.destination, o.item.id)));
      const stats = await this.stats(keys, params.historyDays, progress);
      found = findOpportunities(this.universe, index, origin.id, params, stats);
    }
    const ranked = rank(found, choice(query, "sort", HAUL_SORT, "profit"), flag(query, "all_routes", false));
    const limit = number(query, "limit", 50, { min: 1, max: 500 });
    return {
      origin: originJson(origin),
      regions: [...regionIds].map((r) => this.universe.regions.get(r)).sort(),
      order_count: orders.length,
      total: ranked.length,
      elapsed: round((performance.now() - started) / 1000, 2),
      opportunities: ranked.slice(0, limit).map((o) => opportunityJson(this.universe, o)),
    };
  }

  /** Station trading scan; `query` uses the Python API's parameter names and units. */
  async stationScan(query, progress = () => {}) {
    const started = performance.now();
    const origin = this.universe.systemByName(query.origin ?? "");
    const params = stationParams(query);
    const reachable = this.universe.distancesFrom(origin.id, params.minSecurity, params.maxJumps);
    const regionIds = new Set([...reachable.keys()].map((s) => this.universe.systems.get(s).regionId));
    const orders = await this.orders(regionIds, progress);
    progress(`Searching ${orders.length.toLocaleString()} orders…`);
    const index = indexOrders(this.universe, orders, reachable);
    // Wide spreads are everywhere on illiquid items; screen them against CCP's universe-wide
    // average prices before spending one history request per item.
    const reference = params.maxPriceRatio !== null ? await this.esi.averagePrices() : null;
    const candidates = findStationTrades(this.universe, index, origin.id, params, null, reference);
    const keys = new Set(candidates.map((t) => this.regionKey(t.station, t.item.id)));
    const stats = await this.stats(keys, params.historyDays, progress);
    const key = STATION_SORT[choice(query, "sort", STATION_SORT, "profit")];
    const trades = findStationTrades(this.universe, index, origin.id, params, stats)
      .sort((a, b) => key(b) - key(a));
    const limit = number(query, "limit", 100, { min: 1, max: 1000 });
    return {
      origin: originJson(origin),
      regions: [...regionIds].map((r) => this.universe.regions.get(r)).sort(),
      order_count: orders.length,
      candidates: candidates.length,
      total: trades.length,
      elapsed: round((performance.now() - started) / 1000, 2),
      trades: trades.slice(0, limit).map((t) => stationTradeJson(this.universe, t)),
    };
  }

  /** Solar systems whose name starts with `q` (for autocomplete). */
  systems(q, limit = 10) {
    const prefix = q.trim().toLowerCase();
    return [...this.universe.systems.values()]
      .filter((s) => s.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, limit)
      .map((s) => ({ id: s.id, name: s.name, security: s.displaySecurity, region: this.universe.regions.get(s.regionId) }));
  }

  status() {
    const now = Date.now();
    return {
      regions: [...this.ordersByRegion].map(([id, { orders, expires }]) => ({
        id, name: this.universe.regions.get(id), orders: orders.length, expires_in: Math.round((expires - now) / 1000),
      })),
    };
  }
}
