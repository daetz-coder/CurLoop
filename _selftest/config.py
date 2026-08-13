"""Load project config from config.json next to this module."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_CONFIG_PATH = Path(__file__).resolve().parent / "config.json"


def load_config(path: Path | None = None) -> dict[str, Any]:
    """Read JSON config; return {} if the file is missing or empty."""
    cfg_path = path if path is not None else _CONFIG_PATH
    if not cfg_path.is_file():
        return {}
    text = cfg_path.read_text(encoding="utf-8").strip()
    if not text:
        return {}
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"config root must be an object, got {type(data).__name__}")
    return data
