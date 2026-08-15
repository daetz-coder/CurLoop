param(
  [Parameter(Position = 0, Mandatory = $true)]
  [string]$Command
)

$ErrorActionPreference = 'Stop'

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
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static string GetTitle(IntPtr hWnd) {
        int len = GetWindowTextLengthW(hWnd);
        if (len <= 0) return "";
        var sb = new System.Text.StringBuilder(len + 1);
        GetWindowTextW(hWnd, sb, sb.Capacity);
        return sb.ToString();
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

    public static void Foreground(long hwnd) {
        SetForegroundWindow(new IntPtr(hwnd));
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
    public static void Click(int x, int y) {
        var input = new INPUT();
        input.type = 0; // INPUT_MOUSE
        input.U.mi.dx = (int)((x * 65535) / (double)(ScreenW() - 1));
        input.U.mi.dy = (int)((y * 65535) / (double)(ScreenH() - 1));
        input.U.mi.mouseData = 0;
        input.U.mi.dwFlags = 0x0001 | 0x8000; // MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
        input.U.mi.time = 0;
        input.U.mi.dwExtraInfo = UIntPtr.Zero;
        SendInput(1, new INPUT[] { input }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));

        var down = new INPUT();
        down.type = 0;
        down.U.mi.dx = input.U.mi.dx;
        down.U.mi.dy = input.U.mi.dy;
        down.U.mi.mouseData = 0;
        down.U.mi.dwFlags = 0x0002 | 0x8000 | 0x0001; // LEFTDOWN | ABSOLUTE | MOVE
        down.U.mi.time = 0;
        down.U.mi.dwExtraInfo = UIntPtr.Zero;
        SendInput(1, new INPUT[] { down }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));

        var up = new INPUT();
        up.type = 0;
        up.U.mi.dx = input.U.mi.dx;
        up.U.mi.dy = input.U.mi.dy;
        up.U.mi.mouseData = 0;
        up.U.mi.dwFlags = 0x0004 | 0x8000 | 0x0001; // LEFTUP | ABSOLUTE | MOVE
        up.U.mi.time = 0;
        up.U.mi.dwExtraInfo = UIntPtr.Zero;
        SendInput(1, new INPUT[] { up }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
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

function Write-Json($obj) {
  $obj | ConvertTo-Json -Depth 8 -Compress
}

switch ($Command) {
  'list-windows' {
    Write-Json ([HarnessWin32]::ListWindows())
  }
  'window-rect' {
    $hwnd = [long]$args[0]
    Write-Json ([HarnessWin32]::WindowRect($hwnd))
  }
  'set-topmost' {
    [HarnessWin32]::SetTopmost([long]$args[0], ($args[1] -eq '1'))
    Write-Json $true
  }
  'move-window' {
    [HarnessWin32]::MoveWindow([long]$args[0], [int]$args[1], [int]$args[2], [int]$args[3], [int]$args[4])
    Write-Json $true
  }
  'show-restore' {
    [HarnessWin32]::ShowRestore([long]$args[0])
    Write-Json $true
  }
  'foreground' {
    [HarnessWin32]::Foreground([long]$args[0])
    Write-Json $true
  }
  'post-close' {
    [HarnessWin32]::PostClose([long]$args[0])
    Write-Json $true
  }
  'screen-size' {
    Write-Json (@{ w = [HarnessWin32]::ScreenW(); h = [HarnessWin32]::ScreenH() })
  }
  'capture-primary' {
    $out = $args[0]
    [HarnessWin32]::CapturePrimary($out)
    Write-Json (@{ ok = $true; file = $out })
  }
  'click' {
    [HarnessWin32]::Click([int]$args[0], [int]$args[1])
    Write-Json $true
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
