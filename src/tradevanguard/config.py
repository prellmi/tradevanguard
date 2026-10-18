"""Settings from environment variables."""

from __future__ import annotations

import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("TRADEVANGUARD_DATA", "data"))


def user_agent() -> str:
    # CCP asks for contact info in the User-Agent so they can reach you instead of banning you.
    contact = os.environ.get("TRADEVANGUARD_CONTACT")
    return f"tradevanguard/0.1 ({contact})" if contact else "tradevanguard/0.1"
