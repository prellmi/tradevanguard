// Station trading: buy with a buy order and resell with a sell order at the same station.
// Both orders pay a broker fee; the sale also pays sales tax.

export const STATION_DEFAULTS = {
  maxJumps: 0,
  minSecurity: 0.5,
  salesTax: 0.075,
  brokerFee: 0.03,
  maxIsk: null,
  volumeShare: 0.1,
  minMargin: 0.05,
  minDailyProfit: 1_000_000,
  maxPriceRatio: 2.0,
  historyDays: 30,
};

/** Smallest allowed price step at `price`: orders are limited to 4 significant digits. */
export function priceTick(price) {
  if (price <= 0) return 0.01;
  return Math.max(0.01, 10 ** (Math.floor(Math.log10(price)) - 3));
}

const round2 = (value) => Math.round(value * 100) / 100;
export const outbid = (price) => round2(price + priceTick(price));
// Use the step just below the price, so 1,000.00 undercuts to 999.90 rather than 999.00.
export const undercut = (price) => round2(price - priceTick(price * (1 - 1e-9)));

/** Both sides of the spread lie within `ratio` of the average price; otherwise it's built on outliers. */
const plausible = (bestBid, bestAsk, average, ratio) => average / ratio <= bestBid && bestAsk <= average * ratio;

/**
 * Items whose spread pays at least `params.minMargin` after fees. Without `stats` this is the
 * candidate pass (optionally screened against universe-wide `referencePrices`); with `stats`
 * trades get an expected daily volume and profit and are checked against the regional average.
 */
export function findStationTrades(universe, index, originId, params, stats = null, referencePrices = null) {
  const reachable = universe.distancesFrom(originId, params.minSecurity, params.maxJumps);
  const buyFee = 1 + params.brokerFee;
  const sellKeep = 1 - params.brokerFee - params.salesTax;
  const ratio = params.maxPriceRatio;
  const results = [];

  for (const [typeId, askStations] of index.asks) {
    const bidStations = index.bids.get(typeId);
    const item = universe.types.get(typeId);
    if (!bidStations || !item) continue;
    for (const [stationId, asks] of askStations) {
      const bids = bidStations.get(stationId);
      const station = universe.stations.get(stationId);
      if (!bids || !reachable.has(station.systemId)) continue;
      const bestBid = bids[0].price, bestAsk = asks[0].price;
      const buyPrice = outbid(bestBid), sellPrice = undercut(bestAsk);
      if (buyPrice >= sellPrice) continue;
      const unitCost = buyPrice * buyFee;
      const margin = sellPrice * sellKeep - unitCost;
      if (margin <= 0 || margin / unitCost < params.minMargin) continue;

      let market = null, units = null;
      if (stats !== null) {
        market = stats.get(`${universe.systems.get(station.systemId).regionId}:${typeId}`);
        if (!market || !market.averagePrice) continue;
        if (ratio !== null && !plausible(bestBid, bestAsk, market.averagePrice, ratio)) continue;
        units = Math.floor(market.dailyVolume * params.volumeShare);
        if (params.maxIsk) units = Math.min(units, Math.floor(params.maxIsk / unitCost));
        if (units < 1 || units * margin < params.minDailyProfit) continue;
      } else if (referencePrices !== null && ratio !== null) {
        const reference = referencePrices.get(typeId);
        if (!reference || !plausible(bestBid, bestAsk, reference, ratio)) continue;
      }

      results.push({
        item, station, jumps: reachable.get(station.systemId), bestBid, bestAsk, buyPrice, sellPrice,
        unitCost, margin, roi: margin / unitCost, bidOrders: bids.length, askOrders: asks.length,
        dailyVolume: market ? market.dailyVolume : null,
        averagePrice: market ? market.averagePrice : null,
        unitsPerDay: units,
        dailyProfit: units === null ? null : units * margin,
        capital: units === null ? null : units * unitCost,
      });
    }
  }
  results.sort((a, b) => (b.dailyProfit ?? 0) - (a.dailyProfit ?? 0) || b.roi - a.roi
    || a.item.id - b.item.id || a.station.id - b.station.id);
  return results;
}
