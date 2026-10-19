# TradeVanguard

EVE TradeVanguard - Golden Route identification and station trading.

**Live: https://prellmi.github.io/tradevanguard/**

Finds EVE Online trade opportunities around a solar system using public market
data from the EVE Swagger Interface (ESI). It runs entirely in your browser: the
page downloads orders straight from ESI and does the number crunching in a Web
Worker. There is no server.

- **Hauling:** buy from sell orders at station A, carry the goods to station B,
  sell into buy orders there.
- **Station trading:** place a buy order and a sell order at the same station and
  earn the spread.

Only NPC stations are considered; player structures need a logged-in character.

## Using the app

- Switch between **Hauling** and **Station trading** at the top. Each mode has its
  own filters and keeps its last results while you switch.
- Type an origin system (names autocomplete), adjust the filters and press **Scan**.
  ISK fields accept shorthand such as `250k`, `500m` or `1.5b`.
- Click a column header to sort, and a row for details: full station names, the
  price limits to buy and sell at, and a button that copies the item name for the
  in-game market search.
- Your filters are remembered in the browser. **Rescan every 5 min** keeps the
  results current while you fly.
- The first scan of a region downloads all its orders, and the page shows progress
  while it does.

## Hauling

Pick an origin system and a radius; both pickup and drop-off must lie within it.
For each item and station pair the engine walks both order books, buying the
cheapest sell orders and selling into the highest buy orders while the buy order's
price × (1 − sales tax) still beats the sell order you buy from, within your cargo
space, ISK budget and each buy order's minimum volume. Routes respect the chosen
security level (high-sec only by default).

- **Volume check:** each trade is capped at a number of days (default 1) of the
  destination region's average traded volume over the last 30 days, so items that
  barely trade drop out and big hauls are scaled to what the market moves.
- **Price check:** buy orders priced above a multiple (default 2×) of the
  destination region's average price are ignored as likely bait or manipulation.
  Unusually cheap *sell* orders are kept: a mispriced sell order is a real bargain.
- `vs avg` shows how far the average sale price lies above the regional average;
  anything more than 25 % above is highlighted.
- Equally profitable routes (common with NPC-seeded orders) prefer fewer jumps.

## Station trading

By default only stations in the origin system are considered; raise **Include
stations within (jumps)** to scan nearby stations too.

Your prices are one tick inside the spread: just above the highest buy order and
just below the lowest sell order. EVE limits order prices to four significant
digits, so the tick grows with the price (1 ISK at 1,234; 1,000 ISK at 1,234,000).

- Margin per unit = sell price × (1 − broker fee − sales tax) − buy price × (1 + broker fee)
- Units per day = your share of the region's daily volume (default 10 %), capped
  by the capital you set per item
- Spreads whose best sell order is above, or best buy order below, a multiple
  (default 2×) of the regional average are skipped as outliers.
- A large `vs avg` premium means most volume trades near the buy orders, so a sell
  order at the top of the spread fills slower than the estimate suggests.
- Relisting costs (updating orders to stay on top) are not included.

Almost every item has a wide spread somewhere, mostly from junk orders on illiquid
items, so candidates are first screened against CCP's universe-wide average
prices (one request) before market history is fetched per item.

## Data and caching

- **Orders** (`/markets/{region}/orders/`) are fetched in parallel; ESI caches
  them for 5 minutes and the browser's HTTP cache reuses them within that window.
- **History** (`/markets/{region}/history/`, one request per item) refreshes once a
  day at downtime and is kept in IndexedDB, so only the first scan of the day is
  slow (about 15–20 seconds for a Jita station scan).
- **Average prices** (`/markets/prices/`, one request for all items) are also kept
  in IndexedDB until ESI publishes new ones.
- Everything is cached per browser; there is no background refresh, so data is
  fetched when you scan.
- **Static data** (systems, stargates, stations, item volumes) comes from CCP's
  Static Data Export, reduced to `web/data/universe.json` (~2 MB) at deploy time.
- Requests carry no custom headers, so they are CORS simple requests without
  preflight. Browsers can't set `User-Agent`, so the app identifies itself with
  ESI's `user_agent` query parameter. The engine backs off on ESI's error limit
  and rate limits.

## Development

Requires Node.js 22 or newer (the test script relies on `node --test` file patterns);
there are no dependencies to install.

```sh
npm run build:data    # download the SDE and write web/data/universe.json
npm run serve         # http://127.0.0.1:8000 (module workers need http, not file://)
npm test              # engine unit tests
```

| Path | Purpose |
|---|---|
| `web/index.html`, `app.js`, `style.css` | the page: filters, results table, details |
| `web/engine/worker.js` | Web Worker hosting the engine; the page talks to it by message |
| `web/engine/market.js` | scan pipeline, history stats, result shaping |
| `web/engine/trade.js` | hauling: order book matching, volume and price checks |
| `web/engine/station.js` | station trading: price ticks, fees, spreads |
| `web/engine/esi.js` | ESI client with retries, error-limit handling and IndexedDB cache |
| `web/engine/universe.js` | jump graph and security-aware distances |
| `tools/build-universe.mjs` | reduces the SDE zip (streamed, no dependencies) |
| `tools/serve.mjs` | static server for local development |
| `tests/` | `node:test` unit tests |

## Deployment

`.github/workflows/pages.yml` runs the tests, builds the universe data from the
latest SDE and publishes `web/` to GitHub Pages on every push to `main`, plus
weekly to pick up game patches.

## Known simplifications

- Player structures are ignored.
- Goods are always delivered to the buy order's own station; buy order `range`
  (selling remotely from a nearby station) is not used yet.
- History is region-wide, so a station that rarely sees trades can still pass the
  volume check, and station trading assumes the hub carries the region's volume.

EVE Online and the EVE logo are trademarks of CCP hf. This project is not affiliated with CCP.
