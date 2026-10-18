"""Download CCP's Static Data Export (SDE) and reduce it to what trading needs.

The full SDE is ~100 MB zipped (~600 MB unpacked). We only read a handful of
tables from the zip and write a compact ``universe-<build>.json``.
"""

from __future__ import annotations

import json
import zipfile
from collections.abc import Iterator
from pathlib import Path

import httpx

SDE_BASE = "https://developers.eveonline.com/static-data/tranquility"
# Wormhole, Abyssal and other special regions start here; they have no stargates.
FIRST_SPECIAL_REGION_ID = 11_000_000

ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
         "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"]


def latest_build(client: httpx.Client) -> int:
    resp = client.get(f"{SDE_BASE}/latest.jsonl")
    resp.raise_for_status()
    return json.loads(resp.text.splitlines()[0])["buildNumber"]


def ensure_universe(data_dir: Path, *, update: bool = False) -> Path:
    """Return the path of the reduced universe file, downloading the SDE if needed."""
    data_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(data_dir.glob("universe-*.json"))
    if existing and not update:
        return existing[-1]

    with httpx.Client(timeout=60, follow_redirects=True) as client:
        build = latest_build(client)
        target = data_dir / f"universe-{build}.json"
        if target.exists():
            return target

        zip_path = data_dir / f"sde-{build}.zip"
        _download(client, f"{SDE_BASE}/eve-online-static-data-{build}-jsonl.zip", zip_path)

    print("Reducing SDE ...")
    build_universe_file(zip_path, target, build)
    zip_path.unlink()
    for old in existing:
        old.unlink()
    return target


def _download(client: httpx.Client, url: str, dest: Path) -> None:
    tmp = dest.with_suffix(".part")
    with client.stream("GET", url) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("Content-Length", 0))
        done = 0
        with tmp.open("wb") as fh:
            for chunk in resp.iter_bytes(1 << 20):
                fh.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\rDownloading SDE: {done / total:6.1%}", end="", flush=True)
    print()
    tmp.replace(dest)


def _rows(zf: zipfile.ZipFile, table: str) -> Iterator[dict]:
    member = next(n for n in zf.namelist() if n.rsplit("/", 1)[-1] == f"{table}.jsonl")
    with zf.open(member) as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def _en(names: dict | None) -> str:
    return (names or {}).get("en", "")


def _unique_names(zf: zipfile.ZipFile, table: str) -> dict[int, str]:
    """Celestials with a lore name, e.g. 'Amarr VIII (Oris)'. Only matching lines are parsed."""
    member = next(n for n in zf.namelist() if n.rsplit("/", 1)[-1] == f"{table}.jsonl")
    names = {}
    with zf.open(member) as fh:
        for line in fh:
            if b'"uniqueName"' in line:
                row = json.loads(line)
                names[row["_key"]] = _en(row["uniqueName"])
    return names


def station_name(station: dict, systems: dict, corps: dict, operations: dict,
                 celestial_names: dict[int, str]) -> str:
    """Rebuild the in-game NPC station name, e.g. 'Jita IV - Moon 4 - Caldari Navy Assembly Plant'."""
    name = systems[station["solarSystemID"]][0]
    planet = station.get("celestialIndex")
    if station.get("orbitID") in celestial_names:
        name = celestial_names[station["orbitID"]]
    elif planet:
        name += f" {ROMAN[planet] if planet < len(ROMAN) else planet}"
        if station.get("orbitIndex"):
            name += f" - Moon {station['orbitIndex']}"
    name += f" - {corps.get(station['ownerID'], '?')}"
    if station.get("useOperationName") and station.get("operationID") in operations:
        name += f" {operations[station['operationID']]}"
    return name


def build_universe_file(zip_path: Path, out_path: Path, build: int) -> None:
    with zipfile.ZipFile(zip_path) as zf:
        regions = {r["_key"]: _en(r["name"]) for r in _rows(zf, "mapRegions")
                   if r["_key"] < FIRST_SPECIAL_REGION_ID}
        systems = {s["_key"]: [_en(s["name"]), s["securityStatus"], s["regionID"]]
                   for s in _rows(zf, "mapSolarSystems") if s["regionID"] in regions}
        gates = sorted({tuple(sorted((g["solarSystemID"], g["destination"]["solarSystemID"])))
                        for g in _rows(zf, "mapStargates")
                        if g["solarSystemID"] in systems and g["destination"]["solarSystemID"] in systems})
        corps = {c["_key"]: _en(c["name"]) for c in _rows(zf, "npcCorporations")}
        operations = {o["_key"]: _en(o["operationName"]) for o in _rows(zf, "stationOperations")}
        celestial_names = _unique_names(zf, "mapPlanets") | _unique_names(zf, "mapMoons")
        stations = {s["_key"]: [station_name(s, systems, corps, operations, celestial_names), s["solarSystemID"]]
                    for s in _rows(zf, "npcStations") if s["solarSystemID"] in systems}
        # Items on the market are always packaged, so prefer the packaged volume.
        types = {t["_key"]: [_en(t["name"]), t.get("packagedVolume", t.get("volume", 0.0))]
                 for t in _rows(zf, "types") if t.get("published") and t.get("marketGroupID")}

    out_path.write_text(json.dumps({
        "build": build,
        "regions": regions,
        "systems": systems,
        "gates": gates,
        "stations": stations,
        "types": types,
    }), encoding="utf-8")
