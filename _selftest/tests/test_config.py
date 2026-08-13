"""Unit tests for config.load_config."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import load_config  # noqa: E402


class LoadConfigTests(unittest.TestCase):
    def test_missing_file_returns_empty_dict(self) -> None:
        missing = ROOT / "definitely_missing_config_for_test.json"
        self.assertFalse(missing.exists())
        self.assertEqual(load_config(missing), {})

    def test_reads_json_object(self) -> None:
        path = ROOT / "tests" / "_sample_config.json"
        path.write_text('{"name": "selftest", "n": 1}\n', encoding="utf-8")
        try:
            self.assertEqual(load_config(path), {"name": "selftest", "n": 1})
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
