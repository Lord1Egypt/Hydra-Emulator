# Hydra Emulator window agent (ASCII only).
# A single long-lived helper that owns every Win32 trick we need:
#   * re-parents the Android emulator Qt window into an Hydra Emulator BrowserWindow (one clean window,
#     no emulator sidebar, no emulator title bar);
#   * hides the floating emulator toolbar window that shows the volume/camera/back rail;
#   * rotates the device with Ctrl+Left / Ctrl+Right and reports the new window size;
#   * runs an opt-in WH_MOUSE_LL hook so right click becomes Android BACK, wheel
#     becomes a coalesced swipe, and (optionally) side buttons become BACK / FORWARD.
#     Left click is deliberately left alone: Qt already maps it to a finger tap.
# Everything is P/Invoke from the .NET Framework that ships with Windows 10/11,
# so there is no native binary to compile, sign or ship.
# Protocol: TCP on 127.0.0.1, one JSON object per line. First stdout line is "PORT=<n>".
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ApkAgent
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT Pt; public int MouseData; public int Flags; public int Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr WParam; public IntPtr LParam; public uint Time; public int X; public int Y; }
    // Minimal PROCESS_BASIC_INFORMATION: enough to read InheritedFromUniqueProcessId.
    [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr ParentPid; }

    public delegate bool EnumProc(IntPtr h, IntPtr p);
    public delegate IntPtr HookProc(int code, IntPtr wp, IntPtr lp);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowTextW(IntPtr h, string s);
    // Set icons for the emulator’s original window (the taskbar/ Alt+Tab displays the current application icon under stand-alone window mode)
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImageW(IntPtr inst, string file, uint type, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
    // High DPI: appwin.js transmits physics pixels. Windows zooms again as logical pixels when DPI senses.,
    // The embedded emulator window is bigger than the host (150% down 1.5 times larger) The image is right/down, clicking off (issue #40).
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr c);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    // Crop the visible area embedded in the window: remove the box from the caption bar
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const uint WS_CHILD = 0x40000000;
    const uint WS_POPUP = 0x80000000;
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;
    const int WS_MINIMIZEBOX = 0x00020000;
    const int WS_MAXIMIZEBOX = 0x00010000;
    const int WS_SYSMENU = 0x00080000;
    const int WS_BORDER = 0x00800000;
    const int WS_CLIPCHILDREN = 0x02000000;
    const int WS_CLIPSIBLINGS = 0x04000000;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_CLIENTEDGE = 0x00000200;
    const int WS_EX_WINDOWEDGE = 0x00000100;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;

    static IntPtr _host = IntPtr.Zero;
    static IntPtr _emu = IntPtr.Zero;
    static IntPtr _chromeRender = IntPtr.Zero;
    static IntPtr _hook = IntPtr.Zero;
    static HookProc _hookProc = null;
    static Thread _hookThread = null;
    static volatile bool _hookRun = false;
    static uint _hookTid = 0;
    static readonly ManualResetEvent _hookReady = new ManualResetEvent(false);
    static readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();
    static long _lastToolSweep = 0;
    static long _embedAt = 0;
    // Permanent suppression: Default to open as soon as the switch is open, press down the simulator main window + toolbar + black window on the control table.
    // Unlike the old logic of "embed done and turned off," it was...**Permanent Representative**_sweep will skip embedded
    // The window in our window, the rest is hidden.
    static volatile bool _quiet = true;
    static volatile bool _perfMode = false;
    static volatile bool _detachedMode = false;
    static long _bootHideSweep = 0;
    // Black window scan time stamp. emulator pulls up qemu and Windows gives this control.
    // New window (Win11 tops Windows Terminal), which only lives 200 to 300 ms;
    // 250ms run out of grips, so 15 seconds before you sweep the control table window alone with a tighter rhythm.
    static long _consoleSweep = 0;
    // In case Embed didn’t come.),
    // The 120ms of scans can’t go on forever and burn the CPU.
    static long _bootHideUntil = 0;
    static long _bootHideStart = Environment.TickCount;
    // PickCount. See Serve() for branch lock = null.
    static long _lingerUntil = 0;

    // Which windows count as "ours": only those created by a process whose exe lives
    // inside one of these directories (the runtime root / bundled engine dir).
    // This is the whole fix for "Hydra Emulator conflicts with WeChat": WeChat 4.x is Qt 6
    // too (its windows are QWindowIcon / QWindowToolSaveBits), so any matching that
    // relied on window class names alone could hide or even re-parent WeChat's own
    // windows. Class names are never unique; the owning process's path is.
    static readonly System.Collections.Generic.List<string> _scopeDirs = new System.Collections.Generic.List<string>();
    static readonly System.Collections.Generic.Dictionary<uint, bool> _oursCache = new System.Collections.Generic.Dictionary<uint, bool>();
    // PID of the Hydra Emulator main process. The only window we are ever allowed to embed
    // into / swallow clicks for. Guard against a recycled HWND: if _host later belongs
    // to somebody else, the mouse hook must pass events through instead of eating them.
    static uint _appPid = 0;
    static uint _hostPid = 0;

    // Hook options. All three default to OFF: an "hook on" without options must
    // never swallow anybody's clicks. JS sends the real config on every enable.
    static volatile int _optRight = 0;
    static volatile int _optWheel = 0;
    static volatile int _optSide = 0;

    // Wheel coalescing: Qt would turn every single notch into a separate touch
    // gesture (visible stutter). We accumulate deltas for a short window and
    // hand one normalized position to the JS side, which injects a single swipe.
    static readonly object _wheelLock = new object();
    static int _wheelDx = 0, _wheelDy = 0;
    static double _wheelNx = 0.5, _wheelNy = 0.5;
    static long _wheelFirst = 0, _wheelLast = 0;

    // ------------------------------------------------------------------ ownership
    // Scope is set by the JS side before anything is hidden ("scope" command).
    // With no scope the agent refuses to touch any window: leaving one black console
    // around is a cosmetic bug, hiding a user's WeChat window is not.
    static void SetScope(string raw)
    {
        _scopeDirs.Clear();
        string[] pieces = (raw == null ? "" : raw).Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string piece in pieces)
        {
            string d = piece.Trim();
            if (d.Length == 0) continue;
            try { d = System.IO.Path.GetFullPath(d); } catch { }
            if (!d.EndsWith("\\")) d += "\\";
            _scopeDirs.Add(d.ToLowerInvariant());
        }
        lock (_oursCache) { _oursCache.Clear(); }
    }

    static bool IsOurs(uint pid)
    {
        if (pid == 0 || _scopeDirs.Count == 0) return false;
        lock (_oursCache)
        {
            bool hit;
            if (_oursCache.TryGetValue(pid, out hit)) return hit;
        }
        bool ours = false;
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                string file = null;
                try { file = p.MainModule.FileName; } catch { file = null; }
                if (!string.IsNullOrEmpty(file))
                {
                    string low = file.ToLowerInvariant();
                    for (int i = 0; i < _scopeDirs.Count; i++)
                        if (low.StartsWith(_scopeDirs[i], StringComparison.Ordinal)) { ours = true; break; }
                }
            }
        }
        catch { ours = false; }
        lock (_oursCache)
        {
            // PIDs get recycled; a bounded cache is enough (one entry per live process).
            if (_oursCache.Count > 400) _oursCache.Clear();
            _oursCache[pid] = ours;
        }
        return ours;
    }

    static uint ParentOf(uint pid)
    {
        IntPtr h = IntPtr.Zero;
        try
        {
            h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return 0;
            PBI pbi = new PBI();
            int len;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out len) != 0) return 0;
            return (uint)pbi.ParentPid.ToInt64();
        }
        catch { return 0; }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    // Console windows belong to conhost.exe, not to the program that owns the console,
    // so the window pid is never the emulator's. Walk conhost's parents instead.
    static bool ConsoleOwnedByUs(uint pid)
    {
        uint p = ParentOf(pid);
        for (int i = 0; i < 3 && p != 0; i++)
        {
            if (IsOurs(p)) return true;
            p = ParentOf(p);
        }
        return false;
    }

    static bool IsOurConsole(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (IsOurs(pid) || ConsoleOwnedByUs(pid)) return true;
        if (_scopeDirs.Count == 0) return false;
        // Windows titles a console with the image path it launched, so the runtime
        // directory shows up verbatim. Precise enough to never match a stray terminal.
        string title = TitleOf(h).ToLowerInvariant();
        for (int i = 0; i < _scopeDirs.Count; i++)
            if (title.IndexOf(_scopeDirs[i], StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    // ------------------------------------------------------------------ window discovery
    static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }
    static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    // The emulator draws its framebuffer in a "QWindowIcon" top level window titled
    // "Android Emulator - <avd>:<port>"; the volume/rotate rail lives in a separate
    // small "QWindowTool*" window we hide.
    //
    // Note: The simulator’s opening phase (and hiding after permanent repression) is the window**Invisible**It's...,
    // So you can’t filter on the IsWindowVisible -- otherwise you’ll never find the embedded window.,
    // The user sees a black application window. Replace "The title is Android Emulator.",
    // Visible large window priority “. Toolbar / Tip Window (QWindowTool) is too small and is blocked by area thresholds.
    //
    // Hydra Emulator will change the title of the window to the application name (see "title" command), so when you recognize it,
    // We must also recognize the title after the name is changed. Remember the title we have in a volatile field.
    public static string _ourTitle = "";
    // Apply icon file path: Qt changes icons back to default green robots when the window is rebuilt, and continues to be refilled in the inspection.
    public static string _ourIconFile = "";
    public static IntPtr _ourIconSmall = IntPtr.Zero;
    public static IntPtr _ourIconBig = IntPtr.Zero;
    static bool LooksLikeEmulator(string title)
    {
        if (title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (_ourTitle.Length > 0 && String.Equals(title, _ourTitle, StringComparison.Ordinal)) return true;
        return false;
    }
    static IntPtr FindEmulator()
    {
        IntPtr best = IntPtr.Zero;
        long bestScore = long.MinValue;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            // Ownership comes first. "QWindowIcon" is the class of EVERY Qt top level
            // window, and WeChat 4.x / MuMu / music players are Qt too -- matching on
            // the class alone is how the wrong window ended up hidden or re-parented.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowIcon", StringComparison.Ordinal) < 0) return true;
            string title = TitleOf(h);
            bool named = LooksLikeEmulator(title);
            if (!named && !IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.R - r.L) * (r.B - r.T);
            if (area < 200 * 200) return true;   // Skip toolbars and popups.
            // Visible large windows first, and second is hidden.
            long score = area + (IsWindowVisible(h) ? 1000000000L : 0);
            if (score > bestScore) { bestScore = score; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // Diagnosis: List the top-level window (class / title / / pid / dimension / visible).
    // To verify that "Open software only sees the software interface" - the main window of the emulator, the netsim controller must not be in it.
    static string ListWindows(bool includeHidden)
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            bool vis = IsWindowVisible(h);
            if (!vis && !includeHidden) return true;
            string cls = ClassOf(h);
            string title = TitleOf(h);
            // Too many windows hidden (in hundreds of thousands of systems) only for simulators/ Qt
            if (!vis && cls.IndexOf("QWindow", StringComparison.Ordinal) < 0
                && title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) < 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.R - r.L, hh = r.B - r.T;
            if (vis && (w < 40 || hh < 40)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append(",\"pid\":").Append(pid)
              .Append(",\"w\":").Append(w)
              .Append(",\"h\":").Append(hh)
              .Append(",\"vis\":").Append(vis ? "true" : "false")
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static void HideToolWindows()
    {
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowTool", StringComparison.Ordinal) < 0) return true;
            // QWindowToolSaveBits is what Qt uses for menus, tooltips and popup panels --
            // WeChat's emoji panel / right-click menu included. Only hide our own.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) > 200) return true;   // the framebuffer window also uses this class
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // Quemu / emulator ’s black control window hidden to avoid flashes.
    // They are console subsystem processes, node’s windowside does not cover the subprocess, and they can only be held by the Win32 cycle.
    //
    // Key pits: Windows 10 after the Console window really belongs to the conhost.exe, GetWindowThreadProcessId
    // Got a complete pid, not an emulator pid -- old-time pid white list match.,
    // So none of these black windows can hide.
    // Now read "pid hit or window header hit" (head is the exe path started), either way is hidden.
    static void HideConsoleWindows()
    {
        if (_scopeDirs.Count == 0) return;   // no scope: never touch anybody's terminal

        // Clear which control windows; and don’t go to the enumeration process without one.)
        var consoles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                consoles.Add(h);
            return true;
        }, IntPtr.Zero);
        if (consoles.Count == 0) return;

        // There's another "heading with emulator / qemu / netsim even for us.",
        // It hides the user's own terminal (titled a certain path, for example, D://Android//emulator).
        // Only two pieces of evidence are admitted: the parent chain of conhost can go to the directory where we run it.,
        // Or there’s an absolute path to the directory that we run when in the title.
        long now = Environment.TickCount;
        foreach (IntPtr h in consoles)
        {
            if (IsOurConsole(h)) { ShowWindow(h, 0); continue; }
            // Third evidence (Windows 11 only):,
            // The simulator's new control window for qemu belongs to Windows Terminal.exe ——
            // Pid is not ours. The parent process chain can’t get us. It’s often just a “Terminal.“,
            // The two pieces of evidence couldn’t be hit, so each time it started, it flashed on the screen with a black frame of 200 to 300 ms.
            // Here’s the term “not present before starting + after starting + in 20 seconds + header is empty/ is Terminal.“
            // Three conditions together. Users usually have their own new terminal with a title (PowerShell, a path).),
            // Not to be hurt; to go back, it’s just to hide, and not to shut him down.
            if (_bootHideStart != 0 && now - _bootHideStart < 20000
                && !_consolesBeforeBoot.Contains(h.ToInt64()))
            {
                string t = TitleOf(h);
                string tl = t.ToLowerInvariant();
                // The title actually changes: it could be empty, it could be "Terminal," it could be "Windows Terminal."
                // (It depends on the WT version and whether it was given the shell title.
                // host“ - empty title, or with terminal.
                // Users themselves are running terminals in _consolesBeforeBoot and are not injured by error.
                // It’s a mistake and it’s just hiding, and it won’t shut him down.
                bool plain = t.Length == 0 || tl.IndexOf("terminal", StringComparison.Ordinal) >= 0;
                if (plain)
                {
                    ShowWindow(h, 0);
                }
            }
        }
    }

    // Recording the "boothide" window that already exists at the moment.
    // Windows Terminal will plug our qemu control table into a new window from the pid. /
    // The parent process / title does not recognize belonging; the most reliable is "not before, not after the start of the engine."
    static System.Collections.Generic.HashSet<long> _consolesBeforeBoot =
        new System.Collections.Generic.HashSet<long>();

    static void SnapshotConsoles()
    {
        _consolesBeforeBoot.Clear();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                _consolesBeforeBoot.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
    }

    // Diagnosis: Lists the current Visible Console Window (Black Window) and its affiliation for use in the authentic scripts in these.
    // Ours=true means this is the control table window for emularator/qemu.
    static string ListConsoles()
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            bool isConsole = cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0;
            if (!isConsole) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string title = TitleOf(h);
            bool ours = IsOurConsole(h);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"ours\":").Append(ours ? "true" : "false")
              .Append(",\"pid\":").Append(pid)
              .Append(",\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static string JsonStr(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s == null ? "" : s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c >= ' ') b.Append(c);
        }
        b.Append("\"");
        return b.ToString();
    }

    // Built down: create any of our runtime processes**Additional top-level visible windows**Hide them.
    // Except for the emulator main window (to embed host), it is possible that emulator/ qemu/ netsimd/ adb
    // Popup of flashes of things (Qt hint box, crash dialogue box, volume bar, log window...).
    // Previously, one name by class, one missing, flash; this was changed to "Process is our runtime Directory."
    // And judging by that, more coverage. The host window and the simulator window are not in this range, and there will be no injury.
    static void HideStrayWindows()
    {
        if (_scopeDirs.Count == 0) return;
        IntPtr embeddedRoot = _emu;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            if (h == embeddedRoot) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!IsOurs(pid)) return true;
            string cls = ClassOf(h);
            // Only clear window categories are hidden: Qt prompt windows/ dialog/ Console.
            // Never touch QWindowIcon/ subWin -- it's embedded LCD, hides it all black and clicks out.
            bool safe = cls.IndexOf("QWindowTool", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("Qt", StringComparison.Ordinal) < 0 && cls.IndexOf("Chrome", StringComparison.Ordinal) < 0;
            if (!safe) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) < 8 && (r.B - r.T) < 8) return true;
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // Permanent suppression scan: As long as the simulator window is not a subwindow of one of our windows, hide it.
    // So whether the simulator is on, preheating, or Hydra Emulator has quit (the window is re-mounted to the desktop by the system).,
    // No user will see the black window called "Android Emulator-hydra5554."
    // QWindowTool and all control windows (qemu/ netsimd/ emulator) are pressed.

    // EndChromeRender will return to zero.,
    // So the simulator was hung up as a direct sub-window for the host (and the web level is brother) -- the web level will continue.
    // Cover the screen and eat the mouse. This is to be added to the permanent scan: once the web layer is found, it’s to be redone.
    static void EnsureReparent()
    {
        if (_emu == IntPtr.Zero || _host == IntPtr.Zero) return;
        if (_chromeRender == IntPtr.Zero || !IsWindow(_chromeRender))
            _chromeRender = FindChromeRender(_host);
        if (_chromeRender == IntPtr.Zero) return;
        IntPtr ep = GetParent(_emu);
        if (ep == _chromeRender) return;
        if (ep != _host && ep != IntPtr.Zero) return;   // Leave other hosts alone.
        RECT r;
        if (!GetWindowRect(_emu, out r)) return;
        RECT hr;
        if (!GetWindowRect(_host, out hr)) return;
        SetParent(_emu, _chromeRender);
        // Coordinates relative to the web level client area (same as host client area), maintain the original screen position
        SetWindowPos(_emu, IntPtr.Zero, r.L - hr.L, r.T - hr.T,
                     r.R - r.L, r.B - r.T, 0x0004 | 0x0010 | 0x0040);
    }

    static void QuietSweep()
    {
        // Independent window mode: The simulator window is "the one the user really sees," and it must not be suppressed.,
        // And you shouldn’t have gone to the host’s client area.
        if (_detachedMode)
        {
            // Qt changed the title back to "Android Emulator--" when resolution changes/windows were re-established.
            // Each round is supplemented by a guarantee that the task line will always be Hydra Emulator (or application name).
            if (_ourTitle.Length > 0 && _emu != IntPtr.Zero
                && !String.Equals(TitleOf(_emu), _ourTitle, StringComparison.Ordinal))
                SetWindowTextW(_emu, _ourTitle);
            // The Qt icon returns to the default green robot after changing resolution/rebuilding window, and is supplemented once per round.
            // NM_GETICON does not indicate zero that the current window already has the icon we have, skipping; otherwise the cache handle is re-activated.
            if (_emu != IntPtr.Zero && (_ourIconSmall != IntPtr.Zero || _ourIconBig != IntPtr.Zero)
                && SendMessageW(_emu, 0x007F, new IntPtr(1), IntPtr.Zero) == IntPtr.Zero)
            {
                if (_ourIconSmall != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(0), _ourIconSmall);
                if (_ourIconBig != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(1), _ourIconBig);
            }
            HideConsoleWindows();
            HideStrayWindows();
            return;
        }
        EnsureReparent();
        // The size of the host has been maximized/ scaled up, and the ice layer of Electron has often not grown.,
        // It’s just one left corner.,
        // SetWindowPos is basically costless when the sizes remain unchanged.
        if (_emu != IntPtr.Zero && _host != IntPtr.Zero) Fit(-8, 30, 640, 480, false, 0);
        IntPtr ep = _emu != IntPtr.Zero ? GetParent(_emu) : IntPtr.Zero;
        bool embedded = _emu != IntPtr.Zero && ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        IntPtr e = embedded ? _emu : FindEmulator();
        if (!embedded && e != IntPtr.Zero && IsWindowVisible(e)) ShowWindow(e, 0);
        HideToolWindows();
        HideConsoleWindows();
        HideStrayWindows();
        if (!embedded && e != IntPtr.Zero) _bootHideUntil = Environment.TickCount + 5000;
    }

    // Only our own runtime counts. The old version returned true for ANY process named
    // "emulator" -- other emulators (MuMu / LDPlayer ship their own) kept the guard alive.
    static bool AnyEmulatorProcess()
    {
        if (_scopeDirs.Count == 0) return false;
        try
        {
            string[] names = { "qemu-system-x86_64", "qemu-system-x86_64-headless", "emulator", "emulator-headless", "netsimd" };
            for (int i = 0; i < names.Length; i++)
            {
                Process[] all = Process.GetProcessesByName(names[i]);
                for (int j = 0; j < all.Length; j++)
                    if (IsOurs((uint)all[j].Id)) return true;
            }
        }
        catch { }
        return false;
    }

    // ------------------------------------------------------------------ embed / detach

    // The chromium drouds window in the host’s window.
    // Emulatorron’s web layer (Chrome_RenderWidgetHostHWND) and simulator windows, if all are host
    // Direct subwindows, they're "buddy," and Electron keeps pushing the web layer to the top. ——
    // So the black base on the web floor covers Android’s image, and the mouse is eaten by it. /
    // Unfilled / Click Exact / Dot Dot No.
    // Put the emulator on the web floor.**Subwindow**After that, the Z sequence and mouse hits natural priority to the simulator.
    static IntPtr FindChromeRender(IntPtr host)
    {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(host, delegate(IntPtr c, IntPtr p)
        {
            if (ClassOf(c).IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.Ordinal) >= 0)
            {
                found = c;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static bool Embed(IntPtr host, IntPtr emu)
    {
        if (host == IntPtr.Zero || emu == IntPtr.Zero) return false;
        HideToolWindows();
        // The web layer window is filled with host client areas, and the coordinates match the host, so the rectangulars passed from Fit in the back do not change.
        IntPtr parent = FindChromeRender(host);
        if (parent == IntPtr.Zero) parent = host;   // Fall back to the outer host window.
        SetParent(emu, parent);
        uint style = (uint)GetWindowLong(emu, GWL_STYLE);
        style &= ~WS_POPUP;
        style &= ~(uint)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER);
        style |= WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
        SetWindowLong(emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(emu, GWL_EXSTYLE);
        ex &= ~(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE);
        SetWindowLong(emu, GWL_EXSTYLE, ex);
        // Old version has given this window window window region; clear before reusing, otherwise hits continue to miss
        SetWindowRgn(emu, IntPtr.Zero, false);
        return true;
    }

    // HWND_TOP: Chromium’s Rendering and Simulator is a sub-window of the same level,
    // If you don't take it to the top, you'll be covered in the black under Chromium.
    static readonly IntPtr HWND_TOP = new IntPtr(1);
    static void Fit(int x, int y, int w, int h, bool frame, int clipTop)
    {
        if (_emu == IntPtr.Zero) return;
        // Fit is the one that the JS side adjusts every time resize, and the web layer must have been built.
        // Make sure the simulator is under the web floor.
        if (_host != IntPtr.Zero)
        {
            IntPtr cr = FindChromeRender(_host);
            if (cr != IntPtr.Zero)
            {
                _chromeRender = cr;
                IntPtr cur = GetParent(_emu);
                if (cur != cr && (cur == _host || cur == IntPtr.Zero))
                {
                    SetParent(_emu, cr);
                    // Coordinates relative to the user area of the web level, consistent with host, with the x/y that is passed on
                }
            }
        }
        //  Here. **Host window client area** Align size instead of the W/h from JS,
        // And not the letter chrome rewrites the size of the layer itself.
        //
        // Why: The host window became 1936x1048 after the Elementron maximized, but internal
        // Chrome_RenderWidgetHostHWND still stops at the old size (actual 532x984) - and simulator
        // The window hangs under the chrome floor and is cut by the father’s window, so the image is only one top left corner.,
        // A big blank on the right ( "Maximizing/Unfilled" on the user screen).
        // So we’re going to pull the chrome layer over the host client area, and then we’re going to set the emu as the client area size.
        if (_host != IntPtr.Zero)
        {
            RECT hc;
            if (GetClientRect(_host, out hc))
            {
                int cw = hc.R - hc.L;
                int chh = hc.B - hc.T;
                if (cw > 200 && chh > 200)
                {
                    if (_chromeRender != IntPtr.Zero)
                    {
                        RECT crc;
                        if (GetWindowRect(_chromeRender, out crc))
                        {
                            if ((crc.R - crc.L) != cw || (crc.B - crc.T) != chh)
                            {
                                SetWindowPos(_chromeRender, IntPtr.Zero, 0, 0, cw, chh,
                                    SWP_NOZORDER | SWP_NOACTIVATE);
                            }
                        }
                    }
                    // x/y to keep -8 overflows (excerpt 8px ash from Qt),
                    // Width by client area + 2*8; title bar 38px covered by host.
                    x = -8;
                    y = 38 - 8;
                    w = cw + 16;
                    h = (chh - 38) + 16;
                }
            }
        }
        if (w < 16) w = 16;
        if (h < 16) h = 16;
        // Only those who "are indeed embedded in our window" are allowed to display.
        // If the embed fails (the emulator window is not yet built / changed), Fit must never use it as a separate window.
        // Up on the desktop -- that's the black window "Android Emulator-hydra5554" that users see.
        IntPtr ep = GetParent(_emu);
        bool embedded = ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        if (!embedded)
        {
            ShowWindow(_emu, 0);
            return;
        }
        // SWP_FRAMECHANGED forces Windows to recompute the whole non-client area and
        // repaint it. It is needed exactly once (right after SetParent); repeating it
        // on every periodic sweep caused visible stutter and wasted GPU/CPU.
        uint flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | (frame ? SWP_FRAMECHANGED : 0u);
        SetWindowPos(_emu, HWND_TOP, x, y, w, h, flags);
        // Never place a window embedded in window window: Qt/ GL subwindle with region, hit test and
        // Enter the coordinates map to be mispositioned (clicking invalid/ pointless button), region after resizeing
        // The rectangular will show a dark side. The 8px in the title bar will spill and be covered by the host's own title bar.
    }

    static void Raise()
    {
        if (_emu == IntPtr.Zero) return;
        SetWindowPos(_emu, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    static void Detach()
    {
        if (_emu == IntPtr.Zero) return;
        SetParent(_emu, IntPtr.Zero);
        uint style = (uint)GetWindowLong(_emu, GWL_STYLE);
        style &= ~WS_CHILD;
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        SetWindowLong(_emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(_emu, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(_emu, GWL_EXSTYLE, ex);
        SetWindowPos(_emu, IntPtr.Zero, 60, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        // Keep the handle under stand-alone window mode: Show / layout is used to locate the real window.
        // Embedded mode (default) is still empty, keeping the original syntax.
        if (!_detachedMode) _emu = IntPtr.Zero;
    }

    // Same as Detach, but**Do Not Show**Window: Call when host window is being destroyed.
    // Without first taking it off, Windows will reload the sub-windows to the desktop and make them visible when the host destroys them.,
    // And then a black window of "Android Emulator-hydra5554" came out of thin air.
    static void ParkEmulator()
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        IntPtr e = _emu;
        if (e == IntPtr.Zero) { _host = IntPtr.Zero; return; }
        ShowWindow(e, 0);
        SetParent(e, IntPtr.Zero);
        uint style = (uint)GetWindowLong(e, GWL_STYLE);
        style &= ~WS_CHILD;
        // It could have been removed from the covert operation SetParent went to the hidden host.,
        // The third-party base (Mumu) will not re-enact itself, and the user will never see the simulator again when the application window is closed.
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | 0x10000000);
        SetWindowLong(e, GWL_STYLE, (int)style);
        int ex = GetWindowLong(e, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(e, GWL_EXSTYLE, ex);
        SetWindowPos(e, IntPtr.Zero, 40, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        _emu = IntPtr.Zero;
        _host = IntPtr.Zero;
    }

    // ------------------------------------------------------------------ rotation
    // The simulator’s turnback is "re-orienting the panel" and only its own Qt shortcut Ctrl+← triggers;
    // Control command only turns the image 90 degrees, and the system is still a screen.
    // The hard part is that the shortcut must receive keyboard messages from the simulator window, which is already the subwindow of our window,
    // The focus is on the web floor. So, first, we’re going to put two lines in the input queue, and then we’re going to give the focus to the simulator.,
    // Press the key and return it.
    static void Rotate(string dir)
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        if (_emu == IntPtr.Zero) return;
        // keybd_event feeds the SYSTEM input queue, so if we are not the foreground
        // window the Ctrl+Left lands in whatever the user is typing in (WeChat's input
        // box, a browser, ...). Rotate is a user action in our own window; if we are
        // not foreground, do nothing instead of typing into someone else's app.
        IntPtr fg = GetForegroundWindow();
        if (_host == IntPtr.Zero || (fg != IntPtr.Zero && GetAncestor(fg, 2) != _host)) return;
        IntPtr host = _host != IntPtr.Zero ? _host : GetParent(_emu);

        uint emuTid, hostTid, dummy;
        emuTid = GetWindowThreadProcessId(_emu, out dummy);
        hostTid = host != IntPtr.Zero ? GetWindowThreadProcessId(host, out dummy) : 0;
        uint myTid = GetCurrentThreadId();

        bool a1 = AttachThreadInput(myTid, emuTid, true);
        bool a2 = hostTid != 0 && AttachThreadInput(myTid, hostTid, true);
        try
        {
            if (host != IntPtr.Zero) SetForegroundWindow(host);
            IntPtr prev = SetFocus(_emu);
            Thread.Sleep(150);
            byte vk = dir == "right" ? (byte)0x27 : (byte)0x25;
            keybd_event(0x11, 0, 0, IntPtr.Zero);
            Thread.Sleep(50);
            keybd_event(vk, 0, 0, IntPtr.Zero);
            Thread.Sleep(80);
            keybd_event(vk, 0, 2, IntPtr.Zero);
            keybd_event(0x11, 0, 2, IntPtr.Zero);
            Thread.Sleep(120);
            SetFocus(prev);
        }
        finally
        {
            if (a2) AttachThreadInput(myTid, hostTid, false);
            if (a1) AttachThreadInput(myTid, emuTid, false);
        }
    }

    // ------------------------------------------------------------------ mouse mapping
    const int WM_RBUTTONDOWN = 0x0204;
    const int WM_RBUTTONUP = 0x0205;
    const int WM_RBUTTONDBLCLK = 0x0206;
    const int WM_MOUSEWHEEL = 0x020A;
    const int WM_XBUTTONDOWN = 0x020B;
    const int WM_XBUTTONUP = 0x020C;
    const int WM_MOUSEHWHEEL = 0x020E;

    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static long NowMs() { return _clock.ElapsedMilliseconds; }

    // Only react inside the embedded LCD while OUR window is the foreground root.
    // GetAncestor(GA_ROOT) covers Chromium child windows and the Qt framebuffer.
    static bool InOurLcd(POINT pt, out RECT r)
    {
        r = new RECT();
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || _host == IntPtr.Zero) return false;
        // HWNDs get recycled. If "our" host is gone (or now belongs to another process)
        // the hook must not swallow anything -- otherwise right click / wheel silently
        // stop working in whichever app inherited the handle.
        if (!IsWindow(_host)) return false;
        if (_appPid != 0 && _hostPid != 0 && _hostPid != _appPid) return false;
        if (GetAncestor(fg, 2) != _host) return false;   // 2 = GA_ROOT
        IntPtr e = _emu;
        if (e != IntPtr.Zero && GetWindowRect(e, out r))
        {
            // Qt keeps an 8px grey pad around the real LCD; embed() pushes it out.
            return pt.X >= r.L + 8 && pt.X <= r.R - 8 && pt.Y >= r.T + 8 && pt.Y <= r.B - 8;
        }
        // Before embed (or if FindEmulator failed) fall back to the host window
        // minus its 38px title bar. Approximate on HiDPI, but only a fallback.
        if (!GetWindowRect(_host, out r)) return false;
        return pt.X >= r.L + 4 && pt.X <= r.R - 4 && pt.Y >= r.T + 40 && pt.Y <= r.B - 4;
    }

    static string Num(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

    static void PushWheel(int dx, int dy, POINT pt, RECT r)
    {
        int w = r.R - r.L - 16, h = r.B - r.T - 16;
        double nx = w > 0 ? (pt.X - r.L - 8.0) / w : 0.5;
        double ny = h > 0 ? (pt.Y - r.T - 8.0) / h : 0.5;
        if (nx < 0) nx = 0; if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; if (ny > 1) ny = 1;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) _wheelFirst = now;
            _wheelDx += dx;
            _wheelDy += dy;
            _wheelNx = nx;
            _wheelNy = ny;
            _wheelLast = now;
        }
    }

    // Drained from the socket loop. Emit after 60ms of quiet, but never let a
    // continuous spin starve the queue (hard cap 90ms from the first notch).
    static void FlushWheel(bool force)
    {
        int dx = 0, dy = 0;
        double nx = 0.5, ny = 0.5;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) return;
            if (!force && now - _wheelLast < 60 && now - _wheelFirst < 90) return;
            dx = _wheelDx; dy = _wheelDy; nx = _wheelNx; ny = _wheelNy;
            _wheelDx = 0; _wheelDy = 0;
        }
        _events.Enqueue("{\"ev\":\"wheel\",\"dx\":" + dx + ",\"dy\":" + dy
            + ",\"nx\":" + Num(nx) + ",\"ny\":" + Num(ny) + "}");
    }

    static void ResetWheel()
    {
        lock (_wheelLock) { _wheelDx = 0; _wheelDy = 0; }
    }

    // The callback must stay microscopic: Windows synchronously waits for it on
    // EVERY mouse event of EVERY process. Anything not one of our 7 messages
    // (including all left-button events) is a single CallNextHookEx.
    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = (int)wParam;
            bool right = msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_RBUTTONDBLCLK;
            bool wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL;
            bool xbut = msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP;
            if (!right && !wheel && !xbut) return CallNextHookEx(_hook, nCode, wParam, lParam);
            if ((right && _optRight == 0) || (wheel && _optWheel == 0) || (xbut && _optSide == 0))
                return CallNextHookEx(_hook, nCode, wParam, lParam);

            MSLLHOOKSTRUCT d = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            RECT r;
            if (!InOurLcd(d.Pt, out r)) return CallNextHookEx(_hook, nCode, wParam, lParam);

            if (right)
            {
                // Qt maps a right click to a plain finger tap: swallow it, emit BACK.
                if (msg == WM_RBUTTONDOWN) _events.Enqueue("{\"ev\":\"back\"}");
                return (IntPtr)1;
            }
            if (wheel)
            {
                int delta = (short)((d.MouseData >> 16) & 0xFFFF);
                if (msg == WM_MOUSEWHEEL) PushWheel(0, delta, d.Pt, r);
                else PushWheel(delta, 0, d.Pt, r);
                return (IntPtr)1;
            }
            if (msg == WM_XBUTTONDOWN)
            {
                int button = (d.MouseData >> 16) & 0xFFFF;
                _events.Enqueue(button == 1 ? "{\"ev\":\"back\"}" : "{\"ev\":\"forward\"}");
            }
            return (IntPtr)1;
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    // A WH_MOUSE_LL hook is global: Windows synchronously waits for this callback on
    // EVERY mouse event of EVERY application. It must therefore live on a thread whose
    // only job is pumping messages. Installing it on the socket-serving thread (which
    // used to block up to 4s in Poll) made the whole desktop pointer lag and drift.
    // It is scoped now: JS installs it only while an app window is foreground, and
    // the callback ignores events outside the embedded LCD.
    static void HookThreadProc()
    {
        _hookTid = GetCurrentThreadId();
        _hookProc = HookCallback;
        _hook = SetWindowsHookEx(14, _hookProc, IntPtr.Zero, 0);
        _hookReady.Set();
        MSG m;
        while (_hookRun && GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        _hookTid = 0;
    }

    static void HookOn()
    {
        if (_hookThread != null && _hookThread.IsAlive) return;
        _hookRun = true;
        _hookReady.Reset();
        _hookThread = new Thread(HookThreadProc);
        _hookThread.IsBackground = true;
        _hookThread.Start();
        // Reply must reflect the real hook state; otherwise the JS side sees
        // hooked:false and thinks enabling failed.
        _hookReady.WaitOne(1000);
    }
    static void HookOff()
    {
        _hookRun = false;
        _optRight = 0; _optWheel = 0; _optSide = 0;
        ResetWheel();
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        if (_hookTid != 0) PostThreadMessage(_hookTid, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
        _hookThread = null;
        // _HookProc Deliberately reserved reference: hook thread may be in the process of echoing, pre-empt nud
        // It’ll let the commission be recycled by GC. It’ll be released when the thread is out.
    }

    // ------------------------------------------------------------------ plumbing
    static void Pump()
    {
        MSG m;
        while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1))
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }

    static long L(string line, string key)
    {
        string pat = "\"" + key + "\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return 0;
        i = line.IndexOf(':', i + pat.Length);
        if (i < 0) return 0;
        i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\"')) i++;
        int j = i;
        while (j < line.Length && (char.IsDigit(line[j]) || line[j] == '-')) j++;
        long v;
        return long.TryParse(line.Substring(i, j - i), out v) ? v : 0;
    }

    static string S(string line, string key)
    {
        string pat = "\"" + key + "\":\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return "";
        i += pat.Length;
        int j = line.IndexOf('"', i);
        return j < 0 ? "" : line.Substring(i, j - i);
    }

    // "0x1A2B3C" / "17158972" is a hexadecimal string for HWND.,
    // Our own caller could also go directly to the decimal, both of which are recognized.
    static IntPtr ParseHwnd(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return IntPtr.Zero;
        string s = raw.Trim();
        long v = 0;
        try
        {
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                v = Convert.ToInt64(s.Substring(2), 16);
            }
            else if (long.TryParse(s, out v))
            {
                // Decimal is Decimal.
            }
            else
            {
                v = Convert.ToInt64(s, 16);
            }
        }
        catch { return IntPtr.Zero; }
        if (v <= 0) return IntPtr.Zero;
        return new IntPtr(v);
    }

    static void Reply(Socket s, string json)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(json + "\n");
            s.Send(b);
        }
        catch { }
    }

    public static void Serve(int port)
    {
        // per-monitor v2 (Win10 1703+), failed to return system-aware
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
        TcpListener l = new TcpListener(IPAddress.Loopback, port);
        l.Start();
        int actual = ((IPEndPoint)l.LocalEndpoint).Port;
        Console.WriteLine("PORT=" + actual);
        Console.Out.Flush();
        Socket sock;
        try { sock = l.AcceptSocket(); }
        catch { return; }
        l.Stop();

        StringBuilder rx = new StringBuilder();
        byte[] buf = new byte[8192];
        bool run = true;
        while (run)
        {
            Pump();
            FlushWheel(false);

            string ev;
            while (_events.TryDequeue(out ev))
                Reply(sock, "{\"ev\":\"" + ev + "\"}");

            // The Qt tool rail can re-appear right after embedding. Sweep only for the
            // first few seconds after an embed, then stop: a permanent 2s EnumWindows +
            // SetWindowPos loop is pure overhead and competes with the foreground app.
            long now = Environment.TickCount;
            if (_embedAt != 0 && now - _embedAt < 8000 && now - _lastToolSweep > 1500)
            {
                _lastToolSweep = now;
                HideToolWindows();
                Raise();
            }
            if (_embedAt != 0 && now - _embedAt >= 8000) _embedAt = 0;

            // Permanent suppression: Simulator Main Window / Toolbar / qemu Netsimd Black Window on Console.
            // Number of times a round will be required to enumerate the entire desktop window, at a cost of 90 seconds - previous 120ms round,
            // It’s obviously slowing down the whole thing (user feedback “Carton system-wide“).
            // It doesn't have to be that frequent: 10 seconds before the start of the flight, 250ms grab the window, and then 1,500ms go for it.
            // _game mode further down to 3000ms, leaving the CPU to Android.
            long sweepGap;
            if (_perfMode) sweepGap = (now - _bootHideStart < 10000) ? 300 : 3000;
            else sweepGap = (now - _bootHideStart < 10000) ? 250 : 1500;
            if (_quiet && now - _bootHideSweep > sweepGap)
            {
                _bootHideSweep = now;
                QuietSweep();
            }

            // Control counter black window special HF channel (only 15 seconds in the front, only list the control window).
            // Why: Windows will create a new control window when emulator starts qemu,
            // The process of belonging is conhost / WindowsTerminal, IsOurs for false, only depend
            // IsourConsole’s title = our running-time path’ to identify. This kind of window is visible only.
            // 200 to 300ms, 250ms, the lead inspection is missing -- the user sees it when it’s on.
            // A flash of the black box. Here’s 100ms round, and it’s bound to be caught before it disappears.
            if (_quiet && now - _bootHideStart < 15000
                && now - _consoleSweep > (_perfMode ? 200 : 100))
            {
                _consoleSweep = now;
                HideConsoleWindows();
            }

            try
            {
                // The connection has been cut off (Hydra Emulator exited / abnormally crashed): Not immediately.
                // The simulator may still be active, and in dozens of seconds, Qt will show the window -- and if
                // Without an agent watching, there will be a black window on the table.
                // So we’re going to hold it for a little while after we’re out of line, until there’s no simulator process in the last part.
                if (sock == null)
                {
                    if (Environment.TickCount > _lingerUntil) break;
                    // If the simulators are clean, you won't have to hold them.
                    if (!AnyEmulatorProcess() && FindEmulator() == IntPtr.Zero) break;
                    Thread.Sleep(120);
                    continue;
                }
                // Short poll: keep the message pump responsive even when no command
                // arrives. Never block for seconds while owning window hooks.
                if (!sock.Poll(50, SelectMode.SelectRead)) continue;
                int n = sock.Receive(buf);
                if (n <= 0)
                {
                    try { sock.Close(); } catch { }
                    sock = null;
                    if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                    break;
                }
                rx.Append(Encoding.UTF8.GetString(buf, 0, n));
                while (true)
                {
                    string all = rx.ToString();
                    int nl = all.IndexOf('\n');
                    if (nl < 0) break;
                    string line = all.Substring(0, nl).Trim();
                    rx.Remove(0, nl + 1);
                    if (line.Length == 0) continue;

                    string cmd = S(line, "cmd");
                    if (cmd == "scope")
                    {
                        // Whitelist of "our" directories. Must arrive before boothide /
                        // embed; the sweeps refuse to touch anything outside it.
                        SetScope(S(line, "dirs"));
                        long appPid = L(line, "pid");
                        _appPid = appPid > 0 ? (uint)appPid : 0;
                        _hostPid = 0;
                        Reply(sock, "{\"ok\":true,\"n\":" + _scopeDirs.Count + "}");
                    }
                    else if (cmd == "embed")
                    {
                        // Cut-back embedded from the stand-alone window: clear the stand-alone mode sign and restore permanent repression.,
                        // Otherwise, the simulator window will be treated as "the one the user is looking at" instead of being involved.
                        _detachedMode = false;
                        // Embedding means "User wants to see the picture."
                        // But first you have to give the window correctly from its hidden state to SetParent.,
                        // Then the SWP_SHOWWINDOW of Fit shows up.
                        IntPtr want = new IntPtr(L(line, "host"));
                        uint wantPid = 0;
                        if (want != IntPtr.Zero) GetWindowThreadProcessId(want, out wantPid);
                        // Never re-parent into a foreign window: a stale handle could
                        // point at another app (the exact way "Hydra Emulator ate WeChat's
                        // window" can happen).
                        if (want == IntPtr.Zero || (_appPid != 0 && wantPid != _appPid))
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"host-not-ours\"}");
                            Thread.Sleep(1);
                        }
                        else
                        {
                            _host = want;
                            _hostPid = wantPid;
                            _chromeRender = FindChromeRender(want);
                            // The third-party base (Mumu et al.) will give us a direct message about the window.
                            // "target" is a comma-separated list of candidates, one by one SetParent.,
                            // The first person to be a host’s window is it.
                            string targets = S(line, "target");
                            _emu = IntPtr.Zero;
                            if (_quiet) { _quiet = false; _bootHideUntil = 0; }   // Keep the window visible for embedding.
                            if (!string.IsNullOrEmpty(targets))
                            {
                                string[] pieces = targets.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                                for (int i = 0; i < pieces.Length; i++)
                                {
                                    IntPtr cand = ParseHwnd(pieces[i]);
                                    if (cand == IntPtr.Zero || !IsWindow(cand)) continue;
                                    // Already embedded in the host's window (repeated embed/ resize): Direct
                                    if (GetParent(cand) == want || GetParent(cand) == _chromeRender)
                                    {
                                        _emu = cand;
                                        break;
                                    }
                                    Embed(_host, cand);
                                    if (GetParent(cand) == _host || GetParent(cand) == _chromeRender)
                                    {
                                        _emu = cand;
                                        break;
                                    }
                                }
                            }
                            else
                            {
                                _emu = FindEmulator();
                                Embed(_host, _emu);
                            }
                            bool ok = _emu != IntPtr.Zero
                                && (GetParent(_emu) == _host || GetParent(_emu) == _chromeRender);
                            _embedAt = Environment.TickCount;
                            _lastToolSweep = 0;
                            Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), true, (int)L(line, "clipTop"));
                            Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + ",\"emu\":" + _emu.ToInt64() + "}");
                            // We didn’t create the third-party base window, and we didn’t restore the display.:
                            // Every candidate has to hang on to WS_VISIBLE, otherwise SetParent will always be hidden after.
                            if (ok && !string.IsNullOrEmpty(targets)) ShowWindow(_emu, 5);
                        }
                    }
                    else if (cmd == "fit")
                    {
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), false, (int)L(line, "clipTop"));
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "rotate")
                    {
                        Rotate(S(line, "dir"));
                        Thread.Sleep(350);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "hide")
                    {
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 0);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "perf")
                    {
                        // JS side-scan on the basis of the priorititymode notification: game mode drop frequency window
                        _perfMode = L(line, "on") != 0;
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "show")
                    {
                        // Detach() in stand-alone window mode emptys _emu (it is treated with “Embedded End“),
                        // So we're going to have to look again, or show/layout, and it all works on the empty handle.,
                        // It’s shown that "The simulator window is missing after cutting the stand-alone window."
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 5);
                        Reply(sock, "{\"ok\":" + (_emu != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "detach")
                    {
                        // Keep=1 means "Cut to Independent Window Mode": do not treat it as
                        // "Embedding End, Hide Simulators." Otherwise QuietSweep will
                        // Hide the window the user is looking at next round.
                        _detachedMode = L(line, "keep") == 1;
                        // Independent mode may never have been ebed _emu or 0, first look,
                        // Detach will return directly, and the next show/layout will all work on the empty handle.
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Detach();
                        Reply(sock, "{\"ok\":true,\"emu\":" + _emu.ToInt64() + "}");
                    }
                    else if (cmd == "title")
                    {
                        // Android Emulator - hydra:5554
                        // Qt will be re-established when the window is rebuilt.
                        // Change the title back, so QuietSweep will reset every patrol.
                        string t = S(line, "text");
                        if (t.Length == 0) t = "Hydra Emulator";
                        _ourTitle = t;
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        bool ok = _emu != IntPtr.Zero && SetWindowTextW(_emu, t);
                        Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + "}");
                    }
                    else if (cmd == "icon")
                    {
                        // Set icons for the emulator’s original window (the taskbar/ Alt+Tab displays the current application icon under stand-alone window mode,
                        // Not the default green robot of the Google emulator. Pass ICO/PNG on the absolute path.
                        string f = S(line, "file");
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        bool ok = false;
                        if (f.Length > 0 && System.IO.File.Exists(f))
                        {
                            // Cache icon handles: release old and load new when switching applications; check and supplement to direct cache,
                            // Not every wheel of LoadImage.
                            if (!String.Equals(f, _ourIconFile, StringComparison.OrdinalIgnoreCase))
                            {
                                if (_ourIconSmall != IntPtr.Zero) DestroyIcon(_ourIconSmall);
                                if (_ourIconBig != IntPtr.Zero) DestroyIcon(_ourIconBig);
                                _ourIconSmall = LoadImageW(IntPtr.Zero, f, 1, 32, 32, 0x10);
                                _ourIconBig = LoadImageW(IntPtr.Zero, f, 1, 64, 64, 0x10);
                                if (_ourIconSmall == IntPtr.Zero) _ourIconSmall = _ourIconBig;
                                if (_ourIconBig == IntPtr.Zero) _ourIconBig = _ourIconSmall;
                                _ourIconFile = f;
                            }
                            if (_emu != IntPtr.Zero && (_ourIconSmall != IntPtr.Zero || _ourIconBig != IntPtr.Zero))
                            {
                                if (_ourIconSmall != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(0), _ourIconSmall);
                                if (_ourIconBig != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(1), _ourIconBig);
                                ok = true;
                            }
                        }
                        Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + "}");
                    }
                    else if (cmd == "layout")
                    {
                        // Separate window mode: Simulator window is the original system window, which is only put here.
                        // Specifies the screen rectangle (not SetParent). Direction/scaling/inputs to itself,
                        // So there’s no black edges to the embedded mode, the coordinates are misallocated, the problem of disgruntled.
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        if (_emu == IntPtr.Zero)
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"no-emu\"}");
                        }
                        else
                        {
                            // Make sure it's a visible top-level window (WS_CHILD has been removed by Detach))
                            ShowWindow(_emu, 5);
                            SetWindowPos(_emu, HWND_TOP,
                                (int)L(line, "x"), (int)L(line, "y"),
                                (int)L(line, "w"), (int)L(line, "h"),
                                SWP_SHOWWINDOW);
                            Reply(sock, "{\"ok\":true}");
                        }
                    }
                    else if (cmd == "hook")
                    {
                        // Options are re-sent on every enable, so changing settings
                        // while the hook is live needs no reinstall / no thread churn.
                        _optRight = L(line, "right") == 1 ? 1 : 0;
                        _optWheel = L(line, "wheel") == 1 ? 1 : 0;
                        _optSide = L(line, "side") == 1 ? 1 : 0;
                        if (L(line, "on") == 1) HookOn(); else HookOff();
                        Reply(sock, "{\"ok\":true,\"hooked\":" + (_hook != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "probe")
                    {
                        IntPtr e = FindEmulator();
                        RECT r = new RECT();
                        if (e != IntPtr.Zero) GetWindowRect(e, out r);
                        Reply(sock, "{\"ok\":true,\"emu\":" + e.ToInt64()
                            + ",\"x\":" + r.L + ",\"y\":" + r.T
                            + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
                    }
                    else if (cmd == "winready")
                    {
                        // Third-party base is forbidden: Candidate handle exists + status is "presence".
                        // Hide judgement on the JS side (see windowReady for backs/ mumu.js).
                        string list = S(line, "target");
                        int alive = 0;
                        string first = "";
                        if (!string.IsNullOrEmpty(list))
                        {
                            string[] pieces = list.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                            for (int i = 0; i < pieces.Length; i++)
                            {
                                IntPtr h = ParseHwnd(pieces[i]);
                                if (h == IntPtr.Zero || !IsWindow(h)) continue;
                                alive++;
                                if (first.Length == 0) first = pieces[i];
                            }
                        }
                        Reply(sock, "{\"ok\":true,\"alive\":" + alive + ",\"first\":\"" + first + "\"}");
                    }
                    else if (cmd == "consoles")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListConsoles() + "]}");
                    }
                    else if (cmd == "windows")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListWindows(L(line, "all") == 1) + "]}");
                    }
                    else if (cmd == "boothide")
                    {
                        if (L(line, "on") == 1)
                        {
                            _quiet = true;
                            _bootHideSweep = 0;
                            _consoleSweep = 0;
                            _bootHideStart = Environment.TickCount;
                            SnapshotConsoles();
                            QuietSweep();
                        }
                        else
                        {
                            // Keep the window still, just press the black window on the control table again.
                            // Users want to look at the simulator window themselves, see startVisible.
                            _quiet = false;
                            HideConsoleWindows();
                        }
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "park")
                    {
                        // Application window is closing: remove the simulator window from the host and hide it.,
                        // Avoids the host from destroying it by re-engineering it to the desktop and restoring it to the top-level visible window
                        // (That’s what the user sees as a “android Emulator’s Black Window“ .
                        _quiet = true;
                        _bootHideStart = Environment.TickCount;
                        _bootHideSweep = 0;
                        ParkEmulator();
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "quit")
                    {
                        Reply(sock, "{\"ok\":true}");
                        run = false;
                        break;
                    }
                    else
                    {
                        Reply(sock, "{\"ok\":false,\"error\":\"unknown\"}");
                    }
                }
            }
            catch (SocketException)
            {
                try { sock.Close(); } catch { }
                sock = null;
                if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                break;
            }
            catch (Exception) { }
        }
        HookOff();
        try { sock.Close(); } catch { }
    }
}
'@

Add-Type -TypeDefinition $src
[ApkAgent]::Serve($Port)
