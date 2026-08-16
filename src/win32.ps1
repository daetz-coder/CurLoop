param(
  [Parameter(Position = 0, Mandatory = $true)]
  [string]$Command,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# Force UTF-8 stdout: Node decodes child stdout as UTF-8. PowerShell 5.1
# defaults to the system ANSI codepage (GBK on zh-CN), which garbles
# non-ASCII window titles into replacement chars and breaks title matching.
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

# ---------------------------------------------------------------- C# helpers ----
$code = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

public class HarnessWin32 {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, System.Text.StringBuilder buf, ref uint size);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const byte VK_MENU = 0x12; // Alt
    const byte VK_LWIN = 0x5B; // Left Windows key
    const byte VK_RWIN = 0x5C;

    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    public static string GetTitle(IntPtr hWnd) {
        int len = GetWindowTextLengthW(hWnd);
        if (len <= 0) return "";
        var sb = new System.Text.StringBuilder(len + 1);
        GetWindowTextW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    // 强制把窗口带到前台（绕过 Windows 前台锁 foreground lock）。
    // 后台进程裸调 SetForegroundWindow 会被系统拒绝（窗口只在任务栏闪烁不上前）；
    // 这里用 AttachThreadInput 把当前线程附加到目标/前台线程 + 模拟 Alt 键，
    // 让系统认为有用户输入，从而允许抢前台。
    public static void Foreground(long hwnd) {
        var h = new IntPtr(hwnd);
        ShowWindow(h, 9); // SW_RESTORE
        var fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint thisThread = GetCurrentThreadId();
        uint tPid;
        uint targetThread = GetWindowThreadProcessId(h, out tPid);
        // 模拟一次 Alt 键（经典绕过前台锁：系统认为有用户输入）
        try { keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero); } catch { }
        try {
            if (fgThread != thisThread && fgThread != 0) AttachThreadInput(thisThread, fgThread, true);
            if (targetThread != thisThread && targetThread != 0) AttachThreadInput(thisThread, targetThread, true);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            SetFocus(h);
        } finally {
            try { if (fgThread != thisThread && fgThread != 0) AttachThreadInput(thisThread, fgThread, false); } catch { }
            try { if (targetThread != thisThread && targetThread != 0) AttachThreadInput(thisThread, targetThread, false); } catch { }
            try { keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero); } catch { }
        }
    }

    public static List<Dictionary<string, object>> ListWindows() {
        var result = new List<Dictionary<string, object>>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            var title = GetTitle(hWnd);
            RECT r;
            GetWindowRect(hWnd, out r);
            var exe = "";
            var h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (h != IntPtr.Zero) {
                var sb = new System.Text.StringBuilder(2048);
                uint size = 2048;
                if (QueryFullProcessImageNameW(h, 0, sb, ref size)) exe = sb.ToString();
                CloseHandle(h);
            }
            result.Add(new Dictionary<string, object> {
                {"hwnd", hWnd.ToInt64()},
                {"pid", (long)pid},
                {"title", title},
                {"exe", exe},
                {"rect", new long[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top }},
            });
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static long[] WindowRect(long hwnd) {
        RECT r;
        if (!GetWindowRect(new IntPtr(hwnd), out r)) return null;
        return new long[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static void SetTopmost(long hwnd, bool topmost) {
        var insertAfter = topmost ? new IntPtr(-1) : new IntPtr(-2); // HWND_TOPMOST / HWND_NOTOPMOST
        SetWindowPos(new IntPtr(hwnd), insertAfter, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }

    public static void MoveWindow(long hwnd, int x, int y, int w, int h) {
        SetWindowPos(new IntPtr(hwnd), IntPtr.Zero, x, y, w, h, 0x0040); // SWP_SHOWWINDOW
    }

    public static void ShowRestore(long hwnd) {
        ShowWindow(new IntPtr(hwnd), 9); // SW_RESTORE
    }

    public static void PostClose(long hwnd) {
        PostMessageW(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
    }

    public static int ScreenW() { return GetSystemMetrics(0); }
    public static int ScreenH() { return GetSystemMetrics(1); }

    // Capture the primary screen to a PNG file.
    public static string CapturePrimary(string outPath) {
        int w = ScreenW();
        int h = ScreenH();
        using (var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
            }
            bmp.Save(outPath, ImageFormat.Png);
        }
        return outPath;
    }

    // Send a mouse click via SendInput (absolute screen coords).
    // 先 SetCursorPos 再 SendInput：SendInput 的 ABSOLUTE 坐标在非 DPI-aware 进程里
    // 按虚拟桌面解释，与截图（虚拟坐标）一致；先落光标可让窗口收到 WM_MOUSEMOVE，
    // 部分按钮 hover/按下依赖真实光标移动。
    public static bool Click(int x, int y) {
        SetCursorPos(x, y);
        var input = new INPUT();
        input.type = 0; // INPUT_MOUSE
        input.U.mi.dx = (int)((x * 65535) / (double)(ScreenW() - 1));
        input.U.mi.dy = (int)((y * 65535) / (double)(ScreenH() - 1));
        input.U.mi.mouseData = 0;
        input.U.mi.dwFlags = 0x0001 | 0x8000; // MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
        input.U.mi.time = 0;
        input.U.mi.dwExtraInfo = UIntPtr.Zero;
        uint r1 = SendInput(1, new INPUT[] { input }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));

        var down = new INPUT();
        down.type = 0;
        down.U.mi.dx = input.U.mi.dx;
        down.U.mi.dy = input.U.mi.dy;
        down.U.mi.mouseData = 0;
        down.U.mi.dwFlags = 0x0002 | 0x8000 | 0x0001; // LEFTDOWN | ABSOLUTE | MOVE
        down.U.mi.time = 0;
        down.U.mi.dwExtraInfo = UIntPtr.Zero;
        uint r2 = SendInput(1, new INPUT[] { down }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));

        var up = new INPUT();
        up.type = 0;
        up.U.mi.dx = input.U.mi.dx;
        up.U.mi.dy = input.U.mi.dy;
        up.U.mi.mouseData = 0;
        up.U.mi.dwFlags = 0x0004 | 0x8000 | 0x0001; // LEFTUP | ABSOLUTE | MOVE
        up.U.mi.time = 0;
        up.U.mi.dwExtraInfo = UIntPtr.Zero;
        uint r3 = SendInput(1, new INPUT[] { up }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
        return r1 == 1 && r2 == 1 && r3 == 1;
    }

    // 诊断用：返回点击前后光标位置 + SendInput 结果 + 屏幕尺寸
    public static string ClickDiag(int x, int y) {
        POINT before;
        GetCursorPos(out before);
        bool ok = Click(x, y);
        System.Threading.Thread.Sleep(50);
        POINT after;
        GetCursorPos(out after);
        return string.Format("{{ \"ok\":{0}, \"before\":[{1},{2}], \"after\":[{3},{4}], \"screen\":[{5},{6}] }}",
            ok ? "true" : "false", before.X, before.Y, after.X, after.Y, ScreenW(), ScreenH());
    }

    public static int[] GetCursorPosXY() {
        POINT p;
        GetCursorPos(out p);
        return new int[] { p.X, p.Y };
    }

    static string JsonEsc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    // 返回指定屏幕坐标处的顶层窗口信息（WindowFromPoint）。
    public static string WindowAtPoint(int x, int y) {
        POINT p = new POINT { X = x, Y = y };
        IntPtr h = WindowFromPoint(p);
        if (h == IntPtr.Zero) return "null";
        RECT r;
        GetWindowRect(h, out r);
        var title = GetTitle(h);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        string exe = "";
        var hp = OpenProcess(0x1000, false, pid);
        if (hp != IntPtr.Zero) {
            var sb = new System.Text.StringBuilder(2048);
            uint size = 2048;
            if (QueryFullProcessImageNameW(hp, 0, sb, ref size)) exe = sb.ToString();
            CloseHandle(hp);
        }
        return string.Format("{{ \"hwnd\":{0}, \"rect\":[{1},{2},{3},{4}], \"pid\":{5}, \"title\":\"{6}\", \"exe\":\"{7}\" }}",
            h.ToInt64(), r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, pid,
            JsonEsc(title), JsonEsc(exe));
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public INPUTUNION U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    public static bool IsAdmin() {
        try {
            var id = System.Security.Principal.WindowsIdentity.GetCurrent();
            var p = new System.Security.Principal.WindowsPrincipal(id);
            return p.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        } catch { return false; }
    }

    public static void SetDpiAware() {
        try { SetProcessDpiAwareness(2); }
        catch { try { SetProcessDPIAware(); } catch { } }
    }
}
'@

Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Drawing.dll'

# 每次进程启动即设为 DPI-aware（Per-Monitor V2，回退 System DPI aware）。
# 必须放在 Add-Type 之后、任何命令之前，统一全链路坐标系：
#  - 非 DPI-aware 时 GetSystemMetrics/CopyFromScreen 与 SetCursorPos/SendInput
#    处于不同坐标空间（截图=物理像素，点击=虚拟坐标 ×DPI 缩放），导致
#    模板匹配出的坐标点击时整体偏移（125% 缩放下偏移约 25%）——点击失效根因。
#  - dpiAware() 命令是单独进程，对 capture/click 等其他命令无效，不能依赖它。
try {
  [HarnessWin32]::SetDpiAware()
} catch { }

function Write-Json($obj) {
  $obj | ConvertTo-Json -Depth 8 -Compress
}

switch ($Command) {
  'list-windows' {
    Write-Json ([HarnessWin32]::ListWindows())
  }
  'window-rect' {
    $hwnd = [long]$Rest[0]
    Write-Json ([HarnessWin32]::WindowRect($hwnd))
  }
  'set-topmost' {
    [HarnessWin32]::SetTopmost([long]$Rest[0], ($Rest[1] -eq '1'))
    Write-Json $true
  }
  'move-window' {
    [HarnessWin32]::MoveWindow([long]$Rest[0], [int]$Rest[1], [int]$Rest[2], [int]$Rest[3], [int]$Rest[4])
    Write-Json $true
  }
  'show-restore' {
    [HarnessWin32]::ShowRestore([long]$Rest[0])
    Write-Json $true
  }
  'foreground' {
    [HarnessWin32]::Foreground([long]$Rest[0])
    Write-Json $true
  }
  'post-close' {
    [HarnessWin32]::PostClose([long]$Rest[0])
    Write-Json $true
  }
  'screen-size' {
    Write-Json (@{ w = [HarnessWin32]::ScreenW(); h = [HarnessWin32]::ScreenH() })
  }
  'capture-primary' {
    $out = $Rest[0]
    # 吞掉 C# 返回值（否则 PowerShell 会把方法返回的路径也输出到管道，导致 stdout 两行 JSON 解析失败）
    $null = [HarnessWin32]::CapturePrimary($out)
    Write-Json (@{ ok = $true; file = $out })
  }
  'click' {
    $ok = [HarnessWin32]::Click([int]$Rest[0], [int]$Rest[1])
    Write-Json $ok
  }
  'click-diag' {
    # C# 返回的是裸 JSON 字符串（含引号转义），直接 Write-Output 输出原始 JSON，
    # 不再过 ConvertTo-Json（否则会被包成带引号的字符串字面量，Node 解析成字符串）。
    [HarnessWin32]::ClickDiag([int]$Rest[0], [int]$Rest[1])
  }
  'cursor-pos' {
    Write-Json ([HarnessWin32]::GetCursorPosXY())
  }
  'window-at-point' {
    # 裸 JSON 输出（同 click-diag）
    [HarnessWin32]::WindowAtPoint([int]$Rest[0], [int]$Rest[1])
  }
  'is-admin' {
    Write-Json ([HarnessWin32]::IsAdmin())
  }
  'dpi-aware' {
    [HarnessWin32]::SetDpiAware()
    Write-Json $true
  }
  default {
    throw "unknown command: $Command"
  }
}
