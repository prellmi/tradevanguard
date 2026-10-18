// Hauling: buy from sell orders at A, carry to B, sell into buy orders at B.
// Port of src/tradevanguard/trade.py. Both legs are instant, so only sales tax applies.

export const SCAN_DEFAULTS = {
  maxJumps: 5,
  minSecurity: 0.5,
  salesTax: 0.075,
  cargoM3: null,
  maxIsk: null,
  minProfit: 1_000_000,
  volumeCap: 1.0,        // haul at most this many days of destination volume; null disables
  historyDays: 30,
  maxPriceRatio: 2.0,    // ignore buy orders above this multiple of the regional average; null disables
};

export const needsHistory = (params) => params.volumeCap !== null || params.maxPriceRatio !== null;

/**
 * Match the cheapest sell orders (asks, ascending) against the highest buy orders (bids, descending)
 * while each unit stays profitable. Greedy matching is optimal for one source/destination pair.
 */
export function planFill(asks, bids, { salesTax, unitVolume, cargoM3 = null, maxIsk = null,
                                       maxUnits = null, maxBidPrice = null }) {
  const keep = 1 - salesTax;
  let unitCap = cargoM3 && unitVolume > 0 ? Math.floor(cargoM3 / unitVolume) : Infinity;
  if (maxUnits !== null) unitCap = Math.min(unitCap, maxUnits);
  let iskLeft = maxIsk ? maxIsk : Infinity;
  const askLeft = asks.map((a) => a.volume_remain);
  let i = 0;
  let units = 0, cost = 0, revenue = 0, gross = 0;
  let maxBuy = 0, minSell = Infinity;

  // Units we could still deliver to a bid paying `net` per unit, stopping once `want` is reached.
  const deliverable = (net, want) => {
    let total = 0, isk = iskLeft;
    for (let j = i; total < want && j < asks.length && asks[j].price < net; j++) {
      const q = Math.min(askLeft[j], want - total, unitCap - units - total, Math.floor(isk / asks[j].price));
      if (q <= 0) break;
      total += q;
      isk -= q * asks[j].price;
    }
    return total;
  };

  for (const bid of bids) {
    if (maxBidPrice !== null && bid.price > maxBidPrice) continue;
    const net = bid.price * keep;
    if (i === asks.length || asks[i].price >= net || units >= unitCap) break;
    // A buy order with a minimum volume rejects smaller sales, so skip it if we can't meet it.
    if (bid.min_volume > 1 && deliverable(net, bid.min_volume) < bid.min_volume) continue;
    let bidLeft = bid.volume_remain;
    while (bidLeft && i < asks.length && asks[i].price < net) {
      const q = Math.min(bidLeft, askLeft[i], unitCap - units, Math.floor(iskLeft / asks[i].price));
      if (q <= 0) break;
      units += q;
      cost += q * asks[i].price;
      revenue += q * net;
      gross += q * bid.price;
      iskLeft -= q * asks[i].price;
      maxBuy = Math.max(maxBuy, asks[i].price);
      minSell = Math.min(minSell, bid.price);
      bidLeft -= q;
      askLeft[i] -= q;
      if (askLeft[i] === 0) i++;
    }
    if (bidLeft && i < asks.length && asks[i].price < net) break;  // stopped by cargo, ISK or volume cap
  }

  if (units === 0) return null;
  return { units, cost, revenue, gross, maxBuyPrice: maxBuy, minSellPrice: minSell, profit: revenue - cost };
}

/**
 * Group orders in `systems` by item and station. Sell orders (is_buy_order=false) go to `asks`,
 * cheapest first; buy orders go to `bids`, highest first. Player structures are skipped.
 */
export function indexOrders(universe, orders, systems) {
  const asks = new Map();
  const bids = new Map();
  for (const o of orders) {
    if (!universe.stations.has(o.location_id) || !systems.has(o.system_id)) continue;
    const side = o.is_buy_order ? bids : asks;
    let byStation = side.get(o.type_id);
    if (!byStation) side.set(o.type_id, (byStation = new Map()));
    let book = byStation.get(o.location_id);
    if (!book) byStation.set(o.location_id, (book = []));
    book.push(o);
  }
  for (const byStation of asks.values()) for (const book of byStation.values()) book.sort((a, b) => a.price - b.price);
  for (const byStation of bids.values()) for (const book of byStation.values()) book.sort((a, b) => b.price - a.price);
  return { asks, bids };
}

/**
 * All profitable source/destination pairs within `params.maxJumps` of the origin, best profit first.
 * With `stats` (Map "regionId:typeId" -> {dailyVolume, averagePrice}) trades are capped by volume
 * and checked against the regional average price; items without stats are dropped.
 */
export function findOpportunities(universe, index, originId, params, stats = null) {
  const reachable = universe.distancesFrom(originId, params.minSecurity, params.maxJumps);
  const keep = 1 - params.salesTax;
  const results = [];

  for (const [typeId, askStations] of index.asks) {
    const bidStations = index.bids.get(typeId);
    const item = universe.types.get(typeId);
    if (!bidStations || !item) continue;
    for (const [srcId, srcBook] of askStations) {
      const src = universe.stations.get(srcId);
      if (!reachable.has(src.systemId)) continue;
      for (const [dstId, dstBook] of bidStations) {
        if (dstBook[0].price * keep <= srcBook[0].price) continue;
        const dst = universe.stations.get(dstId);
        if (!reachable.has(dst.systemId)) continue;

        let market = null, maxUnits = null, maxBid = null;
        if (stats !== null) {
          market = stats.get(`${universe.systems.get(dst.systemId).regionId}:${typeId}`);
          if (!market) continue;
          if (params.volumeCap !== null) {
            maxUnits = Math.floor(market.dailyVolume * params.volumeCap);
            if (maxUnits < 1) continue;
          }
          if (params.maxPriceRatio !== null) {
            if (!market.averagePrice) continue;  // never traded recently, no reference price
            maxBid = market.averagePrice * params.maxPriceRatio;
            if (maxBid * keep <= srcBook[0].price) continue;
          }
        }
        const route = universe.jumps(src.systemId, dst.systemId, params.minSecurity);
        if (route === null) continue;
        const fill = planFill(srcBook, dstBook, {
          salesTax: params.salesTax, unitVolume: item.volume, cargoM3: params.cargoM3,
          maxIsk: params.maxIsk, maxUnits, maxBidPrice: maxBid,
        });
        if (fill === null || fill.profit < params.minProfit) continue;
        results.push({
          item, source: src, destination: dst, fill,
          jumpsToSource: reachable.get(src.systemId), jumpsToDestination: route,
          dailyVolume: market ? market.dailyVolume : null,
          averagePrice: market ? market.averagePrice : null,
          maxBidPrice: maxBid,
        });
      }
    }
  }
  // NPC-seeded orders often tie exactly; prefer the shorter route, then keep the order stable.
  results.sort((a, b) => b.fill.profit - a.fill.profit || totalJumps(a) - totalJumps(b)
    || a.source.id - b.source.id || a.destination.id - b.destination.id);
  return results;
}

export function totalJumps(o) {
  return o.jumpsToSource + o.jumpsToDestination;
}
export const profitPerJump = (o) => o.fill.profit / Math.max(1, totalJumps(o));
export const roi = (o) => o.fill.profit / o.fill.cost;
export const pricePremium = (o) => (o.averagePrice ? o.fill.gross / o.fill.units / o.averagePrice - 1 : null);
