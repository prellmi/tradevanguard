# TradeVanguard

EVE TradeVanguard - Golden Route identification and station trading.

Finds EVE Online trade opportunities around a solar system using public market
data from the EVE Swagger Interface (ESI):

- **Hauling:** buy from sell orders at station A, carry the goods to station B,
  sell into buy orders there.
- **Station trading:** place a buy order and a sell order at the same station and
  earn the spread.

## Setup

Requires [uv](https://docs.astral.sh/uv/).

```sh
uv sync
# CCP asks for contact info in the User-Agent (e-mail or in-game name):
$env:TRADEVANGUARD_CONTACT = "you@example.com"   # PowerShell
```

The first run downloads CCP's Static Data Export (~100 MB) and reduces it to
`data/universe-<build>.json` (~2 MB). Run `uv run tradevanguard update-sde`
after a game patch to refresh it.

## Usage

```sh
uv run tradevanguard scan Jita --jumps 5 --cargo 10000 --isk 500m
uv run tradevanguard scan Dodixie --jumps 8 --sort jump --sales-tax 3.37
uv run tradevanguard scan Rens --min-security -1   # allow low/null-sec routes
```

| Option | Meaning |
|---|---|
| `--jumps` | search radius around the origin (pickup and drop-off) |
| `--min-security` | lowest displayed security to route through (0.5 = high-sec only) |
| `--cargo` / `--isk` | cargo capacity in m³ and max investment per trade (`250k`, `500m`, `1.5b`) |
| `--sales-tax` | percent; 7.5 untrained, lower with Accounting skill |
| `--min-profit` | drop trades below this profit |
| `--volume-cap` | haul at most this many days of the destination region's average traded volume (default 1) |
| `--history-days` / `--no-volume-check` | averaging window (default 30 days) / skip the volume cap |
| `--max-price-ratio` / `--no-price-check` | ignore buy orders priced above this multiple of the regional average (default 2) / trust any price |
| `--sort` | `profit`, `jump` (profit per jump incl. travel to pickup) or `roi` |
| `--all-routes` | show every station pair, not just the best route per item |

Market data is cached in `data/cache/` until ESI's `Expires` time (~5 minutes for
orders, until the next downtime for history).

### Volume check

Candidate trades are checked against ESI market history for the destination
region. Each trade is capped at `--volume-cap` × the average units traded per day
(days without trades count as zero), so items that barely trade drop out and big
hauls are scaled to what the market actually moves.

### Price check

The same history gives each item's volume-weighted average price in the destination
region. Buy orders priced above `--max-price-ratio` × that average are ignored as
likely bait or manipulation; the trade is still offered if normally priced buy
orders remain. Items with no recent trades have no reference price and are dropped.
Results show how far the average sale price is above or below the regional average
(`vs avg`); the web page highlights anything more than 25 % above.

Unusually cheap *sell* orders are not filtered: a mispriced sell order is a genuine
bargain for the buyer, not a risk.

## Station trading

```sh
uv run tradevanguard station Jita --isk 200m
uv run tradevanguard station Amarr --broker-fee 1.5 --sales-tax 3.37 --sort roi
```

| Option | Meaning |
|---|---|
| `--jumps` | also include stations this many jumps away (default 0 = origin system) |
| `--isk` | max capital tied up per item and day |
| `--broker-fee` | percent per order placed (default 3; lower with Broker Relations and standings) |
| `--sales-tax` | percent, as for hauling |
| `--volume-share` | percent of the region's daily volume you expect to trade yourself (default 10) |
| `--min-margin` | minimum ROI per unit after fees, percent (default 5) |
| `--min-profit` | minimum expected profit per day |
| `--max-price-ratio` / `--no-price-check` | skip spreads whose best sell order is above, or best buy order below, this multiple of the regional average |
| `--sort` | `profit` (per day) or `roi` |

Prices are one tick inside the spread: outbid the best buy order, undercut the best
sell order. EVE limits order prices to four significant digits, so the tick grows
with the price (1 ISK at 1,234; 1,000 ISK at 1,234,000).

Margin per unit = sell price × (1 − broker fee − sales tax) − buy price × (1 + broker fee).
Expected units per day = your volume share × the region's average daily volume,
capped by `--isk`.

Almost every item has a wide spread somewhere, mostly from junk orders on illiquid
items. Candidates are therefore first screened against CCP's universe-wide average
prices (`/markets/prices/`, one request) before market history is fetched per item.
The first station scan of a busy region each day still needs a few thousand history
requests (about two minutes for The Forge); later scans that day are instant.

The `vs avg` column compares your sell price with the regional average. A large
premium means most of the volume trades near the buy orders, so a sell order at the
top of the spread will fill slower than the volume estimate suggests.

Relisting costs (updating orders to stay on top) are not included.

## Web app

```sh
uv run tradevanguard serve            # open http://127.0.0.1:8000
```

