"""Static universe: systems, stations, item types and the stargate jump graph."""

from __future__ import annotations

import json
import math
from collections import defaultdict, deque
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path


def display_security(sec: float) -> float:
    """Security status as shown in game: rounded to one decimal, but never 0.0 for positive values."""
    if 0.0 < sec < 0.05:
        return 0.1
    return round(math.floor(sec * 10 + 0.5) / 10, 1)


@dataclass(frozen=True, slots=True)
class System:
    id: int
    name: str
    security: float
    region_id: int

    @property
    def display_security(self) -> float:
        return display_security(self.security)


@dataclass(frozen=True, slots=True)
class Station:
    id: int
    name: str
    system_id: int


@dataclass(frozen=True, slots=True)
class ItemType:
    id: int
    name: str
    volume: float


class Universe:
    def __init__(
        self,
        regions: dict[int, str],
        systems: Iterable[System],
        stations: Iterable[Station],
        types: Iterable[ItemType],
        gates: Iterable[tuple[int, int]],
    ):
        self.regions = regions
        self.systems = {s.id: s for s in systems}
        self.stations = {s.id: s for s in stations}
        self.types = {t.id: t for t in types}
        self.neighbors: dict[int, list[int]] = defaultdict(list)
        for a, b in gates:
            self.neighbors[a].append(b)
            self.neighbors[b].append(a)
        self._by_name = {s.name.lower(): s for s in self.systems.values()}
        self._distance_cache: dict[tuple[int, float, int | None], dict[int, int]] = {}

    @classmethod
    def load(cls, path: Path) -> Universe:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            regions={int(k): v for k, v in raw["regions"].items()},
            systems=(System(int(k), n, sec, r) for k, (n, sec, r) in raw["systems"].items()),
            stations=(Station(int(k), n, sys) for k, (n, sys) in raw["stations"].items()),
            types=(ItemType(int(k), n, vol) for k, (n, vol) in raw["types"].items()),
            gates=(tuple(g) for g in raw["gates"]),
        )

    def system_by_name(self, name: str) -> System:
        try:
            return self._by_name[name.strip().lower()]
        except KeyError:
            prefix = name.strip().lower()
            matches = sorted(s.name for n, s in self._by_name.items() if n.startswith(prefix))
            hint = f" Did you mean: {', '.join(matches[:8])}?" if matches else ""
            raise KeyError(f"Unknown system '{name}'.{hint}") from None

    def distances_from(
        self, origin: int, min_security: float = -1.0, max_jumps: int | None = None
    ) -> dict[int, int]:
        """Jump counts from ``origin`` to every reachable system.

        The route only enters systems whose displayed security is at least
        ``min_security``; the origin itself is always allowed so you can start
        in low-sec and still restrict the route to high-sec.
        """
        key = (origin, min_security, max_jumps)
        if key in self._distance_cache:
            return self._distance_cache[key]

        dist = {origin: 0}
        queue = deque([origin])
        while queue:
            current = queue.popleft()
            d = dist[current]
            if max_jumps is not None and d >= max_jumps:
                continue
            for nxt in self.neighbors[current]:
                if nxt not in dist and self.systems[nxt].display_security >= min_security:
                    dist[nxt] = d + 1
                    queue.append(nxt)

        self._distance_cache[key] = dist
        return dist

    def jumps(self, a: int, b: int, min_security: float = -1.0) -> int | None:
        """Shortest jump count between two systems, or None if unreachable under the security filter."""
        return self.distances_from(a, min_security).get(b)
