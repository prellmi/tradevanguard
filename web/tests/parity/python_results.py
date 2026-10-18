"""Run the parity scenarios through the Python API, fed from cached ESI data (no network).

Usage: uv run python web/tests/parity/python_results.py OUTPUT.json
Writes {scenario name: API response} for compare.mjs to check against the browser engine.
"""

from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

from tradevanguard import config, sde
from tradevanguard.api import create_app
from tradevanguard.market import Market
from tradevanguard.models import Order
from tradevanguard.universe import Universe

HERE = Path(__file__).parent
FAR_FUTURE = time.time() + 86400


def read_cache(name: str):
    path = config.DATA_DIR / "cache" / name
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)["data"]  # ignore expiry: parity only needs identical inputs


class CachedESI:
    """Serves whatever is in data/cache; anything missing behaves like an empty market."""

    async def region_orders(self, region_id):
        return [Order(*o) for o in read_cache(f"orders-{region_id}.json.gz") or []], FAR_FUTURE

    async def region_history(self, region_id, type_ids):
        cached = {t: rows for t, _, rows in read_cache(f"history-{region_id}.json.gz") or []}
        return {t: cached.get(t, []) for t in type_ids}

    async def average_prices(self):
        return {t: p for t, p in read_cache("prices.json.gz") or []}, FAR_FUTURE


def main(output: Path) -> None:
    universe = Universe.load(sde.ensure_universe(config.DATA_DIR))
    scenarios = json.loads((HERE / "scenarios.json").read_text(encoding="utf-8"))
    endpoints = {"scan": "/api/scan", "station": "/api/station"}
    results = {}
    with TestClient(create_app(Market(universe, CachedESI()))) as client:
        for scenario in scenarios:
            resp = client.get(endpoints[scenario["type"]], params=scenario["params"])
            resp.raise_for_status()
            results[scenario["name"]] = resp.json()
    output.write_text(json.dumps(results), encoding="utf-8")
    print(f"Wrote {output}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