Switch between **Hauling** and **Station trading** at the top; each mode has its
own filters and keeps its last results. The page has the same filters as the CLI
(ISK fields accept `250k`, `500m`, `1.5b`),
a results table sortable by any column, and rows that expand to show the full
station names, the price limits to buy and sell at, and a button to copy the item
name for the in-game market search. Your filters are remembered in the browser, and
"Rescan every 5 min" keeps the results current while you fly.

The frontend is plain HTML/CSS/JS in `src/tradevanguard/static/`, with no build step.

### API

Interactive docs at http://127.0.0.1:8000/docs.

| Endpoint | Purpose |
|---|---|
| `GET /api/scan?origin=Jita&jumps=5&cargo=10000&isk=500000000` | same options as the CLI (`min_security`, `sales_tax`, `min_profit`, `volume_cap`, `volume_check`, `max_price_ratio`, `price_check`, `sort`, `all_routes`, `limit`) |
| `GET /api/station?origin=Jita&isk=200000000` | station trading, same options as the CLI (`jumps`, `broker_fee`, `sales_tax`, `volume_share`, `min_margin`, `min_profit`, `max_price_ratio`, `price_check`, `sort`, `limit`) |
| `GET /api/systems?q=Ji` | system name autocomplete |
| `GET /api/status` | regions held in memory, order counts, seconds until refresh |

The server keeps orders in memory and refreshes every region used in the last hour
as soon as ESI publishes new data, so repeat scans take a couple of seconds.
Regions idle for an hour are dropped from memory.

## Browser version (GitHub Pages)

`web/` is a static build of the same app that needs no server: the browser downloads
market data straight from ESI (which allows cross-origin requests) and runs a
JavaScript port of the engine in a Web Worker, so the page stays responsive.

| Path | Purpose |
|---|---|
| `web/engine/` | JavaScript port of `universe.py`, `trade.py`, `station.py`, `esi.py` and `market.py` |
| `web/engine/worker.js` | Web Worker hosting the engine; the page talks to it by message |
| `web/index.html`, `app.js`, `style.css` | the same UI as the Python server's, calling the worker instead of `/api` |
| `web/data/universe.json` | generated by `tradevanguard export-universe`, not committed |

Run it locally (module workers need http, not `file://`):

```sh
uv run tradevanguard export-universe
uv run python -m http.server 8000 -d web      # open http://127.0.0.1:8000
```

Differences from the Python server:

- Market history and CCP's average prices are cached in IndexedDB; orders rely on
  the browser's HTTP cache (ESI sends `Cache-Control: public` with `Expires`).
- No background refresh: data is fetched when you scan.
- Requests carry no custom headers, so they are CORS simple requests without
  preflight. Browsers can't set `User-Agent`, so the app identifies itself with
  ESI's `user_agent` query parameter.
- The browser fetches in parallel over HTTP/2, so first scans are faster than the
  Python version (a first Jita station scan takes about 20 seconds).

Tests:

```sh
node --test "web/tests/*.test.mjs"                       # engine unit tests
uv run python web/tests/parity/python_results.py out.json
node web/tests/parity/compare.mjs out.json               # Python vs JS on cached ESI data
```

The parity check feeds both engines the same cached orders and history (from your
Python scans in `data/cache`) and requires identical results.

Deployment: `.github/workflows/pages.yml` tests the engine, exports the universe
from the latest SDE and publishes `web/` on every push to the `browser` branch,
plus weekly to pick up game patches. It needs GitHub Pages enabled with
**Source: GitHub Actions** in the repository settings.

## How it works

- `sde.py` reduces the SDE to systems, stargates, NPC stations and item volumes.
- `universe.py` holds the jump graph; BFS with a security filter gives distances.
- `esi.py` pages through `/markets/{region_id}/orders/` concurrently, respects the
  error limit and rate limits, and retries if ESI refreshes data mid-fetch. It also
  fetches `/markets/{region_id}/history/` (one cache file per region) and
  `/markets/prices/`.
- `trade.py` walks both order books per item and station pair, matching units while
  `buy price * (1 - sales tax)` beats the ask, within cargo, ISK, volume and `min_volume` limits.
- `station.py` finds station trading spreads: price ticks, fees, volume and price checks.
- `market.py` is the service shared by CLI and API: in-memory order cache, history
  stats, the scan pipeline and the background refresher.
- `api.py` is the FastAPI app serving the API and the `static/` frontend; `cli.py` the command line.

## Known simplifications

- Player structures are ignored (NPC stations only).
- Goods are always delivered to the buy order's own station; buy order `range`
  (selling remotely from a nearby station) is not used yet.
- History is region-wide, so a station that rarely sees trades can still pass the volume
  check, and station trading volume estimates assume the hub carries the region's volume.

## Tests

```sh
uv run pytest
```
