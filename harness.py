"""CursorHarness CLI 入口（根目录）。

在任意目录运行本文件即可对"当前目录"执行 Harness（不切换工作目录）：

    python D:\\2026AppDev\\CursorHarness\\harness.py status
    python D:\\2026AppDev\\CursorHarness\\harness.py run --no-plan
    python D:\\2026AppDev\\CursorHarness\\harness.py plan

也可以把本文件所在目录加入 PATH 后直接 `harness.py status`。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from unattended.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
