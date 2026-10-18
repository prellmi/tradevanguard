"""Plain data types shared across modules."""

from __future__ import annotations

from typing import NamedTuple


class Order(NamedTuple):
    """One market order, reduced to the fields trading needs.

    A NamedTuple keeps memory low (The Forge alone has ~400k orders) and
    serialises to a compact JSON list for the on-disk cache.
    """

    order_id: int
    type_id: int
    location_id: int
    system_id: int
    price: float
    volume_remain: int
    min_volume: int
    is_buy_order: bool
    range: str

    @classmethod
    def from_esi(cls, raw: dict) -> Order:
        return cls(*(raw[field] for field in cls._fields))


class MarketStats(NamedTuple):
    """Trading activity of one item in one region over a recent window."""

    daily_volume: float   # average units traded per day, counting days without trades
    average_price: float  # volume-weighted; 0 if nothing traded

    @classmethod
    def from_history(cls, rows: list[list], since: str, days: int) -> MarketStats:
        """Summarise ESI history rows ``[date, average, volume]`` dated on or after ``since``."""
        window = [(avg, vol) for d, avg, vol in rows if d >= since]
        volume = sum(vol for _, vol in window)
        price = sum(avg * vol for avg, vol in window) / volume if volume else 0.0
        return cls(volume / days, price)
