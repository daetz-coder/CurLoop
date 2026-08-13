"""CLI entry point for the selftest project."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_README = Path(__file__).resolve().parent / "README.md"
_VERSION_RE = re.compile(r"^##\s+Current version:\s*(\S+)", re.MULTILINE)


def read_version(readme: Path | None = None) -> str:
    """Parse the current version string from README.md."""
    path = readme if readme is not None else _README
    text = path.read_text(encoding="utf-8")
    match = _VERSION_RE.search(text)
    if not match:
        raise RuntimeError(f"version not found in {path}")
    return match.group(1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cli", description="Selftest project CLI")
    parser.add_argument(
        "--version",
        action="store_true",
        help="print the current version from README.md",
    )
    args = parser.parse_args(argv)
    if args.version:
        print(read_version())
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
