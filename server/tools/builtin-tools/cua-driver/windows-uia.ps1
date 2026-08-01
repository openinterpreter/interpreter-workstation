param(
  [Parameter(Mandatory=$true)][string]$ToolName,
  [string]$JsonArgs = '{}'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class InterpreterWin32Uia {
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int SWP_NOSIZE = 0x0001;
  public const int SWP_NOMOVE = 0x0002;
  public const int SWP_NOACTIVATE = 0x0010;
  public const int SWP_SHOWWINDOW = 0x0040;
  public const int SWP_NOOWNERZORDER = 0x0200;
  public const int SWP_ASYNCWINDOWPOS = 0x4000;
  public const int SW_SHOWNOACTIVATE = 4;
  public const int WM_GETTEXT = 0x000D;
  public const int WM_GETTEXTLENGTH = 0x000E;
  public const uint GA_ROOT = 2;
  public const uint GW_HWNDNEXT = 2;
  public const int SW_RESTORE = 9;
  public const int INPUT_MOUSE = 0;
  public const int INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public static readonly IntPtr HWND_TOP = IntPtr.Zero;
  public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)]
    public MOUSEINPUT mi;
    [FieldOffset(0)]
    public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  public class TopLevelWindowInfo {
    public IntPtr Hwnd;
    public int ProcessId;
    public string Title = "";
    public RECT Rect;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr WindowFromPoint(POINT Point);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll", EntryPoint="SendMessage", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageString(IntPtr hWnd, int Msg, IntPtr wParam, string lParam);

  [DllImport("user32.dll", EntryPoint="SendMessage", SetLastError=true)]
  public static extern IntPtr SendMessagePtr(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", EntryPoint="SendMessage", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageText(IntPtr hWnd, int Msg, IntPtr wParam, StringBuilder lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern uint MapVirtualKey(uint uCode, uint uMapType);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr GetTopWindow(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindow(IntPtr hWnd);

  public static void PostWindowMessage(IntPtr hwnd, int message, int wParam, int lParam) {
    if (!PostMessage(hwnd, message, new IntPtr(wParam), new IntPtr(lParam))) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "PostMessage failed");
    }
  }

  public static void SendWindowMessage(IntPtr hwnd, int message, int wParam, int lParam) {
    SendMessagePtr(hwnd, message, new IntPtr(wParam), new IntPtr(lParam));
  }

  public static void SendForegroundLeftClick(int screenX, int screenY) {
    if (!SetCursorPos(screenX, screenY)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SetCursorPos failed");
    }

    INPUT[] inputs = new INPUT[2];
    inputs[0].type = INPUT_MOUSE;
    inputs[0].U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    inputs[1].type = INPUT_MOUSE;
    inputs[1].U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput failed");
    }
  }

  public static void SendForegroundLeftDrag(int fromX, int fromY, int toX, int toY) {
    if (!SetCursorPos(fromX, fromY)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SetCursorPos failed");
    }

    INPUT[] down = new INPUT[1];
    down[0].type = INPUT_MOUSE;
    down[0].U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    uint downSent = SendInput((uint)down.Length, down, Marshal.SizeOf(typeof(INPUT)));
    if (downSent != down.Length) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput mouse down failed");
    }

    int steps = 16;
    for (int i = 1; i <= steps; i++) {
      int x = fromX + (int)Math.Round((toX - fromX) * (i / (double)steps));
      int y = fromY + (int)Math.Round((toY - fromY) * (i / (double)steps));
      if (!SetCursorPos(x, y)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "SetCursorPos failed");
      }
      System.Threading.Thread.Sleep(8);
    }

    INPUT[] up = new INPUT[1];
    up[0].type = INPUT_MOUSE;
    up[0].U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    uint upSent = SendInput((uint)up.Length, up, Marshal.SizeOf(typeof(INPUT)));
    if (upSent != up.Length) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput mouse up failed");
    }
  }

  public static void SendForegroundVirtualKey(ushort virtualKey, bool isUp) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].U.ki.wVk = virtualKey;
    inputs[0].U.ki.wScan = 0;
    inputs[0].U.ki.dwFlags = isUp ? KEYEVENTF_KEYUP : 0;
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput keyboard failed");
    }
  }

  public static void SendForegroundUnicodeText(string text) {
    foreach (char ch in text) {
      INPUT[] inputs = new INPUT[2];
      inputs[0].type = INPUT_KEYBOARD;
      inputs[0].U.ki.wVk = 0;
      inputs[0].U.ki.wScan = ch;
      inputs[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
      inputs[1].type = INPUT_KEYBOARD;
      inputs[1].U.ki.wVk = 0;
      inputs[1].U.ki.wScan = ch;
      inputs[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
      if (sent != inputs.Length) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput unicode failed");
      }
    }
  }

  public static string ReadWindowText(IntPtr hwnd) {
    int length = SendMessagePtr(hwnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero).ToInt32();
    StringBuilder builder = new StringBuilder(Math.Max(1, length + 1));
    SendMessageText(hwnd, WM_GETTEXT, new IntPtr(builder.Capacity), builder);
    return builder.ToString();
  }

  public static string ReadClassName(IntPtr hwnd) {
    StringBuilder builder = new StringBuilder(256);
    GetClassName(hwnd, builder, builder.Capacity);
    return builder.ToString();
  }

  public static TopLevelWindowInfo[] GetTopLevelWindowInfos() {
    List<TopLevelWindowInfo> windows = new List<TopLevelWindowInfo>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr lParam) {
      if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) {
        return true;
      }

      RECT rect;
      if (!GetWindowRect(hwnd, out rect)) {
        return true;
      }
      if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) {
        return true;
      }

      StringBuilder titleBuilder = new StringBuilder(512);
      GetWindowText(hwnd, titleBuilder, titleBuilder.Capacity);
      string title = titleBuilder.ToString();
      if (String.IsNullOrWhiteSpace(title)) {
        return true;
      }

      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      if (processId == 0) {
        return true;
      }

      windows.Add(new TopLevelWindowInfo {
        Hwnd = hwnd,
        ProcessId = unchecked((int)processId),
        Title = title,
        Rect = rect
      });
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }

  public static TopLevelWindowInfo GetTopLevelWindowInfo(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) {
      return null;
    }

    IntPtr root = GetAncestor(hwnd, GA_ROOT);
    if (root != IntPtr.Zero) {
      hwnd = root;
    }

    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) {
      return null;
    }
    if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) {
      return null;
    }

    StringBuilder titleBuilder = new StringBuilder(512);
    GetWindowText(hwnd, titleBuilder, titleBuilder.Capacity);
    string title = titleBuilder.ToString();
    if (String.IsNullOrWhiteSpace(title)) {
      return null;
    }

    uint processId;
    GetWindowThreadProcessId(hwnd, out processId);
    if (processId == 0) {
      return null;
    }

    return new TopLevelWindowInfo {
      Hwnd = hwnd,
      ProcessId = unchecked((int)processId),
      Title = title,
      Rect = rect
    };
  }

  public static TopLevelWindowInfo GetTopLevelWindowInfoAtPoint(int screenX, int screenY) {
    POINT point = new POINT { X = screenX, Y = screenY };
    IntPtr hwnd = WindowFromPoint(point);
    return GetTopLevelWindowInfo(hwnd);
  }

  public static IntPtr FindChildWindowAtScreenPoint(IntPtr root, int screenX, int screenY) {
    if (root == IntPtr.Zero || !IsWindow(root)) {
      return root;
    }

    IntPtr best = IntPtr.Zero;
    long bestArea = long.MaxValue;
    EnumChildWindows(root, delegate(IntPtr hwnd, IntPtr lParam) {
      if (!IsWindowVisible(hwnd)) {
        return true;
      }
      RECT rect;
      if (!GetWindowRect(hwnd, out rect)) {
        return true;
      }
      if (screenX < rect.Left || screenX >= rect.Right || screenY < rect.Top || screenY >= rect.Bottom) {
        return true;
      }
      long width = Math.Max(0, rect.Right - rect.Left);
      long height = Math.Max(0, rect.Bottom - rect.Top);
      long area = width * height;
      if (area > 0 && area < bestArea) {
        best = hwnd;
        bestArea = area;
      }
      return true;
    }, IntPtr.Zero);
    return best == IntPtr.Zero ? root : best;
  }

  public static string CaptureWindowPngBase64(IntPtr hwnd, int cropX, int cropY, int cropWidth, int cropHeight, bool crop) {
    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "GetWindowRect failed");
    }
    int width = rect.Right - rect.Left;
    int height = rect.Bottom - rect.Top;
    if (width <= 0 || height <= 0) {
      throw new InvalidOperationException("Window has no drawable area");
    }

    using (Bitmap full = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      using (Graphics graphics = Graphics.FromImage(full)) {
        IntPtr hdc = graphics.GetHdc();
        try {
          if (!PrintWindow(hwnd, hdc, 0)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "PrintWindow failed");
          }
        } finally {
          graphics.ReleaseHdc(hdc);
        }
      }

      Bitmap output = full;
      if (crop) {
        if (cropWidth <= 0 || cropHeight <= 0) {
          throw new ArgumentOutOfRangeException("crop", "Crop width and height must be positive");
        }
        Rectangle cropRect = Rectangle.Intersect(
          new Rectangle(0, 0, width, height),
          new Rectangle(cropX, cropY, cropWidth, cropHeight)
        );
        if (cropRect.Width <= 0 || cropRect.Height <= 0) {
          throw new ArgumentOutOfRangeException("crop", "Crop rectangle is outside the captured window");
        }
        output = full.Clone(cropRect, full.PixelFormat);
      }

      try {
        using (MemoryStream stream = new MemoryStream()) {
          output.Save(stream, ImageFormat.Png);
          return Convert.ToBase64String(stream.ToArray());
        }
      } finally {
        if (crop) {
          output.Dispose();
        }
      }
    }
  }
}

public class InterpreterAgentCursorForm : System.Windows.Forms.Form {
  private static readonly Color TransparentKeyColor = Color.FromArgb(3, 21, 12);
  private const int CursorTipX = 17;
  private const int CursorTipY = 17;
  private double currentX = 0;
  private double currentY = 0;
  private double startX = 0;
  private double startY = 0;
  private double targetX = 0;
  private double targetY = 0;
  private long animationStartMs = 0;
  private int animationDurationMs = 180;
  private bool hasPosition = false;

  public InterpreterAgentCursorForm() {
    FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = false;
    StartPosition = System.Windows.Forms.FormStartPosition.Manual;
    BackColor = TransparentKeyColor;
    TransparencyKey = TransparentKeyColor;
    Width = 34;
    Height = 34;
    Opacity = 0.94;
    DoubleBuffered = true;
  }

  protected override bool ShowWithoutActivation {
    get { return true; }
  }

  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      System.Windows.Forms.CreateParams cp = base.CreateParams;
      cp.ExStyle |= InterpreterWin32Uia.WS_EX_NOACTIVATE
        | InterpreterWin32Uia.WS_EX_TRANSPARENT
        | InterpreterWin32Uia.WS_EX_TOOLWINDOW;
      return cp;
    }
  }

  private static long NowMs() {
    return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
  }

  public void SyncCursor(int x, int y, bool shouldShow, int durationMs, IntPtr targetHwnd) {
    if (!shouldShow) {
      Hide();
      return;
    }
    if (targetHwnd != IntPtr.Zero && !InterpreterWin32Uia.IsWindow(targetHwnd)) {
      Hide();
      return;
    }

    if (!hasPosition) {
      currentX = x;
      currentY = y;
      startX = x;
      startY = y;
      targetX = x;
      targetY = y;
      hasPosition = true;
      animationStartMs = NowMs();
    } else if (x != (int)Math.Round(targetX) || y != (int)Math.Round(targetY)) {
      StepAnimation();
      startX = currentX;
      startY = currentY;
      targetX = x;
      targetY = y;
      animationStartMs = NowMs();
      animationDurationMs = Math.Max(0, durationMs);
    }

    StepAnimation();
    IntPtr insertAfter = ResolveInsertAfter(targetHwnd);
    uint flags = InterpreterWin32Uia.SWP_NOACTIVATE
      | InterpreterWin32Uia.SWP_NOOWNERZORDER
      | InterpreterWin32Uia.SWP_ASYNCWINDOWPOS
      | InterpreterWin32Uia.SWP_SHOWWINDOW;
    int left = (int)Math.Round(currentX) - CursorTipX;
    int top = (int)Math.Round(currentY) - CursorTipY;
    InterpreterWin32Uia.SetWindowPos(Handle, insertAfter, left, top, Width, Height, flags);
    Invalidate();
  }

  private IntPtr ResolveInsertAfter(IntPtr targetHwnd) {
    if (targetHwnd == IntPtr.Zero || !InterpreterWin32Uia.IsWindow(targetHwnd)) {
      return InterpreterWin32Uia.HWND_TOP;
    }

    IntPtr previousVisible = IntPtr.Zero;
    for (IntPtr hwnd = InterpreterWin32Uia.GetTopWindow(IntPtr.Zero);
         hwnd != IntPtr.Zero;
         hwnd = InterpreterWin32Uia.GetWindow(hwnd, InterpreterWin32Uia.GW_HWNDNEXT)) {
      if (hwnd == Handle) {
        continue;
      }
      if (!InterpreterWin32Uia.IsWindowVisible(hwnd)) {
        continue;
      }
      if (hwnd == targetHwnd) {
        return previousVisible == IntPtr.Zero ? InterpreterWin32Uia.HWND_TOP : previousVisible;
      }
      previousVisible = hwnd;
    }
    return InterpreterWin32Uia.HWND_TOP;
  }

  private void StepAnimation() {
    if (animationDurationMs <= 0) {
      currentX = targetX;
      currentY = targetY;
      return;
    }
    double elapsed = Math.Max(0, NowMs() - animationStartMs);
    double t = Math.Min(1.0, elapsed / animationDurationMs);
    double eased = 1.0 - Math.Pow(1.0 - t, 3.0);
    currentX = startX + ((targetX - startX) * eased);
    currentY = startY + ((targetY - startY) * eased);
  }

  protected override void OnPaint(System.Windows.Forms.PaintEventArgs e) {
    base.OnPaint(e);
    e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
    using (SolidBrush shadow = new SolidBrush(Color.FromArgb(92, 0, 0, 0))) {
      e.Graphics.FillEllipse(shadow, 8.0f, 9.0f, 18.0f, 18.0f);
    }
    using (SolidBrush fill = new SolidBrush(Color.FromArgb(230, 5, 88, 50))) {
      e.Graphics.FillEllipse(fill, 7.0f, 7.0f, 18.0f, 18.0f);
    }
    using (Pen outline = new Pen(Color.FromArgb(255, 150, 255, 88), 1.5f)) {
      e.Graphics.DrawEllipse(outline, 7.0f, 7.0f, 18.0f, 18.0f);
    }
  }
}

public class InterpreterAgentActivityForm : System.Windows.Forms.Form {
  private static readonly Color TransparentKeyColor = Color.FromArgb(3, 21, 12);
  private string displayText = "";

  public InterpreterAgentActivityForm() {
    FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = false;
    StartPosition = System.Windows.Forms.FormStartPosition.Manual;
    BackColor = TransparentKeyColor;
    TransparencyKey = TransparentKeyColor;
    Width = 240;
    Height = 40;
    Opacity = 0.96;
    DoubleBuffered = true;
  }

  protected override bool ShowWithoutActivation {
    get { return true; }
  }

  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      System.Windows.Forms.CreateParams cp = base.CreateParams;
      cp.ExStyle |= InterpreterWin32Uia.WS_EX_NOACTIVATE
        | InterpreterWin32Uia.WS_EX_TRANSPARENT
        | InterpreterWin32Uia.WS_EX_TOOLWINDOW;
      return cp;
    }
  }

  public void SyncActivity(string kind, string text, bool shouldShow, IntPtr targetHwnd) {
    if (!shouldShow || String.IsNullOrWhiteSpace(text)) {
      Hide();
      return;
    }
    if (targetHwnd == IntPtr.Zero || !InterpreterWin32Uia.IsWindow(targetHwnd)) {
      Hide();
      return;
    }

    InterpreterWin32Uia.RECT rect;
    if (!InterpreterWin32Uia.GetWindowRect(targetHwnd, out rect)) {
      Hide();
      return;
    }
    int targetWidth = rect.Right - rect.Left;
    int targetHeight = rect.Bottom - rect.Top;
    if (targetWidth <= 0 || targetHeight <= 0) {
      Hide();
      return;
    }

    string nextKind = NormalizeKind(kind);
    string nextText = TrimForDisplay(text, 96);
    string nextDisplayText = nextKind + ": " + nextText;
    int measuredWidth = MeasureDisplayText(nextDisplayText);
    int nextWidth = Math.Min(420, Math.Max(140, Math.Min(targetWidth - 32, measuredWidth + 30)));
    if (Width != nextWidth) {
      Width = nextWidth;
    }

    if (displayText != nextDisplayText) {
      displayText = nextDisplayText;
      Invalidate();
    }

    System.Drawing.Rectangle workingArea = System.Windows.Forms.Screen.FromHandle(targetHwnd).WorkingArea;
    int left = rect.Left + 16;
    int top = rect.Bottom - Height - 16;
    left = Math.Max(workingArea.Left, Math.Min(left, workingArea.Right - Width));
    top = Math.Max(workingArea.Top, Math.Min(top, workingArea.Bottom - Height));

    IntPtr insertAfter = ResolveInsertAfter(targetHwnd);
    uint flags = InterpreterWin32Uia.SWP_NOACTIVATE
      | InterpreterWin32Uia.SWP_NOOWNERZORDER
      | InterpreterWin32Uia.SWP_ASYNCWINDOWPOS
      | InterpreterWin32Uia.SWP_SHOWWINDOW;
    InterpreterWin32Uia.SetWindowPos(Handle, insertAfter, left, top, Width, Height, flags);
    Invalidate();
  }

  private IntPtr ResolveInsertAfter(IntPtr targetHwnd) {
    IntPtr previousVisible = IntPtr.Zero;
    for (IntPtr hwnd = InterpreterWin32Uia.GetTopWindow(IntPtr.Zero);
         hwnd != IntPtr.Zero;
         hwnd = InterpreterWin32Uia.GetWindow(hwnd, InterpreterWin32Uia.GW_HWNDNEXT)) {
      if (hwnd == Handle) {
        continue;
      }
      if (!InterpreterWin32Uia.IsWindowVisible(hwnd)) {
        continue;
      }
      if (hwnd == targetHwnd) {
        return previousVisible == IntPtr.Zero ? InterpreterWin32Uia.HWND_TOP : previousVisible;
      }
      previousVisible = hwnd;
    }
    return InterpreterWin32Uia.HWND_TOP;
  }

  private static string NormalizeKind(string kind) {
    if (String.Equals(kind, "typing", StringComparison.OrdinalIgnoreCase)) return "Typing";
    if (String.Equals(kind, "hotkey", StringComparison.OrdinalIgnoreCase)) return "Hotkey";
    if (String.Equals(kind, "key", StringComparison.OrdinalIgnoreCase)) return "Key";
    if (String.Equals(kind, "scroll", StringComparison.OrdinalIgnoreCase)) return "Scroll";
    return "Action";
  }

  private static string TrimForDisplay(string text, int maxChars) {
    string cleaned = (text ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
    if (cleaned.Length <= maxChars) return cleaned;
    return cleaned.Substring(0, Math.Max(0, maxChars - 3)) + "...";
  }

  private static int MeasureDisplayText(string text) {
    using (Font font = new Font("Segoe UI Semibold", 10.0f, FontStyle.Regular)) {
      Size size = System.Windows.Forms.TextRenderer.MeasureText(
        text,
        font,
        new Size(1000, 40),
        System.Windows.Forms.TextFormatFlags.SingleLine | System.Windows.Forms.TextFormatFlags.NoPadding
      );
      return size.Width;
    }
  }

  private static System.Drawing.Drawing2D.GraphicsPath RoundedRect(RectangleF rect, float radius) {
    float diameter = radius * 2.0f;
    System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath();
    path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
    path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
    path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
    path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
    path.CloseFigure();
    return path;
  }

  protected override void OnPaint(System.Windows.Forms.PaintEventArgs e) {
    base.OnPaint(e);
    e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
    e.Graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
    RectangleF shadowRect = new RectangleF(5.0f, 6.0f, Width - 10.0f, Height - 10.0f);
    using (System.Drawing.Drawing2D.GraphicsPath shadowPath = RoundedRect(shadowRect, 15.0f)) {
      using (SolidBrush shadow = new SolidBrush(Color.FromArgb(88, 0, 0, 0))) {
        e.Graphics.FillPath(shadow, shadowPath);
      }
    }

    RectangleF rect = new RectangleF(4.0f, 3.0f, Width - 8.0f, Height - 8.0f);
    using (System.Drawing.Drawing2D.GraphicsPath path = RoundedRect(rect, 15.0f)) {
      using (SolidBrush fill = new SolidBrush(Color.FromArgb(238, 4, 62, 36))) {
        e.Graphics.FillPath(fill, path);
      }
      using (Pen outline = new Pen(Color.FromArgb(255, 150, 255, 88), 1.0f)) {
        e.Graphics.DrawPath(outline, path);
      }
    }

    using (Font textFont = new Font("Segoe UI Semibold", 10.0f, FontStyle.Regular))
    using (SolidBrush textBrush = new SolidBrush(Color.FromArgb(255, 255, 255, 255)))
    using (StringFormat format = new StringFormat()) {
      format.Alignment = StringAlignment.Near;
      format.LineAlignment = StringAlignment.Center;
      format.Trimming = StringTrimming.EllipsisCharacter;
      format.FormatFlags = StringFormatFlags.NoWrap;
      RectangleF textRect = new RectangleF(16.0f, 4.0f, Width - 32.0f, Height - 10.0f);
      e.Graphics.DrawString(displayText, textFont, textBrush, textRect, format);
    }
  }
}
"@ -ReferencedAssemblies @('System.Drawing.dll', 'System.Windows.Forms.dll')

[void][InterpreterWin32Uia]::SetProcessDpiAwarenessContext([InterpreterWin32Uia]::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)

$WM_SETTEXT = 0x000C
$WM_CONTEXTMENU = 0x007B
$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$WM_CHAR = 0x0102
$WM_SYSKEYDOWN = 0x0104
$WM_SYSKEYUP = 0x0105
$WM_MOUSEMOVE = 0x0200
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202
$WM_RBUTTONDOWN = 0x0204
$WM_RBUTTONUP = 0x0205
$BM_CLICK = 0x00F5
$CB_SELECTSTRING = 0x014D
$EM_SETSEL = 0x00B1
$EM_REPLACESEL = 0x00C2
$MK_LBUTTON = 0x0001
$MK_RBUTTON = 0x0002
$MAPVK_VK_TO_VSC = 0
$script:WINDOWS_UIA_DAEMON_MODE = $false
$script:COM_AUTOMATION_OBJECTS = @{}
$DRIVER_STATE_PATH = Join-Path ([System.IO.Path]::GetTempPath()) 'interpreter-desktop-driver-windows-state.json'
$NO_FOCUS_UIA_HELPER_DLL = Join-Path ([System.IO.Path]::GetTempPath()) 'interpreter-desktop-uia-nofocus-v1.dll'
$NO_FOCUS_UIA_HELPER_SOURCE = @"
using System;
using System.Runtime.InteropServices;

namespace InterpreterWindowsUiaNoFocus {
  public enum TreeScope {
    Element = 1,
    Children = 2,
    Descendants = 4,
    Parent = 8,
    Ancestors = 16,
    Subtree = 7
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [ComImport, Guid("E22AD333-B25F-460C-83D0-0581107395C9")]
  public class CUIAutomation8 {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D22108AA-8AC5-49A5-837B-37BBB3D7591E")]
  public interface IUIAutomationElement {
    [PreserveSig] int SetFocus();
    [PreserveSig] int GetRuntimeId(out IntPtr runtimeId);
    [PreserveSig] int FindFirst(TreeScope scope, IUIAutomationCondition condition, out IUIAutomationElement element);
    [PreserveSig] int FindAll(TreeScope scope, IUIAutomationCondition condition, out IntPtr elements);
    [PreserveSig] int FindFirstBuildCache(TreeScope scope, IUIAutomationCondition condition, IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int FindAllBuildCache(TreeScope scope, IUIAutomationCondition condition, IntPtr cacheRequest, out IntPtr elements);
    [PreserveSig] int BuildUpdatedCache(IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int GetCurrentPropertyValue(int propertyId, out object value);
    [PreserveSig] int GetCurrentPropertyValueEx(int propertyId, int ignoreDefaultValue, out object value);
    [PreserveSig] int GetCachedPropertyValue(int propertyId, out object value);
    [PreserveSig] int GetCachedPropertyValueEx(int propertyId, int ignoreDefaultValue, out object value);
    [PreserveSig] int GetCurrentPatternAs(int patternId, ref Guid riid, out IUIAutomationInvokePattern pattern);
    [PreserveSig] int GetCachedPatternAs(int patternId, ref Guid riid, out IUIAutomationInvokePattern pattern);
    [PreserveSig] int GetCurrentPattern(int patternId, out IntPtr pattern);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("FB377FBE-8EA6-46D5-9C73-6499642D3059")]
  public interface IUIAutomationInvokePattern {
    [PreserveSig] int Invoke();
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("352FFBA8-0973-437C-A61F-F64CAFD81DF9")]
  public interface IUIAutomationCondition {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("34723AFF-0C9D-49D0-9896-7AB52DF8CD8A")]
  public interface IUIAutomation2 {
    [PreserveSig] int CompareElements();
    [PreserveSig] int CompareRuntimeIds();
    [PreserveSig] int GetRootElement(out IUIAutomationElement element);
    [PreserveSig] int ElementFromHandle(IntPtr hwnd, out IUIAutomationElement element);
    [PreserveSig] int ElementFromPoint(POINT pt, out IUIAutomationElement element);
    [PreserveSig] int GetFocusedElement(out IUIAutomationElement element);
    [PreserveSig] int GetRootElementBuildCache(IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int ElementFromHandleBuildCache(IntPtr hwnd, IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int ElementFromPointBuildCache(POINT pt, IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int GetFocusedElementBuildCache(IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int CreateTreeWalker(IUIAutomationCondition condition, out IntPtr walker);
    [PreserveSig] int GetControlViewWalker(out IntPtr walker);
    [PreserveSig] int GetContentViewWalker(out IntPtr walker);
    [PreserveSig] int GetRawViewWalker(out IntPtr walker);
    [PreserveSig] int GetRawViewCondition(out IUIAutomationCondition condition);
    [PreserveSig] int GetControlViewCondition(out IUIAutomationCondition condition);
    [PreserveSig] int GetContentViewCondition(out IUIAutomationCondition condition);
    [PreserveSig] int CreateCacheRequest(out IntPtr cacheRequest);
    [PreserveSig] int CreateTrueCondition(out IUIAutomationCondition condition);
    [PreserveSig] int CreateFalseCondition(out IUIAutomationCondition condition);
    [PreserveSig] int CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value, out IUIAutomationCondition condition);
    [PreserveSig] int CreatePropertyConditionEx(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value, int flags, out IUIAutomationCondition condition);
    [PreserveSig] int CreateAndCondition(IUIAutomationCondition condition1, IUIAutomationCondition condition2, out IUIAutomationCondition condition);
    [PreserveSig] int CreateAndConditionFromArray(IntPtr conditions, out IUIAutomationCondition condition);
    [PreserveSig] int CreateAndConditionFromNativeArray(IntPtr conditions, int conditionCount, out IUIAutomationCondition condition);
    [PreserveSig] int CreateOrCondition(IUIAutomationCondition condition1, IUIAutomationCondition condition2, out IUIAutomationCondition condition);
    [PreserveSig] int CreateOrConditionFromArray(IntPtr conditions, out IUIAutomationCondition condition);
    [PreserveSig] int CreateOrConditionFromNativeArray(IntPtr conditions, int conditionCount, out IUIAutomationCondition condition);
    [PreserveSig] int CreateNotCondition(IUIAutomationCondition condition, out IUIAutomationCondition notCondition);
    [PreserveSig] int AddAutomationEventHandler();
    [PreserveSig] int RemoveAutomationEventHandler();
    [PreserveSig] int AddPropertyChangedEventHandlerNativeArray();
    [PreserveSig] int AddPropertyChangedEventHandler();
    [PreserveSig] int RemovePropertyChangedEventHandler();
    [PreserveSig] int AddStructureChangedEventHandler();
    [PreserveSig] int RemoveStructureChangedEventHandler();
    [PreserveSig] int AddFocusChangedEventHandler();
    [PreserveSig] int RemoveFocusChangedEventHandler();
    [PreserveSig] int RemoveAllEventHandlers();
    [PreserveSig] int IntNativeArrayToSafeArray(IntPtr array, int arrayCount, out IntPtr safeArray);
    [PreserveSig] int IntSafeArrayToNativeArray(IntPtr intArray, out IntPtr array, out int arrayCount);
    [PreserveSig] int RectToVariant(IntPtr rc, out object var);
    [PreserveSig] int VariantToRect([MarshalAs(UnmanagedType.Struct)] object var, out IntPtr rc);
    [PreserveSig] int SafeArrayToRectNativeArray(IntPtr rects, out IntPtr rectArray, out int rectCount);
    [PreserveSig] int CreateProxyFactoryEntry(IntPtr factory, out IntPtr factoryEntry);
    [PreserveSig] int GetProxyFactoryMapping(out IntPtr mapping);
    [PreserveSig] int GetPropertyProgrammaticName(int property, [MarshalAs(UnmanagedType.BStr)] out string name);
    [PreserveSig] int GetPatternProgrammaticName(int pattern, [MarshalAs(UnmanagedType.BStr)] out string name);
    [PreserveSig] int PollForPotentialSupportedPatterns();
    [PreserveSig] int PollForPotentialSupportedProperties();
    [PreserveSig] int CheckNotSupported([MarshalAs(UnmanagedType.Struct)] object value, out int isNotSupported);
    [PreserveSig] int GetReservedNotSupportedValue(out object value);
    [PreserveSig] int GetReservedMixedAttributeValue(out object value);
    [PreserveSig] int ElementFromIAccessible(IntPtr accessible, int childId, out IUIAutomationElement element);
    [PreserveSig] int ElementFromIAccessibleBuildCache(IntPtr accessible, int childId, IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int GetAutoSetFocus(out int autoSetFocus);
    [PreserveSig] int SetAutoSetFocus(int autoSetFocus);
    [PreserveSig] int GetConnectionTimeout(out uint timeout);
    [PreserveSig] int SetConnectionTimeout(uint timeout);
    [PreserveSig] int GetTransactionTimeout(out uint timeout);
    [PreserveSig] int SetTransactionTimeout(uint timeout);
  }

  public static class AutomationNoFocus {
    public static void InvokeByAutomationId(IntPtr hwnd, string automationId) {
      var automation = (IUIAutomation2)new CUIAutomation8();
      Check(automation.SetAutoSetFocus(0));
      IUIAutomationElement window;
      Check(automation.ElementFromHandle(hwnd, out window));
      if (window == null) {
        throw new InvalidOperationException("Window element not found.");
      }
      IUIAutomationCondition condition;
      Check(automation.CreatePropertyCondition(30011, automationId, out condition));
      if (condition == null) {
        throw new InvalidOperationException("AutomationId condition could not be created.");
      }
      IUIAutomationElement element;
      Check(window.FindFirst(TreeScope.Descendants, condition, out element));
      if (element == null) {
        throw new InvalidOperationException("Element not found: " + automationId);
      }
      var patternId = typeof(IUIAutomationInvokePattern).GUID;
      IUIAutomationInvokePattern pattern;
      Check(element.GetCurrentPatternAs(10000, ref patternId, out pattern));
      if (pattern == null) {
        throw new InvalidOperationException("Invoke pattern not found: " + automationId);
      }
      Check(pattern.Invoke());
    }

    private static void Check(int hresult) {
      if (hresult < 0) {
        Marshal.ThrowExceptionForHR(hresult);
      }
    }
  }
}
"@

function Write-JsonResult {
  param([bool]$Ok, [object]$Data = $null, [object]$ErrorData = $null)
  $result = [ordered]@{
    ok = $Ok
    platform = 'win32'
    tool = $ToolName
  }
  if ($Ok) {
    $result.data = $Data
  } else {
    $result.error = $ErrorData
  }
  $result | ConvertTo-Json -Depth 80 -Compress
}

function Trace-Uia {
  param([string]$Message)
  $traceRoot = $env:SCENARIO_RUN_DIR
  if ([string]::IsNullOrWhiteSpace($traceRoot)) {
    return
  }
  try {
    $line = '[{0}] {1}' -f ([DateTime]::UtcNow.ToString('o')), $Message
    Add-Content -Path (Join-Path $traceRoot 'windows-uia-trace.log') -Value $line
  } catch {
  }
}

function Fail {
  param([string]$Code, [string]$Message, [string]$Suggestion = '')
  $errorData = [ordered]@{ code = $Code; message = $Message }
  if ($Suggestion) { $errorData.suggestion = $Suggestion }
  if ([bool]$script:WINDOWS_UIA_DAEMON_MODE) {
    throw (($errorData | ConvertTo-Json -Depth 20 -Compress))
  }
  Write-JsonResult -Ok $false -ErrorData $errorData
  exit 1
}

function Args-Object {
  if ([string]::IsNullOrWhiteSpace($JsonArgs)) {
    return [pscustomobject]@{}
  }
  return $JsonArgs | ConvertFrom-Json
}

function Has-Arg {
  param($InputArgs, [string]$Name)
  return $InputArgs.PSObject.Properties.Name -contains $Name
}

function Read-Text-Shared {
  param([string]$Path)
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
    try {
      return $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Write-Text-Shared {
  param([string]$Path, [string]$Text)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
  try {
    $writer = New-Object System.IO.StreamWriter($stream, $encoding)
    try {
      $writer.Write($Text)
    } finally {
      $writer.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Read-Driver-State {
  if (Test-Path -LiteralPath $DRIVER_STATE_PATH) {
    try {
      $state = Read-Text-Shared $DRIVER_STATE_PATH | ConvertFrom-Json
      return Ensure-Driver-State $state
    } catch {
      Fail 'DRIVER_STATE_INVALID' "Windows Computer Use state is invalid at '$DRIVER_STATE_PATH': $($_.Exception.Message)"
    }
  }
  return Ensure-Driver-State ([pscustomobject]@{
    config = [pscustomobject]@{
      backend = 'windows-uia'
      capture_mode = 'printwindow'
    }
    agent_cursor = [pscustomobject]@{
      enabled = $true
      supported = $true
      rendered = $false
      overlay_pid = $null
      target_hwnd = $null
      last_moved_at = $null
      activity_kind = $null
      activity_text = $null
      activity_target_hwnd = $null
      last_activity_at = $null
      activity_idle_hide_ms = 3500
      real_cursor_moved = $false
      x = 0
      y = 0
      anchor_offset_x = $null
      anchor_offset_y = $null
      motion = [pscustomobject]@{
        duration_ms = 180
        idle_hide_ms = 3600000
      }
    }
    recording = [pscustomobject]@{
      enabled = $false
      supported = $true
      events = @()
    }
  })
}

function Write-Driver-State {
  param($State)
  Write-Text-Shared $DRIVER_STATE_PATH ($State | ConvertTo-Json -Depth 80 -Compress)
}

function Set-State-Property {
  param($Object, [string]$Name, $Value)
  if ($Object.PSObject.Properties.Name -contains $Name) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Ensure-Driver-State {
  param($State)
  if ($null -eq $State.config) {
    Set-State-Property $State 'config' ([pscustomobject]@{})
  }
  if ($null -eq $State.agent_cursor) {
    Set-State-Property $State 'agent_cursor' ([pscustomobject]@{})
  }
  if ($null -eq $State.recording) {
    Set-State-Property $State 'recording' ([pscustomobject]@{})
  }

  Set-State-Property $State.config 'backend' 'windows-uia'
  if (!($State.config.PSObject.Properties.Name -contains 'capture_mode')) {
    Set-State-Property $State.config 'capture_mode' 'printwindow'
  }

  $cursor = $State.agent_cursor
  if (!($cursor.PSObject.Properties.Name -contains 'enabled')) { Set-State-Property $cursor 'enabled' $true }
  Set-State-Property $cursor 'supported' $true
  if (!($cursor.PSObject.Properties.Name -contains 'rendered')) { Set-State-Property $cursor 'rendered' $false }
  if (!($cursor.PSObject.Properties.Name -contains 'overlay_pid')) { Set-State-Property $cursor 'overlay_pid' $null }
  if (!($cursor.PSObject.Properties.Name -contains 'target_hwnd')) { Set-State-Property $cursor 'target_hwnd' $null }
  if (!($cursor.PSObject.Properties.Name -contains 'last_moved_at')) { Set-State-Property $cursor 'last_moved_at' $null }
  if (!($cursor.PSObject.Properties.Name -contains 'activity_kind')) { Set-State-Property $cursor 'activity_kind' $null }
  if (!($cursor.PSObject.Properties.Name -contains 'activity_text')) { Set-State-Property $cursor 'activity_text' $null }
  if (!($cursor.PSObject.Properties.Name -contains 'activity_target_hwnd')) { Set-State-Property $cursor 'activity_target_hwnd' $null }
  if (!($cursor.PSObject.Properties.Name -contains 'last_activity_at')) { Set-State-Property $cursor 'last_activity_at' $null }
  if (!($cursor.PSObject.Properties.Name -contains 'activity_idle_hide_ms')) { Set-State-Property $cursor 'activity_idle_hide_ms' 3500 }
  Set-State-Property $cursor 'real_cursor_moved' $false
  if (!($cursor.PSObject.Properties.Name -contains 'x')) { Set-State-Property $cursor 'x' 0 }
  if (!($cursor.PSObject.Properties.Name -contains 'y')) { Set-State-Property $cursor 'y' 0 }
  if (!($cursor.PSObject.Properties.Name -contains 'anchor_offset_x')) { Set-State-Property $cursor 'anchor_offset_x' $null }
  if (!($cursor.PSObject.Properties.Name -contains 'anchor_offset_y')) { Set-State-Property $cursor 'anchor_offset_y' $null }
  if ($null -eq $cursor.motion) { Set-State-Property $cursor 'motion' ([pscustomobject]@{}) }
  if (!($cursor.motion.PSObject.Properties.Name -contains 'duration_ms')) { Set-State-Property $cursor.motion 'duration_ms' 180 }
  if (!($cursor.motion.PSObject.Properties.Name -contains 'idle_hide_ms')) { Set-State-Property $cursor.motion 'idle_hide_ms' 3600000 }

  $recording = $State.recording
  if (!($recording.PSObject.Properties.Name -contains 'enabled')) { Set-State-Property $recording 'enabled' $false }
  Set-State-Property $recording 'supported' $true
  if (!($recording.PSObject.Properties.Name -contains 'events') -or $null -eq $recording.events) {
    Set-State-Property $recording 'events' @()
  }
  return $State
}

function Test-Process-Alive {
  param($PidValue)
  if ($null -eq $PidValue) { return $false }
  try {
    $pidNumber = [int]$PidValue
    if ($pidNumber -le 0) { return $false }
    $null = Get-Process -Id $pidNumber -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Refresh-Agent-Cursor-Overlay-State {
  param($State)
  $state = Ensure-Driver-State $State
  $state = Update-Agent-Cursor-Live-Position $state
  $alive = Test-Process-Alive $state.agent_cursor.overlay_pid
  if (!$alive) {
    Set-State-Property $state.agent_cursor 'overlay_pid' $null
  }
  Set-State-Property $state.agent_cursor 'rendered' ([bool]($state.agent_cursor.enabled -and $alive))
  Set-State-Property $state.agent_cursor 'real_cursor_moved' $false
  return $state
}

function Set-Agent-Cursor-Anchor {
  param($Cursor, [IntPtr]$TargetHwnd, [int]$X, [int]$Y)
  if ($TargetHwnd -ne [IntPtr]::Zero -and [InterpreterWin32Uia]::IsWindow($TargetHwnd)) {
    $rect = New-Object InterpreterWin32Uia+RECT
    if ([InterpreterWin32Uia]::GetWindowRect($TargetHwnd, [ref]$rect)) {
      Set-State-Property $Cursor 'anchor_offset_x' ([int]($X - $rect.Left))
      Set-State-Property $Cursor 'anchor_offset_y' ([int]($Y - $rect.Top))
      return
    }
  }
  Set-State-Property $Cursor 'anchor_offset_x' $null
  Set-State-Property $Cursor 'anchor_offset_y' $null
}

function Resolve-Agent-Cursor-Live-Point {
  param($Cursor)
  $x = if ($null -ne $Cursor.x) { [int]$Cursor.x } else { 0 }
  $y = if ($null -ne $Cursor.y) { [int]$Cursor.y } else { 0 }
  $targetHwnd = if ($null -ne $Cursor.target_hwnd) { [IntPtr]([int64]$Cursor.target_hwnd) } else { [IntPtr]::Zero }
  $fromAnchor = $false

  if (
    $targetHwnd -ne [IntPtr]::Zero `
    -and [InterpreterWin32Uia]::IsWindow($targetHwnd) `
    -and $null -ne $Cursor.anchor_offset_x `
    -and $null -ne $Cursor.anchor_offset_y
  ) {
    $rect = New-Object InterpreterWin32Uia+RECT
    if ([InterpreterWin32Uia]::GetWindowRect($targetHwnd, [ref]$rect)) {
      $x = [int]($rect.Left + [int]$Cursor.anchor_offset_x)
      $y = [int]($rect.Top + [int]$Cursor.anchor_offset_y)
      $fromAnchor = $true
    }
  }

  return [pscustomobject]@{
    x = $x
    y = $y
    target_hwnd = $targetHwnd
    from_anchor = $fromAnchor
  }
}

function Update-Agent-Cursor-Live-Position {
  param($State)
  $state = Ensure-Driver-State $State
  $point = Resolve-Agent-Cursor-Live-Point $state.agent_cursor
  if ([bool]$point.from_anchor -and ([int]$state.agent_cursor.x -ne [int]$point.x -or [int]$state.agent_cursor.y -ne [int]$point.y)) {
    Set-State-Property $state.agent_cursor 'x' ([int]$point.x)
    Set-State-Property $state.agent_cursor 'y' ([int]$point.y)
  }
  return $state
}

function Stop-Agent-Cursor-Overlay {
  param($State)
  $state = Ensure-Driver-State $State
  $overlayPid = $state.agent_cursor.overlay_pid
  Set-State-Property $state.agent_cursor 'enabled' $false
  Set-State-Property $state.agent_cursor 'rendered' $false
  Set-State-Property $state.agent_cursor 'overlay_pid' $null
  Set-State-Property $state.agent_cursor 'activity_kind' $null
  Set-State-Property $state.agent_cursor 'activity_text' $null
  Set-State-Property $state.agent_cursor 'activity_target_hwnd' $null
  Set-State-Property $state.agent_cursor 'last_activity_at' $null
  Set-State-Property $state.agent_cursor 'real_cursor_moved' $false
  Write-Driver-State $state
  if (Test-Process-Alive $overlayPid) {
    try {
      Stop-Process -Id ([int]$overlayPid) -Force -ErrorAction SilentlyContinue
    } catch {}
  }
  return $state
}

function Initialize-Agent-Cursor-Session {
  $state = Read-Driver-State
  Set-State-Property $state.agent_cursor 'enabled' $true
  Set-State-Property $state.agent_cursor 'supported' $true
  Set-State-Property $state.agent_cursor 'rendered' $false
  Set-State-Property $state.agent_cursor 'overlay_pid' $null
  Set-State-Property $state.agent_cursor 'activity_kind' $null
  Set-State-Property $state.agent_cursor 'activity_text' $null
  Set-State-Property $state.agent_cursor 'activity_target_hwnd' $null
  Set-State-Property $state.agent_cursor 'last_activity_at' $null
  Set-State-Property $state.agent_cursor 'real_cursor_moved' $false
  Write-Driver-State $state
}

function Start-Agent-Cursor-Overlay {
  param($State)
  $state = Refresh-Agent-Cursor-Overlay-State $State
  if (Test-Process-Alive $state.agent_cursor.overlay_pid) {
    Set-State-Property $state.agent_cursor 'rendered' $true
    Write-Driver-State $state
    return $state
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = 'powershell.exe'
  $startInfo.Arguments = "-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File `"$PSCommandPath`" __agent_cursor_overlay '{}'"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  Set-State-Property $state.agent_cursor 'overlay_pid' $process.Id
  Set-State-Property $state.agent_cursor 'rendered' $true
  Set-State-Property $state.agent_cursor 'real_cursor_moved' $false
  Write-Driver-State $state
  return $state
}

function Get-Agent-Cursor-Motion-Int {
  param($Cursor, [string]$Name, [int]$DefaultValue)
  try {
    if ($Cursor.motion -and ($Cursor.motion.PSObject.Properties.Name -contains $Name) -and $null -ne $Cursor.motion.$Name) {
      return [int]$Cursor.motion.$Name
    }
  } catch {}
  return $DefaultValue
}

function Set-Agent-Cursor-Position {
  param($State, $Point, [IntPtr]$TargetHwnd)
  $state = Ensure-Driver-State $State
  Set-State-Property $state.agent_cursor 'enabled' $true
  Set-State-Property $state.agent_cursor 'supported' $true
  Set-State-Property $state.agent_cursor 'x' ([int]$Point.x)
  Set-State-Property $state.agent_cursor 'y' ([int]$Point.y)
  Set-State-Property $state.agent_cursor 'target_hwnd' ($TargetHwnd.ToInt64())
  Set-Agent-Cursor-Anchor $state.agent_cursor $TargetHwnd ([int]$Point.x) ([int]$Point.y)
  Set-State-Property $state.agent_cursor 'last_moved_at' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  Set-State-Property $state.agent_cursor 'real_cursor_moved' $false
  Write-Driver-State $state
  return Start-Agent-Cursor-Overlay $state
}

function Set-Agent-Cursor-Activity {
  param($State, [string]$Kind, [string]$Text, [IntPtr]$TargetHwnd)
  $state = Ensure-Driver-State $State
  Set-State-Property $state.agent_cursor 'enabled' $true
  Set-State-Property $state.agent_cursor 'supported' $true
  Set-State-Property $state.agent_cursor 'activity_kind' $Kind
  Set-State-Property $state.agent_cursor 'activity_text' $Text
  Set-State-Property $state.agent_cursor 'activity_target_hwnd' ($TargetHwnd.ToInt64())
  Set-State-Property $state.agent_cursor 'last_activity_at' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  Set-State-Property $state.agent_cursor 'real_cursor_moved' $false
  Write-Driver-State $state
  return Start-Agent-Cursor-Overlay $state
}

function Show-Agent-Cursor-Target {
  param($Target, [string]$ActivityKind = '', [string]$ActivityText = '')
  $state = Read-Driver-State
  if ($env:INTERPRETER_WINDOWS_UIA_CURSOR_OVERLAY -eq '0') {
    return $state
  }
  $targetHwnd = [IntPtr][int]$Target.window._handle
  $point = Center-Of-Rect $Target.bounds
  Set-State-Property $state.agent_cursor 'enabled' $true
  Set-State-Property $state.agent_cursor 'supported' $true
  Set-State-Property $state.agent_cursor 'target_hwnd' ($targetHwnd.ToInt64())
  if ($null -ne $point) {
    Set-State-Property $state.agent_cursor 'x' ([int]$point.x)
    Set-State-Property $state.agent_cursor 'y' ([int]$point.y)
    Set-Agent-Cursor-Anchor $state.agent_cursor $targetHwnd ([int]$point.x) ([int]$point.y)
    Set-State-Property $state.agent_cursor 'last_moved_at' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  }
  if (![string]::IsNullOrWhiteSpace($ActivityText)) {
    Set-State-Property $state.agent_cursor 'activity_kind' $ActivityKind
    Set-State-Property $state.agent_cursor 'activity_text' $ActivityText
    Set-State-Property $state.agent_cursor 'activity_target_hwnd' ($targetHwnd.ToInt64())
    Set-State-Property $state.agent_cursor 'last_activity_at' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  }
  Set-State-Property $state.agent_cursor 'real_cursor_moved' $false
  Write-Driver-State $state
  return Start-Agent-Cursor-Overlay $state
}

function Run-Agent-Cursor-Overlay {
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $context = New-Object System.Windows.Forms.ApplicationContext
  $form = New-Object InterpreterAgentCursorForm
  $activityForm = New-Object InterpreterAgentActivityForm
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 16
  $timer.Add_Tick({
    try {
      if (!(Test-Path -LiteralPath $DRIVER_STATE_PATH)) {
        $timer.Stop()
        [System.Windows.Forms.Application]::ExitThread()
        return
      }
      $state = Read-Text-Shared $DRIVER_STATE_PATH | ConvertFrom-Json
      $state = Ensure-Driver-State $state
      $cursor = $state.agent_cursor
      if (!([bool]$cursor.enabled)) {
        $timer.Stop()
        $form.Hide()
        [System.Windows.Forms.Application]::ExitThread()
        return
      }

      $durationMs = Get-Agent-Cursor-Motion-Int $cursor 'duration_ms' 180
      $idleHideMs = Get-Agent-Cursor-Motion-Int $cursor 'idle_hide_ms' 3600000
      $lastMovedAt = if ($null -ne $cursor.last_moved_at) { [int64]$cursor.last_moved_at } else { 0 }
      $shouldShow = $lastMovedAt -gt 0
      if ($shouldShow -and $idleHideMs -ge 0) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $shouldShow = (($nowMs - $lastMovedAt) -le $idleHideMs)
      }
      $livePoint = Resolve-Agent-Cursor-Live-Point $cursor
      $renderDurationMs = if ([bool]$livePoint.from_anchor -and ([int]$cursor.x -ne [int]$livePoint.x -or [int]$cursor.y -ne [int]$livePoint.y)) { 0 } else { $durationMs }
      $form.SyncCursor([int]$livePoint.x, [int]$livePoint.y, $shouldShow, $renderDurationMs, $livePoint.target_hwnd)

      $activityText = if ($null -ne $cursor.activity_text) { [string]$cursor.activity_text } else { '' }
      $activityKind = if ($null -ne $cursor.activity_kind) { [string]$cursor.activity_kind } else { 'action' }
      $activityTargetHwnd = if ($null -ne $cursor.activity_target_hwnd) { [IntPtr]([int64]$cursor.activity_target_hwnd) } else { $livePoint.target_hwnd }
      $activityLastAt = if ($null -ne $cursor.last_activity_at) { [int64]$cursor.last_activity_at } else { 0 }
      $activityIdleMs = if ($null -ne $cursor.activity_idle_hide_ms) { [int]$cursor.activity_idle_hide_ms } else { 3500 }
      $showActivity = $activityLastAt -gt 0 -and ![string]::IsNullOrWhiteSpace($activityText)
      if ($showActivity -and $activityIdleMs -ge 0) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $showActivity = (($nowMs - $activityLastAt) -le $activityIdleMs)
      }
      $activityForm.SyncActivity($activityKind, $activityText, $showActivity, $activityTargetHwnd)
    } catch {}
  })
  $timer.Start()
  try {
    [System.Windows.Forms.Application]::Run($context)
  } finally {
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
    $activityForm.Dispose()
  }
}

function Add-Recorded-Event {
  param([string]$RecordedToolName, $InputArgs, $ResultData = $null)
  $state = Read-Driver-State
  if (!$state.recording -or !$state.recording.enabled) { return }
  $events = @($state.recording.events)
  $events += [ordered]@{
    tool = $RecordedToolName
    args = $InputArgs
    result = $ResultData
    recorded_at = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $state.recording.events = $events
  Write-Driver-State $state
}

function Control-Type-Name {
  param([System.Windows.Automation.ControlType]$ControlType)
  if ($null -eq $ControlType) { return 'unknown' }
  return ($ControlType.ProgrammaticName -replace '^ControlType\.', '').ToLowerInvariant()
}

function Rect-Object {
  param($Rect)
  if ($null -eq $Rect -or $Rect.IsEmpty) { return $null }
  return [ordered]@{
    x = [double]$Rect.X
    y = [double]$Rect.Y
    width = [double]$Rect.Width
    height = [double]$Rect.Height
  }
}

function Center-Of-Rect {
  param($Rect)
  if ($null -eq $Rect) { return $null }
  return [ordered]@{
    x = [int][Math]::Round([double]$Rect.x + ([double]$Rect.width / 2))
    y = [int][Math]::Round([double]$Rect.y + ([double]$Rect.height / 2))
  }
}

function Rect-Intersection-Area {
  param($Left, $Right)
  if ($null -eq $Left -or $null -eq $Right) { return 0 }
  $leftX = [double]$Left.x
  $leftY = [double]$Left.y
  $leftRight = $leftX + [double]$Left.width
  $leftBottom = $leftY + [double]$Left.height
  $rightX = [double]$Right.x
  $rightY = [double]$Right.y
  $rightRight = $rightX + [double]$Right.width
  $rightBottom = $rightY + [double]$Right.height
  $width = [Math]::Min($leftRight, $rightRight) - [Math]::Max($leftX, $rightX)
  $height = [Math]::Min($leftBottom, $rightBottom) - [Math]::Max($leftY, $rightY)
  if ($width -le 0 -or $height -le 0) { return 0 }
  return [double]($width * $height)
}

function Rect-Intersects {
  param($Left, $Right)
  return ((Rect-Intersection-Area $Left $Right) -gt 0)
}

function Make-LParam {
  param([int]$Low, [int]$High)
  $value = (($High -band 0xffff) -shl 16) -bor ($Low -band 0xffff)
  return [IntPtr][int64]$value
}

function Get-LastWin32Error {
  return [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

function Object-Value {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
    return $Object[$Name]
  }
  if ($Object.PSObject.Properties.Name -contains $Name) {
    return $Object.$Name
  }
  return $null
}

function Convert-Com-Value {
  param($Value, [int]$Depth = 0, [int]$Limit = 40)
  if ($null -eq $Value) { return $null }
  if ($Value -is [string] -or $Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
    return $Value
  }
  if ($Value -is [datetime]) {
    return $Value.ToString('o')
  }
  if ($Depth -lt 2 -and $Value -is [System.Collections.IEnumerable] -and !($Value -is [string])) {
    $items = @()
    $count = 0
    foreach ($item in $Value) {
      if ($count -ge $Limit) { break }
      $items += Convert-Com-Value $item ($Depth + 1) $Limit
      $count += 1
    }
    return [ordered]@{
      type = $Value.GetType().FullName
      count_returned = $items.Count
      items = $items
    }
  }
  return [ordered]@{
    type = $Value.GetType().FullName
    text = [string]$Value
  }
}

function Invoke-Com-Member {
  param($Target, [string]$Member, [string]$Kind, [object[]]$Arguments = @())
  if ([string]::IsNullOrWhiteSpace($Member)) {
    Fail 'INVALID_ARGS' 'com_automation member is required for get, set, and invoke.'
  }
  $flags = switch ($Kind) {
    'get' { [System.Reflection.BindingFlags]::GetProperty }
    'set' { [System.Reflection.BindingFlags]::SetProperty }
    'invoke' { [System.Reflection.BindingFlags]::InvokeMethod }
    default { Fail 'INVALID_ARGS' "Unsupported COM member action '$Kind'." }
  }
  try {
    return $Target.GetType().InvokeMember($Member, $flags, $null, $Target, $Arguments)
  } catch {
    Fail 'COM_AUTOMATION_FAILED' "COM $Kind '$Member' failed: $($_.Exception.Message)"
  }
}

function Resolve-Com-Automation-Object {
  param($InputArgs)
  $progId = if (Has-Arg $InputArgs 'progid') { [string]$InputArgs.progid } else { Fail 'INVALID_ARGS' 'com_automation requires progid.' }
  $connect = if (Has-Arg $InputArgs 'connect') { ([string]$InputArgs.connect).Trim().ToLowerInvariant() } else { Fail 'INVALID_ARGS' 'com_automation requires explicit connect: active or create.' }
  $alias = if (Has-Arg $InputArgs 'alias' -and ![string]::IsNullOrWhiteSpace([string]$InputArgs.alias)) { [string]$InputArgs.alias } else { $progId }
  if ($script:COM_AUTOMATION_OBJECTS.ContainsKey($alias)) {
    return [pscustomobject]@{ alias = $alias; progid = $progId; instance = $script:COM_AUTOMATION_OBJECTS[$alias] }
  }
  try {
    $instance = switch ($connect) {
      'active' { [Runtime.InteropServices.Marshal]::GetActiveObject($progId) }
      'create' { New-Object -ComObject $progId }
      default { Fail 'INVALID_ARGS' 'com_automation connect must be active or create.' }
    }
    $script:COM_AUTOMATION_OBJECTS[$alias] = $instance
    return [pscustomobject]@{ alias = $alias; progid = $progId; instance = $instance }
  } catch {
    Fail 'COM_AUTOMATION_FAILED' "Could not connect to COM Automation object '$progId' with connect='$connect': $($_.Exception.Message)"
  }
}

function Resolve-Com-Target {
  param($Root, $InputArgs)
  $target = $Root
  if (Has-Arg $InputArgs 'target_path' -and $null -ne $InputArgs.target_path) {
    foreach ($member in @($InputArgs.target_path)) {
      $target = Invoke-Com-Member $target ([string]$member) 'get' @()
    }
  }
  return $target
}

function Get-Com-Members {
  param($Target, [int]$Limit = 160)
  $limitValue = [Math]::Max(1, [Math]::Min(500, $Limit))
  $members = @($Target | Get-Member -MemberType Method,Property -ErrorAction Stop | Select-Object -First $limitValue)
  return @($members | ForEach-Object {
    [ordered]@{
      name = $_.Name
      member_type = [string]$_.MemberType
      definition = [string]$_.Definition
    }
  })
}

function Invoke-Com-Automation {
  param($InputArgs)
  $action = if (Has-Arg $InputArgs 'action') { ([string]$InputArgs.action).Trim().ToLowerInvariant() } else { Fail 'INVALID_ARGS' 'com_automation requires action.' }
  $progId = if (Has-Arg $InputArgs 'progid') { [string]$InputArgs.progid } else { Fail 'INVALID_ARGS' 'com_automation requires progid.' }
  $alias = if (Has-Arg $InputArgs 'alias' -and ![string]::IsNullOrWhiteSpace([string]$InputArgs.alias)) { [string]$InputArgs.alias } else { $progId }

  if ($action -eq 'release') {
    if ($script:COM_AUTOMATION_OBJECTS.ContainsKey($alias)) {
      try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:COM_AUTOMATION_OBJECTS[$alias]) } catch {}
      $script:COM_AUTOMATION_OBJECTS.Remove($alias)
    }
    return [ordered]@{ action = 'release'; progid = $progId; alias = $alias; released = $true }
  }

  $resolved = Resolve-Com-Automation-Object $InputArgs
  $target = Resolve-Com-Target $resolved.instance $InputArgs
  $limit = if (Has-Arg $InputArgs 'limit') { [int]$InputArgs.limit } else { 160 }
  switch ($action) {
    'members' {
      return [ordered]@{
        action = 'members'
        progid = $resolved.progid
        alias = $resolved.alias
        target_type = $target.GetType().FullName
        members = @(Get-Com-Members $target $limit)
      }
    }
    'get' {
      $member = if (Has-Arg $InputArgs 'member') { [string]$InputArgs.member } else { Fail 'INVALID_ARGS' 'com_automation get requires member.' }
      $value = Invoke-Com-Member $target $member 'get' @()
      return [ordered]@{ action = 'get'; progid = $resolved.progid; alias = $resolved.alias; member = $member; value = Convert-Com-Value $value 0 $limit }
    }
    'set' {
      $member = if (Has-Arg $InputArgs 'member') { [string]$InputArgs.member } else { Fail 'INVALID_ARGS' 'com_automation set requires member.' }
      if (!(Has-Arg $InputArgs 'value')) { Fail 'INVALID_ARGS' 'com_automation set requires value.' }
      [void](Invoke-Com-Member $target $member 'set' @($InputArgs.value))
      return [ordered]@{ action = 'set'; progid = $resolved.progid; alias = $resolved.alias; member = $member; value = Convert-Com-Value $InputArgs.value 0 $limit }
    }
    'invoke' {
      $member = if (Has-Arg $InputArgs 'member') { [string]$InputArgs.member } else { Fail 'INVALID_ARGS' 'com_automation invoke requires member.' }
      $callArgs = if (Has-Arg $InputArgs 'arguments' -and $null -ne $InputArgs.arguments) { [object[]]@($InputArgs.arguments) } else { @() }
      $value = Invoke-Com-Member $target $member 'invoke' $callArgs
      return [ordered]@{ action = 'invoke'; progid = $resolved.progid; alias = $resolved.alias; member = $member; value = Convert-Com-Value $value 0 $limit }
    }
    default {
      Fail 'INVALID_ARGS' 'com_automation action must be members, get, set, invoke, or release.'
    }
  }
}

function Post-Window-Message {
  param([IntPtr]$Hwnd, [int]$Message, [IntPtr]$WParam, [IntPtr]$LParam)
  if ($Hwnd -eq [IntPtr]::Zero) {
    Fail 'INVALID_HWND' 'No native HWND is available for this Windows action.'
  }
  [InterpreterWin32Uia]::PostWindowMessage($Hwnd, $Message, $WParam.ToInt32(), $LParam.ToInt32())
}

function Ensure-No-Focus-Uia-Helper {
  if ('InterpreterWindowsUiaNoFocus.AutomationNoFocus' -as [type]) {
    return
  }
  if (!(Test-Path -LiteralPath $NO_FOCUS_UIA_HELPER_DLL)) {
    $compilePath = "$NO_FOCUS_UIA_HELPER_DLL.$PID.tmp.dll"
    if (Test-Path -LiteralPath $compilePath) {
      Remove-Item -LiteralPath $compilePath -Force
    }
    Add-Type -TypeDefinition $NO_FOCUS_UIA_HELPER_SOURCE -Language CSharp -OutputAssembly $compilePath
    Move-Item -LiteralPath $compilePath -Destination $NO_FOCUS_UIA_HELPER_DLL -Force
  }
  Add-Type -Path $NO_FOCUS_UIA_HELPER_DLL
}

function Child-Windows {
  param([IntPtr]$Hwnd)
  $items = New-Object System.Collections.ArrayList
  $callback = [InterpreterWin32Uia+EnumWindowsProc]{
    param([IntPtr]$childHwnd, [IntPtr]$lParam)
    $ownerPid = [uint32]0
    [void][InterpreterWin32Uia]::GetWindowThreadProcessId($childHwnd, [ref]$ownerPid)
    [void]$items.Add([pscustomobject]@{
      hwnd = $childHwnd.ToInt64()
      pid = [int]$ownerPid
      class_name = [InterpreterWin32Uia]::ReadClassName($childHwnd)
      visible = [InterpreterWin32Uia]::IsWindowVisible($childHwnd)
    })
    return $true
  }
  [void][InterpreterWin32Uia]::EnumChildWindows($Hwnd, $callback, [IntPtr]::Zero)
  return @($items.ToArray())
}

function Resolve-Keyboard-Hwnd {
  param($Target)
  $hwnd = $Target.hwnd
  if ($hwnd -eq [IntPtr]::Zero) {
    return $hwnd
  }
  $children = @(Child-Windows $hwnd)
  $coreWindow = $children | Where-Object { $_.visible -and $_.class_name -eq 'Windows.UI.Core.CoreWindow' } | Select-Object -First 1
  if ($coreWindow) {
    return [IntPtr]([int64]$coreWindow.hwnd)
  }
  $visibleChild = $children | Where-Object { $_.visible } | Select-Object -First 1
  if ($visibleChild) {
    return [IntPtr]([int64]$visibleChild.hwnd)
  }
  return $hwnd
}

function Resolve-Native-Descendant-Hwnd {
  param([System.Windows.Automation.AutomationElement]$Element)
  if ($null -eq $Element) {
    return [IntPtr]::Zero
  }
  $descendants = $Element.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($child in $descendants) {
    $handle = [IntPtr][int]$child.Current.NativeWindowHandle
    if (
      $handle -ne [IntPtr]::Zero -and
      $child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit
    ) {
      return $handle
    }
  }
  foreach ($child in $descendants) {
    $handle = [IntPtr][int]$child.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
      return $handle
    }
  }
  return [IntPtr]::Zero
}

function Window-Id {
  param([int]$Handle)
  return ('hwnd-{0:x}' -f $Handle)
}

function Pattern-Or-Null {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [System.Windows.Automation.AutomationPattern]$Pattern
  )
  try {
    return $Element.GetCurrentPattern($Pattern)
  } catch {
    return $null
  }
}

function Pattern-Available {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [System.Windows.Automation.AutomationProperty]$Property
  )
  try {
    return [bool]$Element.GetCurrentPropertyValue($Property)
  } catch {
    return $false
  }
}

function Protected-Interpreter-Pids {
  $ids = New-Object System.Collections.Generic.List[int]
  if ($PID -gt 0) {
    [void]$ids.Add([int]$PID)
  }
  try {
    if (Test-Path -LiteralPath $DRIVER_STATE_PATH) {
      $state = Read-Text-Shared $DRIVER_STATE_PATH | ConvertFrom-Json
      if ($null -ne $state.agent_cursor -and $null -ne $state.agent_cursor.overlay_pid) {
        $overlayPid = 0
        if ([int]::TryParse([string]$state.agent_cursor.overlay_pid, [ref]$overlayPid) -and $overlayPid -gt 0) {
          [void]$ids.Add($overlayPid)
        }
      }
    }
  } catch {}

  $raw = [string]$env:INTERPRETER_COMPUTER_USE_PROTECTED_PIDS
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @($ids.ToArray() | Select-Object -Unique)
  }
  foreach ($part in $raw.Split(',')) {
    $trimmed = $part.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
    $value = 0
    if ([int]::TryParse($trimmed, [ref]$value) -and $value -gt 0) {
      [void]$ids.Add($value)
    }
  }
  return @($ids.ToArray() | Select-Object -Unique)
}

function Is-Protected-Interpreter-Pid {
  param([int]$ProcessId)
  return @((Protected-Interpreter-Pids)) -contains $ProcessId
}

function Assert-Not-Protected-Interpreter-Window {
  param($Window)
  if ($null -ne $Window -and (Is-Protected-Interpreter-Pid ([int]$Window.pid))) {
    Fail 'TARGET_BLOCKED' 'Interpreter cannot use Computer Use to inspect or control its own app windows.'
  }
}

function Top-Level-Windows {
  param([switch]$IncludeProtected)
  $foregroundHwnd = [InterpreterWin32Uia]::GetForegroundWindow()
  $foregroundRoot = if ($foregroundHwnd -ne [IntPtr]::Zero) {
    [InterpreterWin32Uia]::GetAncestor($foregroundHwnd, [InterpreterWin32Uia]::GA_ROOT)
  } else {
    [IntPtr]::Zero
  }
  if ($foregroundRoot -eq [IntPtr]::Zero) {
    $foregroundRoot = $foregroundHwnd
  }
  $windows = @()
  foreach ($info in [InterpreterWin32Uia]::GetTopLevelWindowInfos()) {
    $handlePtr = [IntPtr]$info.Hwnd
    $handle = [int]$handlePtr
    if ($handle -eq 0) { continue }
    $title = [string]$info.Title
    if ([string]::IsNullOrWhiteSpace($title)) { continue }
    $processId = [int]$info.ProcessId
    $isProtectedInterpreter = Is-Protected-Interpreter-Pid $processId
    if (!$IncludeProtected -and $isProtectedInterpreter) { continue }
    $appName = ''
    try {
      $appName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
    } catch {
      $appName = "pid-$processId"
    }
    $rect = $info.Rect
    $windows += [ordered]@{
      app_name = $appName
      bounds = [ordered]@{
        x = [int]$rect.Left
        y = [int]$rect.Top
        width = [int]($rect.Right - $rect.Left)
        height = [int]($rect.Bottom - $rect.Top)
      }
      is_focused = ($handlePtr -eq $foregroundHwnd -or $handlePtr -eq $foregroundRoot)
      pid = $processId
      title = $title
      window_id = Window-Id $handle
      _element = $null
      _handle = $handle
      _protected_interpreter = $isProtectedInterpreter
    }
  }
  return $windows
}

function Window-From-TopLevelInfo {
  param($Info)
  if ($null -eq $Info) {
    return $null
  }
  $handlePtr = [IntPtr]$Info.Hwnd
  $handle = [int]$handlePtr
  if ($handle -eq 0) {
    return $null
  }
  $processId = [int]$Info.ProcessId
  $appName = ''
  try {
    $appName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
  } catch {
    $appName = "pid-$processId"
  }
  $rect = $Info.Rect
  $foregroundHwnd = [InterpreterWin32Uia]::GetForegroundWindow()
  $foregroundRoot = if ($foregroundHwnd -ne [IntPtr]::Zero) {
    [InterpreterWin32Uia]::GetAncestor($foregroundHwnd, [InterpreterWin32Uia]::GA_ROOT)
  } else {
    [IntPtr]::Zero
  }
  if ($foregroundRoot -eq [IntPtr]::Zero) {
    $foregroundRoot = $foregroundHwnd
  }
  return [ordered]@{
    app_name = $appName
    bounds = [ordered]@{
      x = [int]$rect.Left
      y = [int]$rect.Top
      width = [int]($rect.Right - $rect.Left)
      height = [int]($rect.Bottom - $rect.Top)
    }
    is_focused = ($handlePtr -eq $foregroundHwnd -or $handlePtr -eq $foregroundRoot)
    pid = $processId
    title = [string]$Info.Title
    window_id = Window-Id $handle
    _element = $null
    _handle = $handle
    _protected_interpreter = (Is-Protected-Interpreter-Pid $processId)
  }
}

function Window-At-Point {
  param([int]$X, [int]$Y)
  $info = [InterpreterWin32Uia]::GetTopLevelWindowInfoAtPoint($X, $Y)
  $window = Window-From-TopLevelInfo $info
  if ($null -eq $window) {
    Fail 'WINDOW_NOT_FOUND' "No top-level window found at point $X,$Y."
  }
  Assert-Not-Protected-Interpreter-Window $window
  return $window
}

function Window-For-Pid {
  param($InputArgs)
  if (!(Has-Arg $InputArgs 'pid')) {
    Fail 'INVALID_ARGS' 'pid is required.'
  }
  $targetPid = [int]$InputArgs.pid
  $scope = $null
  if ((Has-Arg $InputArgs 'scope_x') -and (Has-Arg $InputArgs 'scope_y') -and (Has-Arg $InputArgs 'scope_width') -and (Has-Arg $InputArgs 'scope_height')) {
    $scope = [ordered]@{
      x = [double]$InputArgs.scope_x
      y = [double]$InputArgs.scope_y
      width = [double]$InputArgs.scope_width
      height = [double]$InputArgs.scope_height
    }
  }

  $bestInfo = $null
  $bestArea = -1
  foreach ($info in [InterpreterWin32Uia]::GetTopLevelWindowInfos()) {
    if ([int]$info.ProcessId -ne $targetPid) { continue }
    $handlePtr = [IntPtr]$info.Hwnd
    if ([int]$handlePtr -eq 0) { continue }
    if ([string]::IsNullOrWhiteSpace([string]$info.Title)) { continue }
    $rect = $info.Rect
    $bounds = [ordered]@{
      x = [double]$rect.Left
      y = [double]$rect.Top
      width = [double]($rect.Right - $rect.Left)
      height = [double]($rect.Bottom - $rect.Top)
    }
    $area = if ($null -eq $scope) { [double]($bounds.width * $bounds.height) } else { Rect-Intersection-Area $bounds $scope }
    if ($area -le 0) { continue }
    if ($area -gt $bestArea) {
      $bestArea = $area
      $bestInfo = $info
    }
  }
  $window = Window-From-TopLevelInfo $bestInfo
  if ($null -eq $window) {
    Fail 'WINDOW_NOT_FOUND' "No top-level window found for pid $targetPid."
  }
  $window['_scope'] = $scope
  Assert-Not-Protected-Interpreter-Window $window
  return $window
}

function Ensure-Window-Element {
  param($Window)
  if ($null -ne $Window._element) {
    return $Window._element
  }
  $handle = [IntPtr][int]$Window._handle
  $element = $null
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window
    )
    $handleCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty,
      [int]$Window._handle
    )
    $condition = New-Object System.Windows.Automation.AndCondition($windowCondition, $handleCondition)
    $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
  } catch {
    $element = $null
  }
  try {
    if ($null -eq $element) {
      $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    }
  } catch {
    $element = $null
  }
  if ($null -eq $element) {
    Fail 'WINDOW_NOT_ACCESSIBLE' "Window '$($Window.title)' did not expose a UI Automation root element."
  }
  $Window['_element'] = $element
  return $element
}

function Public-Window {
  param($Window)
  return [ordered]@{
    app_name = $Window.app_name
    bounds = $Window.bounds
    is_focused = $Window.is_focused
    pid = $Window.pid
    title = $Window.title
    window_id = $Window.window_id
  }
}

function Window-Is-Foreground {
  param([IntPtr]$Hwnd)
  $foregroundHwnd = [InterpreterWin32Uia]::GetForegroundWindow()
  if ($foregroundHwnd -eq [IntPtr]::Zero) { return $false }
  $foregroundRoot = [InterpreterWin32Uia]::GetAncestor($foregroundHwnd, [InterpreterWin32Uia]::GA_ROOT)
  if ($foregroundRoot -eq [IntPtr]::Zero) { $foregroundRoot = $foregroundHwnd }
  return ($Hwnd -eq $foregroundHwnd -or $Hwnd -eq $foregroundRoot)
}

function Bring-Window-To-Foreground {
  param([IntPtr]$Hwnd)
  if ($Hwnd -eq [IntPtr]::Zero -or ![InterpreterWin32Uia]::IsWindow($Hwnd)) {
    Fail 'INVALID_TARGET' 'Cannot foreground an invalid window handle.'
  }
  $wasForeground = Window-Is-Foreground $Hwnd
  if (!$wasForeground) {
    $targetPid = [uint32]0
    $foregroundPid = [uint32]0
    $currentThread = [InterpreterWin32Uia]::GetCurrentThreadId()
    $targetThread = [InterpreterWin32Uia]::GetWindowThreadProcessId($Hwnd, [ref]$targetPid)
    $foregroundHwnd = [InterpreterWin32Uia]::GetForegroundWindow()
    $foregroundThread = if ($foregroundHwnd -ne [IntPtr]::Zero) {
      [InterpreterWin32Uia]::GetWindowThreadProcessId($foregroundHwnd, [ref]$foregroundPid)
    } else {
      0
    }
    $attachedTarget = $false
    $attachedForeground = $false
    try {
      if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
        $attachedTarget = [InterpreterWin32Uia]::AttachThreadInput($currentThread, $targetThread, $true)
      }
      if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread -and $foregroundThread -ne $targetThread) {
        $attachedForeground = [InterpreterWin32Uia]::AttachThreadInput($currentThread, $foregroundThread, $true)
      }
      [void][InterpreterWin32Uia]::ShowWindowAsync($Hwnd, [InterpreterWin32Uia]::SW_RESTORE)
      [void][InterpreterWin32Uia]::BringWindowToTop($Hwnd)
      [void][InterpreterWin32Uia]::SetForegroundWindow($Hwnd)
    } finally {
      if ($attachedForeground) {
        [void][InterpreterWin32Uia]::AttachThreadInput($currentThread, $foregroundThread, $false)
      }
      if ($attachedTarget) {
        [void][InterpreterWin32Uia]::AttachThreadInput($currentThread, $targetThread, $false)
      }
    }
    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 1200
    while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
      if (Window-Is-Foreground $Hwnd) {
        return [ordered]@{ was_foreground = $false; is_foreground = $true }
      }
      Start-Sleep -Milliseconds 40
    }
    Fail 'FOREGROUND_FAILED' 'Windows did not allow Interpreter to bring the target app to the foreground. The click was not sent.'
  }
  return [ordered]@{ was_foreground = $true; is_foreground = $true }
}

function Com-Candidate-Queries-For-Window {
  param($Window)
  $queries = New-Object System.Collections.Generic.List[string]
  if ($Window.app_name) { [void]$queries.Add([string]$Window.app_name) }
  try {
    $process = Get-Process -Id ([int]$Window.pid) -ErrorAction Stop
    if ($process.ProcessName) { [void]$queries.Add([string]$process.ProcessName) }
    if ($process.Path) {
      $fileName = [System.IO.Path]::GetFileNameWithoutExtension([string]$process.Path)
      if ($fileName) { [void]$queries.Add($fileName) }
    }
  } catch {}
  return @($queries.ToArray() | Where-Object { ![string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function Registered-Com-Automation-Objects {
  param([string]$Query = '', [int]$Limit = 120)
  $limitValue = [Math]::Max(1, [Math]::Min(1000, $Limit))
  $queryText = if ($null -ne $Query) { $Query.Trim() } else { '' }
  $results = New-Object System.Collections.Generic.List[object]
  $root = 'Registry::HKEY_CLASSES_ROOT\CLSID'
  foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
    if ($results.Count -ge $limitValue) { break }
    try {
      $clsid = Split-Path -Leaf $key.Name
      $description = [string]$key.GetValue('')
      $progIdKey = Get-Item -LiteralPath (Join-Path $key.PSPath 'ProgID') -ErrorAction SilentlyContinue
      $versionIndependentProgIdKey = Get-Item -LiteralPath (Join-Path $key.PSPath 'VersionIndependentProgID') -ErrorAction SilentlyContinue
      $progId = if ($progIdKey) { [string]$progIdKey.GetValue('') } else { '' }
      $versionIndependentProgId = if ($versionIndependentProgIdKey) { [string]$versionIndependentProgIdKey.GetValue('') } else { '' }
      if ([string]::IsNullOrWhiteSpace($progId) -and [string]::IsNullOrWhiteSpace($versionIndependentProgId)) { continue }
      $serverKey = Get-Item -LiteralPath (Join-Path $key.PSPath 'LocalServer32') -ErrorAction SilentlyContinue
      $inprocKey = Get-Item -LiteralPath (Join-Path $key.PSPath 'InprocServer32') -ErrorAction SilentlyContinue
      $typeLibKey = Get-Item -LiteralPath (Join-Path $key.PSPath 'TypeLib') -ErrorAction SilentlyContinue
      $programmableKey = Get-Item -LiteralPath (Join-Path $key.PSPath 'Programmable') -ErrorAction SilentlyContinue
      $server = if ($serverKey) { [string]$serverKey.GetValue('') } elseif ($inprocKey) { [string]$inprocKey.GetValue('') } else { '' }
      $typeLib = if ($typeLibKey) { [string]$typeLibKey.GetValue('') } else { '' }
      $haystack = (@($clsid, $description, $progId, $versionIndependentProgId, $server, $typeLib) -join ' ')
      if (![string]::IsNullOrWhiteSpace($queryText) -and $haystack.IndexOf($queryText, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        continue
      }
      $results.Add([ordered]@{
        progid = if (![string]::IsNullOrWhiteSpace($progId)) { $progId } else { $versionIndependentProgId }
        version_independent_progid = if (![string]::IsNullOrWhiteSpace($versionIndependentProgId)) { $versionIndependentProgId } else { $null }
        clsid = $clsid
        description = if (![string]::IsNullOrWhiteSpace($description)) { $description } else { $null }
        server = if (![string]::IsNullOrWhiteSpace($server)) { $server } else { $null }
        typelib = if (![string]::IsNullOrWhiteSpace($typeLib)) { $typeLib } else { $null }
        programmable = ($null -ne $programmableKey)
      }) | Out-Null
    } catch {}
  }
  return @($results.ToArray())
}

function Com-Candidates-For-Window {
  param($Window)
  $candidates = @()
  foreach ($query in Com-Candidate-Queries-For-Window $Window) {
    $candidates += @(Registered-Com-Automation-Objects -Query $query -Limit 8)
  }
  return @($candidates | Sort-Object -Property progid -Unique | Select-Object -First 8)
}

function Window-Automation-Capabilities {
  param($Window, [bool]$IncludeComCandidates = $false)
  $candidateQueries = @(Com-Candidate-Queries-For-Window $Window)
  return [ordered]@{
    uia = [ordered]@{
      available = $true
      inspect_tool = 'get_window_state'
      primary_selectors = @('automation_id', 'element_index')
    }
    hwnd_messages = [ordered]@{
      available = $true
      background_safe_tools = @('click', 'right_click', 'press_key', 'hotkey', 'type_text_chars', 'set_value')
    }
    foreground_input = [ordered]@{
      available = $true
      tool = 'click'
      argument = 'bring_to_foreground'
      permission = 'Prompts only when the target window is not already foreground.'
    }
    com = [ordered]@{
      available = $true
      discovery_tool = 'list_com_objects'
      action_tool = 'com_automation'
      candidate_queries = $candidateQueries
      candidates = if ($IncludeComCandidates) { @(Com-Candidates-For-Window $Window) } else { @() }
    }
  }
}

function Public-Automation-Target {
  param($Window)
  $public = Public-Window $Window
  $public.automation_channels = Window-Automation-Capabilities $Window $false
  return $public
}

function Resolve-Window {
  param($InputArgs)
  $windows = Top-Level-Windows -IncludeProtected
  if ($InputArgs.window_id) {
    $match = $windows | Where-Object { $_.window_id -eq [string]$InputArgs.window_id } | Select-Object -First 1
    if ($match) {
      Assert-Not-Protected-Interpreter-Window $match
      return $match
    }
    Fail 'WINDOW_NOT_FOUND' "No window matched window_id '$($InputArgs.window_id)'."
  }
  if ($InputArgs.pid) {
    $matches = @($windows | Where-Object { $_.pid -eq [int]$InputArgs.pid })
    if ($matches.Count -gt 0) {
      Assert-Not-Protected-Interpreter-Window $matches[0]
      return $matches[0]
    }
    Fail 'WINDOW_NOT_FOUND' "No top-level window matched pid '$($InputArgs.pid)'."
  }
  if ($InputArgs.title) {
    $matches = @($windows | Where-Object { $_.title -like "*$($InputArgs.title)*" })
    if ($matches.Count -gt 0) {
      Assert-Not-Protected-Interpreter-Window $matches[0]
      return $matches[0]
    }
    Fail 'WINDOW_NOT_FOUND' "No top-level window matched title '$($InputArgs.title)'."
  }
  Fail 'WINDOW_NOT_FOUND' 'Expected window_id, pid, or title.'
}

function Require-Finite-Number {
  param($InputArgs, [string]$Name)
  if (!(Has-Arg $InputArgs $Name)) {
    Fail 'INVALID_ARGS' "$Name is required."
  }
  $value = [double]$InputArgs.$Name
  if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) {
    Fail 'INVALID_ARGS' "$Name must be a finite number."
  }
  return [int][Math]::Round($value)
}

function Set-Window-Bounds {
  param($InputArgs)
  $window = Resolve-Window $InputArgs
  $x = Require-Finite-Number $InputArgs 'x'
  $y = Require-Finite-Number $InputArgs 'y'
  $width = Require-Finite-Number $InputArgs 'width'
  $height = Require-Finite-Number $InputArgs 'height'
  if ($width -le 0 -or $height -le 0) {
    Fail 'INVALID_ARGS' 'width and height must be positive.'
  }

  $handle = [IntPtr][int]$window._handle
  $flags = [InterpreterWin32Uia]::SWP_NOACTIVATE -bor [InterpreterWin32Uia]::SWP_NOOWNERZORDER -bor [InterpreterWin32Uia]::SWP_SHOWWINDOW
  $ok = [InterpreterWin32Uia]::SetWindowPos(
    $handle,
    [InterpreterWin32Uia]::HWND_TOP,
    $x,
    $y,
    $width,
    $height,
    $flags
  )
  if (!$ok) {
    Fail 'WINDOW_MOVE_FAILED' 'SetWindowPos failed.'
  }

  Start-Sleep -Milliseconds 80
  $updated = Resolve-Window ([pscustomobject]@{ window_id = $window.window_id })
  return [ordered]@{
    action = 'set_window_bounds'
    pid = $updated.pid
    window_id = $updated.window_id
    title = $updated.title
    bounds = $updated.bounds
  }
}

function Focus-Window {
  param($InputArgs)
  $window = Resolve-Window $InputArgs
  $handle = [IntPtr][int]$window._handle
  [InterpreterWin32Uia]::ShowWindowAsync($handle, [InterpreterWin32Uia]::SW_RESTORE) | Out-Null
  [InterpreterWin32Uia]::BringWindowToTop($handle) | Out-Null
  $ok = [InterpreterWin32Uia]::SetForegroundWindow($handle)
  if (!$ok) {
    Fail 'WINDOW_FOCUS_FAILED' 'SetForegroundWindow failed.'
  }

  Start-Sleep -Milliseconds 80
  $updated = Resolve-Window ([pscustomobject]@{ window_id = $window.window_id })
  return [ordered]@{
    action = 'focus_window'
    pid = $updated.pid
    window_id = $updated.window_id
    title = $updated.title
    is_focused = $updated.is_focused
    bounds = $updated.bounds
  }
}

function Close-Window {
  param($InputArgs)
  $window = Resolve-Window $InputArgs
  $handle = [IntPtr][int]$window._handle
  $WM_CLOSE = 0x0010
  $posted = [InterpreterWin32Uia]::PostMessage($handle, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
  if (!$posted) {
    Fail 'WINDOW_CLOSE_FAILED' 'PostMessage(WM_CLOSE) failed.'
  }

  $deadline = (Get-Date).AddMilliseconds(1500)
  while ((Get-Date) -lt $deadline) {
    $remaining = @(Top-Level-Windows -IncludeProtected | Where-Object { $_.window_id -eq [string]$window.window_id })
    if ($remaining.Count -eq 0) {
      return [ordered]@{
        action = 'close_window'
        pid = $window.pid
        window_id = $window.window_id
        title = $window.title
        closed = $true
      }
    }
    Start-Sleep -Milliseconds 50
  }
  Fail 'WINDOW_STILL_PRESENT' "Window '$($window.window_id)' is still present after close request."
}

function Element-Toggle-Pattern-Or-Null {
  param([System.Windows.Automation.AutomationElement]$Element)
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty)) {
    return Pattern-Or-Null $Element ([System.Windows.Automation.TogglePattern]::Pattern)
  }
  return $null
}

function Element-Selection-Item-Pattern-Or-Null {
  param([System.Windows.Automation.AutomationElement]$Element)
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)) {
    return Pattern-Or-Null $Element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  }
  return $null
}

function Element-Scroll-Pattern-Or-Null {
  param([System.Windows.Automation.AutomationElement]$Element)
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty)) {
    return Pattern-Or-Null $Element ([System.Windows.Automation.ScrollPattern]::Pattern)
  }
  return $null
}

function Element-Invoke-Pattern-Or-Null {
  param([System.Windows.Automation.AutomationElement]$Element)
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)) {
    return Pattern-Or-Null $Element ([System.Windows.Automation.InvokePattern]::Pattern)
  }
  return $null
}

function Element-Value-Pattern-Or-Null {
  param([System.Windows.Automation.AutomationElement]$Element)
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty)) {
    return Pattern-Or-Null $Element ([System.Windows.Automation.ValuePattern]::Pattern)
  }
  return $null
}

function Element-Expand-Collapse-Pattern-Available {
  param([System.Windows.Automation.AutomationElement]$Element)
  return Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty)
}

function Element-Expand-Collapse-Pattern-Or-Null {
  param([System.Windows.Automation.AutomationElement]$Element)
  if (Element-Expand-Collapse-Pattern-Available $Element) {
    return Pattern-Or-Null $Element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  }
  return $null
}

function Element-Has-Interactive-Pattern {
  param([System.Windows.Automation.AutomationElement]$Element)
  return (
    (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)) -or
    (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty)) -or
    (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty)) -or
    (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)) -or
    (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty)) -or
    (Element-Expand-Collapse-Pattern-Available $Element)
  )
}

function New-Interactive-Element-Condition {
  $conditions = @(
    (New-Object System.Windows.Automation.PropertyCondition(
      ([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty),
      $true
    )),
    (New-Object System.Windows.Automation.PropertyCondition(
      ([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty),
      $true
    )),
    (New-Object System.Windows.Automation.PropertyCondition(
      ([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty),
      $true
    )),
    (New-Object System.Windows.Automation.PropertyCondition(
      ([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty),
      $true
    )),
    (New-Object System.Windows.Automation.PropertyCondition(
      ([System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty),
      $true
    )),
    (New-Object System.Windows.Automation.PropertyCondition(
      ([System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty),
      $true
    ))
  )
  return New-Object System.Windows.Automation.OrCondition -ArgumentList (,[System.Windows.Automation.Condition[]]$conditions)
}

function Element-Is-Text-Entry-Control {
  param([System.Windows.Automation.AutomationElement]$Element)
  $controlType = $Element.Current.ControlType
  return (
    $controlType -eq [System.Windows.Automation.ControlType]::Edit -or
    $controlType -eq [System.Windows.Automation.ControlType]::ComboBox -or
    $controlType -eq [System.Windows.Automation.ControlType]::Document
  )
}

function Element-Is-Native-Button-Family-Control {
  param([System.Windows.Automation.AutomationElement]$Element)
  $controlType = $Element.Current.ControlType
  return (
    $controlType -eq [System.Windows.Automation.ControlType]::Button -or
    $controlType -eq [System.Windows.Automation.ControlType]::CheckBox -or
    $controlType -eq [System.Windows.Automation.ControlType]::RadioButton
  )
}

function Element-Supported-Actions {
  param([System.Windows.Automation.AutomationElement]$Element)
  $automationId = [string]$Element.Current.AutomationId
  $handle = [IntPtr][int]$Element.Current.NativeWindowHandle
  $hasAutomationId = ![string]::IsNullOrWhiteSpace($automationId)
  $isTextEntryControl = Element-Is-Text-Entry-Control $Element
  $actions = New-Object System.Collections.Generic.List[object]

  function Add-Action {
    param([string]$Tool, [string]$Mode, [bool]$NoFocus, [string]$Selector, [string]$Note = '')
    $entry = [ordered]@{
      tool = $Tool
      mode = $Mode
      no_focus = $NoFocus
      selector = $Selector
    }
    if ($Note) { $entry.note = $Note }
    [void]$actions.Add($entry)
  }

  $preferredSelector = if ($hasAutomationId) { 'automation_id' } else { 'element_index' }
  if ($handle -eq [IntPtr]::Zero) {
    Add-Action 'click' 'wm_child_left_click' $true $preferredSelector 'Interpreter sends targeted window messages to the child/input HWND under the element; apps that ignore background mouse messages may reject the action without stealing focus.'
  }
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)) {
    Add-Action 'click' 'uia_invoke_may_focus' $false $preferredSelector 'Managed UIA Invoke may foreground the target app and is not used for default background-safe clicks.'
  }
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty)) {
    Add-Action 'click' 'uia_toggle' $false $preferredSelector 'TogglePattern is exposed; the current backend may use HWND messages or managed UIA depending on the element.'
  }
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)) {
    Add-Action 'click' 'uia_select' $false $preferredSelector 'SelectionItemPattern is exposed; the current backend may use HWND messages or managed UIA depending on the element.'
  }
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty)) {
    Add-Action 'set_value' $(if ($handle -ne [IntPtr]::Zero) { 'wm_settext' } else { 'uia_value' }) ($handle -ne [IntPtr]::Zero) $preferredSelector
    if ($isTextEntryControl) {
      Add-Action 'type_text' $(if ($handle -ne [IntPtr]::Zero) { 'wm_settext' } else { 'uia_value' }) ($handle -ne [IntPtr]::Zero) $preferredSelector
      Add-Action 'type_text_chars' $(if ($handle -ne [IntPtr]::Zero) { 'wm_append_settext' } else { 'uia_append_value' }) ($handle -ne [IntPtr]::Zero) $preferredSelector
    }
  }
  if (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty)) {
    Add-Action 'scroll' 'uia_scroll' $false $preferredSelector
  }
  if ($handle -ne [IntPtr]::Zero) {
    $nativeClickMode = if (Element-Is-Native-Button-Family-Control $Element) { 'wm_button_click' } else { 'wm_left_click' }
    Add-Action 'click' $nativeClickMode $true $preferredSelector 'Native HWND controls use targeted window messages to avoid foregrounding.'
    Add-Action 'right_click' 'wm_right_click' $true $preferredSelector
    Add-Action 'press_key' 'wm_key' $true $preferredSelector
    Add-Action 'hotkey' 'wm_hotkey' $true $preferredSelector
    if ($isTextEntryControl) {
      Add-Action 'type_text_chars' 'wm_char' $true $preferredSelector
    }
  }
  return @($actions.ToArray())
}

function Element-Value {
  param([System.Windows.Automation.AutomationElement]$Element)
  if ($Element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
    $handle = [IntPtr][int]$Element.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
      try { return [InterpreterWin32Uia]::ReadWindowText($handle) } catch {}
    }
  }
  $valuePattern = Element-Value-Pattern-Or-Null $Element
  if ($valuePattern) {
    try { return [string]$valuePattern.Current.Value } catch {}
  }
  return $null
}

function Element-States {
  param([System.Windows.Automation.AutomationElement]$Element)
  $states = New-Object System.Collections.Generic.List[string]
  if ($Element.Current.IsEnabled) { $states.Add('enabled') } else { $states.Add('disabled') }
  if ($Element.Current.HasKeyboardFocus) { $states.Add('focused') }
  if ($Element.Current.IsOffscreen) { $states.Add('offscreen') } else { $states.Add('visible') }
  $toggle = Element-Toggle-Pattern-Or-Null $Element
  if ($toggle) {
    $state = $toggle.Current.ToggleState.ToString().ToLowerInvariant()
    if ($state -eq 'on') { $states.Add('checked') }
    elseif ($state -eq 'off') { $states.Add('unchecked') }
    else { $states.Add($state) }
  }
  $selection = Element-Selection-Item-Pattern-Or-Null $Element
  if ($selection -and $selection.Current.IsSelected) { $states.Add('selected') }
  return @($states)
}

function Is-Interactive {
  param([System.Windows.Automation.AutomationElement]$Element)
  if ([int]$Element.Current.NativeWindowHandle -ne 0) { return $true }
  return Element-Has-Interactive-Pattern $Element
}

function Element-Summary {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [int]$Index,
    [string]$Path
  )
  $role = Control-Type-Name $Element.Current.ControlType
  $name = [string]$Element.Current.Name
  $automationId = [string]$Element.Current.AutomationId
  $handle = [IntPtr][int]$Element.Current.NativeWindowHandle
  $value = Element-Value $Element
  return [ordered]@{
    element_index = $Index
    native_handle = if ($handle -eq [IntPtr]::Zero) { $null } else { [int]$handle }
    role = $role
    name = if ([string]::IsNullOrEmpty($name)) { $null } else { $name }
    automation_id = if ([string]::IsNullOrEmpty($automationId)) { $null } else { $automationId }
    preferred_selector = if (![string]::IsNullOrEmpty($automationId)) { 'automation_id' } else { 'element_index' }
    value = if ($null -eq $value -or [string]::IsNullOrEmpty($value)) { $null } else { $value }
    bounds = Rect-Object $Element.Current.BoundingRectangle
    states = [string[]]@(Element-States $Element)
    actions = [object[]]@(Element-Supported-Actions $Element)
    path = $Path
  }
}

function Build-Window-State {
  param($Window, [int]$MaxDepth = 12, [int]$MaxElements = 600, [string]$ViewMode = 'control')
  $script:indexCounter = 0
  $script:visitedCounter = 0
  $script:elements = New-Object System.Collections.Generic.List[object]
  $script:elementRefs = @{}
  $scope = $Window._scope
  $lines = New-Object System.Collections.Generic.List[string]

  function Element-Intersects-Scope {
    param([System.Windows.Automation.AutomationElement]$Element)
    if ($null -eq $scope) { return $true }
    $bounds = Rect-Object $Element.Current.BoundingRectangle
    if ($null -eq $bounds) { return $true }
    return (Rect-Intersects $bounds $scope)
  }

  if ($ViewMode -eq 'interactive') {
    $root = Ensure-Window-Element $Window
    $condition = New-Interactive-Element-Condition
    $candidates = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    for ($i = 0; $i -lt $candidates.Count -and $script:visitedCounter -lt $MaxElements; $i += 1) {
      $Element = $candidates.Item($i)
      if (!(Element-Intersects-Scope $Element)) { continue }
      $script:visitedCounter += 1
      if (Is-Interactive $Element) {
        $script:indexCounter += 1
        $summary = Element-Summary $Element $script:indexCounter "interactive/$i"
        $script:elements.Add($summary)
        $script:elementRefs[[string]$script:indexCounter] = $Element

        $role = Control-Type-Name $Element.Current.ControlType
        $name = [string]$Element.Current.Name
        $automationId = [string]$Element.Current.AutomationId
        $value = Element-Value $Element
        $label = if (![string]::IsNullOrWhiteSpace($name)) { $name } elseif (![string]::IsNullOrWhiteSpace($automationId)) { $automationId } else { '' }
        $valuePart = if (![string]::IsNullOrEmpty($value)) { " value=`"$value`"" } else { '' }
        $idPart = if (![string]::IsNullOrWhiteSpace($automationId)) { " id=`"$automationId`"" } else { '' }
        $lines.Add("[$($script:indexCounter)] $role `"$label`"$idPart$valuePart")
      }
    }

    $treeMarkdown = [string]::Join("`n", [string[]]$lines.ToArray())
    $publicElements = @()
    foreach ($item in $script:elements) {
      $publicElements += $item
    }
    return [ordered]@{
      app = $Window.app_name
      pid = $Window.pid
      title = $Window.title
      window_id = $Window.window_id
      bounds = $Window.bounds
      automation_channels = Window-Automation-Capabilities $Window
      tree_markdown = $treeMarkdown
      elements = $publicElements
      _elementRefs = $script:elementRefs
    }
  }

  $walker = if ($ViewMode -eq 'raw') {
    [System.Windows.Automation.TreeWalker]::RawViewWalker
  } else {
    [System.Windows.Automation.TreeWalker]::ControlViewWalker
  }

  function Visit {
    param(
      [System.Windows.Automation.AutomationElement]$Element,
      [int]$Depth,
      [string]$Path
    )
    if ($Depth -gt $MaxDepth) { return }
    if ($script:visitedCounter -ge $MaxElements) { return }
    if (!(Element-Intersects-Scope $Element)) { return }
    $script:visitedCounter += 1
    $role = Control-Type-Name $Element.Current.ControlType
    $name = [string]$Element.Current.Name
    $automationId = [string]$Element.Current.AutomationId
    $value = Element-Value $Element
    $prefix = '  ' * $Depth
    $label = if (![string]::IsNullOrWhiteSpace($name)) { $name } elseif (![string]::IsNullOrWhiteSpace($automationId)) { $automationId } else { '' }
    $indexLabel = ''
    if (Is-Interactive $Element) {
      $script:indexCounter += 1
      $summary = Element-Summary $Element $script:indexCounter $Path
      $script:elements.Add($summary)
      $script:elementRefs[[string]$script:indexCounter] = $Element
      $indexLabel = "[$($script:indexCounter)] "
    }
    $valuePart = if (![string]::IsNullOrEmpty($value)) { " value=`"$value`"" } else { '' }
    $idPart = if (![string]::IsNullOrWhiteSpace($automationId)) { " id=`"$automationId`"" } else { '' }
    $lines.Add("$prefix$indexLabel$role `"$label`"$idPart$valuePart")

    $child = $walker.GetFirstChild($Element)
    $childIndex = 0
    while ($child -and $script:visitedCounter -lt $MaxElements) {
      Visit $child ($Depth + 1) "$Path/$childIndex"
      $child = $walker.GetNextSibling($child)
      $childIndex += 1
    }
  }

  Visit (Ensure-Window-Element $Window) 0 '0'
  $treeMarkdown = [string]::Join("`n", [string[]]$lines.ToArray())
  $publicElements = @()
  foreach ($item in $script:elements) {
    $publicElements += $item
  }
  return [ordered]@{
    app = $Window.app_name
    pid = $Window.pid
    title = $Window.title
    window_id = $Window.window_id
    bounds = $Window.bounds
    automation_channels = Window-Automation-Capabilities $Window
    tree_markdown = $treeMarkdown
    elements = $publicElements
    _elementRefs = $script:elementRefs
  }
}

function Build-Single-Element-State {
  param($Window, [System.Windows.Automation.AutomationElement]$Element)
  $role = Control-Type-Name $Element.Current.ControlType
  $name = [string]$Element.Current.Name
  $automationId = [string]$Element.Current.AutomationId
  $value = Element-Value $Element
  $summary = [ordered]@{
    element_index = 1
    role = $role
    name = if ([string]::IsNullOrEmpty($name)) { $null } else { $name }
    automation_id = if ([string]::IsNullOrEmpty($automationId)) { $null } else { $automationId }
    preferred_selector = if (![string]::IsNullOrEmpty($automationId)) { 'automation_id' } else { 'element_index' }
    value = if ($null -eq $value -or [string]::IsNullOrEmpty($value)) { $null } else { $value }
    bounds = Rect-Object $Element.Current.BoundingRectangle
    states = [string[]]@(Element-States $Element)
    actions = [object[]]@(Element-Supported-Actions $Element)
    path = 'automation_id'
  }
  $label = if ($summary.name) { $summary.name } elseif ($summary.automation_id) { $summary.automation_id } else { '' }
  $valuePart = if ($summary.value) { " value=`"$($summary.value)`"" } else { '' }
  $idPart = if ($summary.automation_id) { " id=`"$($summary.automation_id)`"" } else { '' }
  return [ordered]@{
    app = $Window.app_name
    pid = $Window.pid
    title = $Window.title
    window_id = $Window.window_id
    bounds = $Window.bounds
    automation_channels = Window-Automation-Capabilities $Window
    tree_markdown = "$($summary.role) `"$label`"$idPart$valuePart"
    elements = @($summary)
  }
}

function Resolve-Indexed-Interactive-Element {
  param($Window, [int]$ElementIndex, [int]$MaxElements = 5000)
  if ($ElementIndex -lt 1) {
    Fail 'INVALID_ARGS' 'element_index must be greater than zero.'
  }

  $root = Ensure-Window-Element $Window
  $condition = New-Interactive-Element-Condition
  $candidates = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $resolvedIndex = 0
  for ($i = 0; $i -lt $candidates.Count -and $i -lt $MaxElements; $i += 1) {
    $element = $candidates.Item($i)
    if (Is-Interactive $element) {
      $resolvedIndex += 1
      if ($resolvedIndex -eq $ElementIndex) {
        return $element
      }
    }
  }

  Fail 'INVALID_ELEMENT_INDEX' "No interactive element_index $ElementIndex is available for window '$($Window.title)'. Run get_window_state again and use a fresh index."
}

function Resolve-Indexed-Element {
  param($InputArgs)
  if ($null -eq $InputArgs.element_index) {
    Fail 'INVALID_ARGS' 'element_index is required for this Windows UIA action.'
  }
  $window = Resolve-Window $InputArgs
  $maxDepth = if (Has-Arg $InputArgs 'max_depth') { [int]$InputArgs.max_depth } else { 12 }
  $viewMode = if (Has-Arg $InputArgs 'view_mode') { ([string]$InputArgs.view_mode).Trim().ToLowerInvariant() } else { 'control' }
  if ($viewMode -ne 'control' -and $viewMode -ne 'raw' -and $viewMode -ne 'interactive') {
    Fail 'INVALID_ARGS' 'view_mode must be control, raw, or interactive.'
  }
  $maxElements = if (Has-Arg $InputArgs 'max_elements') { [int]$InputArgs.max_elements } elseif ($viewMode -eq 'interactive') { 5000 } else { 600 }
  $key = [string][int]$InputArgs.element_index
  if ($viewMode -eq 'interactive') {
    $element = Resolve-Indexed-Interactive-Element $window ([int]$InputArgs.element_index) $maxElements
    return [pscustomobject]@{ window = $window; state = $null; element = $element }
  }
  $state = Build-Window-State $window $maxDepth $maxElements $viewMode
  $element = $state._elementRefs[$key]
  if ($null -eq $element) {
    Fail 'INVALID_ELEMENT_INDEX' "No element_index $key is available for window '$($window.title)'. Run get_window_state again and use a fresh index."
  }
  return [pscustomobject]@{ window = $window; state = $state; element = $element }
}

function Find-Element-By-Automation-Id {
  param(
    $Window,
    [string]$AutomationId
  )
  if ([string]::IsNullOrWhiteSpace($AutomationId)) {
    Fail 'INVALID_ARGS' 'automation_id must be a non-empty string.'
  }

  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  $element = (Ensure-Window-Element $Window).FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($null -eq $element) {
    Fail 'ELEMENT_NOT_FOUND' "No element matched automation_id '$AutomationId' in window '$($Window.title)'."
  }
  return $element
}

function Resolve-Element-Target {
  param($InputArgs)
  if (Has-Arg $InputArgs 'element_index' -and $null -ne $InputArgs.element_index) {
    return Resolve-Indexed-Element $InputArgs
  }

  if (Has-Arg $InputArgs 'automation_id' -and $null -ne $InputArgs.automation_id) {
    $window = Resolve-Window $InputArgs
    $element = Find-Element-By-Automation-Id $window ([string]$InputArgs.automation_id)
    return [pscustomobject]@{ window = $window; state = $null; element = $element }
  }

  Fail 'INVALID_ARGS' 'element_index or automation_id is required for this Windows UIA action.'
}

function Resolve-Action-Target {
  param($InputArgs)
  $explicitPoint = $null
  if ((Has-Arg $InputArgs 'x') -and (Has-Arg $InputArgs 'y')) {
    $explicitPoint = [pscustomobject]@{ x = [int]$InputArgs.x; y = [int]$InputArgs.y }
  }
  if (Has-Arg $InputArgs 'element_index' -and $null -ne $InputArgs.element_index) {
    $resolved = Resolve-Indexed-Element $InputArgs
    $handle = [IntPtr][int]$resolved.element.Current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero) {
      $handle = [IntPtr][int]$resolved.window._handle
    }
    return [pscustomobject]@{
      window = $resolved.window
      element = $resolved.element
      hwnd = $handle
      bounds = Rect-Object $resolved.element.Current.BoundingRectangle
      point = $explicitPoint
    }
  }
  if (Has-Arg $InputArgs 'automation_id' -and $null -ne $InputArgs.automation_id) {
    $window = Resolve-Window $InputArgs
    $element = Find-Element-By-Automation-Id $window ([string]$InputArgs.automation_id)
    $handle = [IntPtr][int]$element.Current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero) {
      $handle = [IntPtr][int]$window._handle
    }
    return [pscustomobject]@{
      window = $window
      element = $element
      hwnd = $handle
      bounds = Rect-Object $element.Current.BoundingRectangle
      point = $explicitPoint
    }
  }

  $window = Resolve-Window $InputArgs
  return [pscustomobject]@{
    window = $window
    element = $null
    hwnd = [IntPtr][int]$window._handle
    bounds = $window.bounds
    point = $explicitPoint
  }
}

function Invoke-Element {
  param([System.Windows.Automation.AutomationElement]$Element)
  $controlType = $Element.Current.ControlType
  if ($controlType -eq [System.Windows.Automation.ControlType]::Button) {
    $invoke = Element-Invoke-Pattern-Or-Null $Element
    if ($invoke) {
      $invoke.Invoke()
      return 'invoke'
    }
  }
  if ($controlType -eq [System.Windows.Automation.ControlType]::CheckBox) {
    $toggle = Element-Toggle-Pattern-Or-Null $Element
    if ($toggle) {
      $toggle.Toggle()
      return 'toggle'
    }
  }
  if (
    $controlType -eq [System.Windows.Automation.ControlType]::RadioButton -or
    $controlType -eq [System.Windows.Automation.ControlType]::ListItem -or
    $controlType -eq [System.Windows.Automation.ControlType]::MenuItem
  ) {
    $selection = Element-Selection-Item-Pattern-Or-Null $Element
    if ($selection) {
      $selection.Select()
      return 'select'
    }
  }
  if ($controlType -ne [System.Windows.Automation.ControlType]::Button) {
    $selection = Element-Selection-Item-Pattern-Or-Null $Element
    if ($selection) {
      $selection.Select()
      return 'select'
    }
    $toggle = Element-Toggle-Pattern-Or-Null $Element
    if ($toggle) {
      $toggle.Toggle()
      return 'toggle'
    }
  }
  $invoke = Element-Invoke-Pattern-Or-Null $Element
  if ($invoke) {
    $invoke.Invoke()
    return 'invoke'
  }
  $handle = [IntPtr][int]$Element.Current.NativeWindowHandle
  if ($handle -ne [IntPtr]::Zero) {
    [void][InterpreterWin32Uia]::SendMessagePtr($handle, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
    return 'wm_click'
  }
  Fail 'ACTION_UNSUPPORTED' 'Element does not support Invoke, Toggle, or SelectionItem patterns.'
}

function Invoke-Element-For-Click {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [IntPtr]$TargetHwnd
  )
  $controlType = $Element.Current.ControlType
  $elementHwnd = [IntPtr][int]$Element.Current.NativeWindowHandle
  if (
    $elementHwnd -ne [IntPtr]::Zero -and
    (Element-Is-Native-Button-Family-Control $Element)
  ) {
    Post-Window-Message $elementHwnd $BM_CLICK ([IntPtr]::Zero) ([IntPtr]::Zero)
    return 'wm_button_click'
  }
  $method = Invoke-Element $Element
  if (
    $method -eq 'invoke' -and
    $elementHwnd -eq [IntPtr]::Zero -and
    $controlType -eq [System.Windows.Automation.ControlType]::Button -and
    $TargetHwnd -ne [IntPtr]::Zero
  ) {
    Start-Sleep -Milliseconds 80
    Press-Key-Target $TargetHwnd 'Enter'
    return 'invoke_enter_key'
  }
  return $method
}

function Normalize-Option-Text {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  return (($Text -replace '\s+', ' ').Trim()).ToLowerInvariant()
}

function Element-Display-Text {
  param([System.Windows.Automation.AutomationElement]$Element)
  $name = [string]$Element.Current.Name
  if (![string]::IsNullOrWhiteSpace($name)) { return $name }
  $value = Element-Value $Element
  if (![string]::IsNullOrWhiteSpace($value)) { return [string]$value }
  return ''
}

function Find-Visible-Option-Under-Root {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$OptionText,
    [int]$MaxElements = 2000,
    $NearBounds = $null,
    [bool]$FailIfMissing = $true
  )
  $target = Normalize-Option-Text $OptionText
  if ([string]::IsNullOrWhiteSpace($target)) {
    Fail 'INVALID_ARGS' 'option_text must be a non-empty string.'
  }

  $matches = New-Object System.Collections.Generic.List[object]
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $visited = 0

  function Visit-Option-Candidate {
    param([System.Windows.Automation.AutomationElement]$Element)
    if ($script:optionVisited -ge $script:optionMaxElements) { return }
    $script:optionVisited += 1
    try {
      if (!($Element.Current.IsOffscreen)) {
        $label = Element-Display-Text $Element
        if ((Normalize-Option-Text $label) -eq $script:optionTarget) {
          $bounds = Rect-Object $Element.Current.BoundingRectangle
          if ($null -ne $bounds -and $bounds.width -gt 0 -and $bounds.height -gt 0) {
            $matches.Add([pscustomobject]@{
              element = $Element
              bounds = $bounds
              control_type = [string]$Element.Current.ControlType.ProgrammaticName
              interactive = [bool](Element-Has-Interactive-Pattern $Element)
              distance = [double](Distance-To-Rect $bounds $script:optionNearBounds)
              area = [double]($bounds.width * $bounds.height)
            })
          }
        }
      }
    } catch {
    }

    $child = $script:optionWalker.GetFirstChild($Element)
    while ($child -and $script:optionVisited -lt $script:optionMaxElements) {
      Visit-Option-Candidate $child
      $child = $script:optionWalker.GetNextSibling($child)
    }
  }

  $script:optionTarget = $target
  $script:optionNearBounds = $NearBounds
  $script:optionMaxElements = $MaxElements
  $script:optionVisited = 0
  $script:optionWalker = $walker
  Visit-Option-Candidate $Root

  if ($matches.Count -eq 0) {
    if ($FailIfMissing) {
      Fail 'OPTION_NOT_FOUND' "No visible option matched '$OptionText'."
    }
    return $null
  }

  return @($matches |
    Sort-Object -Property @{ Expression = { $_.interactive }; Descending = $true }, @{ Expression = { $_.distance }; Descending = $false }, @{ Expression = { $_.area }; Descending = $false } |
    Select-Object -First 1)[0]
}

function Find-Visible-Option-Element {
  param(
    $Window,
    [string]$OptionText,
    [int]$MaxElements = 2000,
    [bool]$FailIfMissing = $true
  )
  return Find-Visible-Option-Under-Root (Ensure-Window-Element $Window) $OptionText $MaxElements $null $FailIfMissing
}

function Try-Set-Combo-Value {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$OptionText
  )
  $controlType = $Element.Current.ControlType
  if (
    $controlType -eq [System.Windows.Automation.ControlType]::ComboBox -or
    $controlType -eq [System.Windows.Automation.ControlType]::List
  ) {
    return $null
  }
  $valuePattern = Element-Value-Pattern-Or-Null $Element
  if ($null -eq $valuePattern) {
    return $null
  }
  try {
    if ($valuePattern.Current.IsReadOnly) {
      return $null
    }
    $valuePattern.SetValue($OptionText)
    return [ordered]@{
      action = 'select_option'
      method = 'uia_value'
      option_text = $OptionText
    }
  } catch {
    return $null
  }
}

function Find-Visible-Root-Option-ByName {
  param(
    [string]$OptionText,
    $NearBounds = $null
  )
  return Find-Visible-Option-Under-Root ([System.Windows.Automation.AutomationElement]::RootElement) $OptionText 3000 $NearBounds $true
}

function Select-Visible-Option-ByName {
  param(
    [string]$OptionText,
    $NearBounds = $null
  )
  $option = Find-Visible-Root-Option-ByName $OptionText $NearBounds
  $method = Invoke-Element $option.element
  return [ordered]@{
    action = 'select_visible_option'
    method = $method
    option_text = $OptionText
    option_bounds = $option.bounds
    control_type = $option.control_type
  }
}

function Distance-To-Rect {
  param($Bounds, $NearBounds)
  if ($null -eq $Bounds -or $null -eq $NearBounds) { return 0.0 }
  $cx = [double]$Bounds.x + ([double]$Bounds.width / 2.0)
  $cy = [double]$Bounds.y + ([double]$Bounds.height / 2.0)
  $nx = [double]$NearBounds.x + ([double]$NearBounds.width / 2.0)
  $ny = [double]$NearBounds.y + ([double]$NearBounds.height / 2.0)
  $dx = $cx - $nx
  $dy = $cy - $ny
  return [Math]::Sqrt(($dx * $dx) + ($dy * $dy))
}

function Element-At-Point {
  param([int]$X, [int]$Y)
  $point = New-Object System.Windows.Point -ArgumentList ([double]$X), ([double]$Y)
  $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
  if ($null -eq $element) {
    Fail 'ELEMENT_NOT_FOUND' "No UIA element found at point $X,$Y."
  }
  return $element
}

function Resolve-Dropdown-Element-At-Point {
  param([int]$X, [int]$Y)
  $element = Element-At-Point $X $Y
  $owner = Resolve-Dropdown-Owner-Element $element
  if ($null -ne $owner) {
    return $owner
  }
  Fail 'DROPDOWN_NOT_FOUND' "No dropdown-capable UIA element found at point $X,$Y."
}

function Resolve-Dropdown-Owner-Element {
  param([System.Windows.Automation.AutomationElement]$Element)
  if ($null -eq $Element) { return $null }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $candidate = $Element
  $fallback = $null
  $depth = 0
  while ($candidate -and $depth -lt 12) {
    $controlType = $candidate.Current.ControlType
    if (
      $controlType -eq [System.Windows.Automation.ControlType]::ComboBox -or
      $controlType -eq [System.Windows.Automation.ControlType]::List
    ) {
      return $candidate
    }
    if ($null -eq $fallback -and (Element-Expand-Collapse-Pattern-Available $candidate)) {
      $fallback = $candidate
    }
    $candidate = $walker.GetParent($candidate)
    $depth += 1
  }
  return $fallback
}

function Find-Dropdown-Owner-NearBounds {
  param(
    $Window,
    $NearBounds,
    [int]$MaxElements = 900
  )
  if ($null -eq $NearBounds) { return $null }
  $root = Ensure-Window-Element $Window
  $nearCenter = Center-Of-Rect $NearBounds
  if ($null -eq $nearCenter) { return $null }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $matches = New-Object System.Collections.ArrayList
  $visited = 0

  function Visit-Dropdown-Owner-Candidate {
    param($Element)
    if ($null -eq $Element -or $script:dropdownOwnerVisited -ge $script:dropdownOwnerMax) {
      return
    }
    $script:dropdownOwnerVisited += 1
    try {
      $controlType = $Element.Current.ControlType
      $expandable = Element-Expand-Collapse-Pattern-Available $Element
      $isDropdownLike = (
        $controlType -eq [System.Windows.Automation.ControlType]::ComboBox -or
        $controlType -eq [System.Windows.Automation.ControlType]::List -or
        $expandable
      )
      if ($isDropdownLike -and $controlType -ne [System.Windows.Automation.ControlType]::Image) {
        $bounds = Rect-Object $Element.Current.BoundingRectangle
        if ($null -ne $bounds -and $bounds.width -gt 0 -and $bounds.height -gt 0) {
          $containsPoint = (
            [double]$script:dropdownOwnerPoint.x -ge [double]$bounds.x -and
            [double]$script:dropdownOwnerPoint.x -le ([double]$bounds.x + [double]$bounds.width) -and
            [double]$script:dropdownOwnerPoint.y -ge [double]$bounds.y -and
            [double]$script:dropdownOwnerPoint.y -le ([double]$bounds.y + [double]$bounds.height)
          )
          $area = [double]$bounds.width * [double]$bounds.height
          $nearArea = [double]$script:dropdownOwnerNear.width * [double]$script:dropdownOwnerNear.height
          if ($containsPoint -or $area -gt ($nearArea * 1.5)) {
            [void]$script:dropdownOwnerMatches.Add([pscustomobject]@{
              element = $Element
              bounds = $bounds
              contains = $containsPoint
              area = $area
              distance = (Distance-To-Rect $bounds $script:dropdownOwnerNear)
              combo = ($controlType -eq [System.Windows.Automation.ControlType]::ComboBox)
              list = ($controlType -eq [System.Windows.Automation.ControlType]::List)
            })
          }
        }
      }
    } catch {
    }

    $child = $script:dropdownOwnerWalker.GetFirstChild($Element)
    while ($child -and $script:dropdownOwnerVisited -lt $script:dropdownOwnerMax) {
      Visit-Dropdown-Owner-Candidate $child
      $child = $script:dropdownOwnerWalker.GetNextSibling($child)
    }
  }

  $script:dropdownOwnerMatches = $matches
  $script:dropdownOwnerVisited = $visited
  $script:dropdownOwnerMax = $MaxElements
  $script:dropdownOwnerWalker = $walker
  $script:dropdownOwnerNear = $NearBounds
  $script:dropdownOwnerPoint = $nearCenter
  Visit-Dropdown-Owner-Candidate $root

  if ($matches.Count -eq 0) {
    return $null
  }

  return @($matches |
    Sort-Object -Property @{ Expression = { $_.contains }; Descending = $true }, @{ Expression = { $_.combo }; Descending = $true }, @{ Expression = { $_.list }; Descending = $true }, @{ Expression = { $_.distance }; Descending = $false }, @{ Expression = { $_.area }; Descending = $false } |
    Select-Object -First 1)[0]
}

function Select-Option-At-Point {
  param(
    $Window,
    [int]$X,
    [int]$Y,
    [string]$OptionText,
    [int]$MaxElements = 2000
  )
  $element = Resolve-Dropdown-Element-At-Point $X $Y
  $data = Select-Option-For-Element $Window $element $OptionText $MaxElements
  $data.action = 'select_option_at_point'
  $data.x = $X
  $data.y = $Y
  return $data
}

function Open-Dropdown-Element {
  param(
    $Window,
    [System.Windows.Automation.AutomationElement]$Element,
    $DropdownBounds
  )
  Trace-Uia ("open-dropdown start control={0} name='{1}'" -f $Element.Current.ControlType.ProgrammaticName, $Element.Current.Name)
  $nativeHandle = [IntPtr][int]$Element.Current.NativeWindowHandle
  $nativeClass = if ($nativeHandle -ne [IntPtr]::Zero) { [InterpreterWin32Uia]::ReadClassName($nativeHandle) } else { '' }
  $isNativeCombo = $nativeClass -match '^(ComboBox|ComboBoxEx32|ListBox)$'
  if (!$isNativeCombo) {
    $dropdownTarget = [pscustomobject]@{
      window = $Window
      element = $Element
      hwnd = [IntPtr][int]$Window._handle
      bounds = $DropdownBounds
      point = $null
    }
    Trace-Uia ("open-dropdown non-native-message-click start nativeHandle={0} nativeClass='{1}'" -f $nativeHandle.ToInt64(), $nativeClass)
    return Click-Target-By-Message $dropdownTarget
  }

  $expand = Element-Expand-Collapse-Pattern-Or-Null $Element
  if ($expand) {
    Trace-Uia ("open-dropdown expand-state={0}" -f $expand.Current.ExpandCollapseState)
    if ($expand.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) {
      Trace-Uia 'open-dropdown expand invoke'
      $expand.Expand()
      Trace-Uia 'open-dropdown expand returned'
      return 'uia_expand'
    }
    return 'already_expanded'
  }

  $invoke = Element-Invoke-Pattern-Or-Null $Element
  if ($invoke) {
    try {
      Trace-Uia 'open-dropdown invoke start'
      $invoke.Invoke()
      Trace-Uia 'open-dropdown invoke returned'
      return 'uia_invoke'
    } catch {
      Trace-Uia ("open-dropdown invoke failed {0}" -f $_.Exception.Message)
      # Chromium can expose InvokePattern on combo boxes while returning an
      # opaque UIA failure when invoked. Keep using the non-foreground message
      # path below instead of failing the whole primitive.
    }
  }

  $dropdownTarget = [pscustomobject]@{
    window = $Window
    element = $Element
    hwnd = [IntPtr][int]$Window._handle
    bounds = $DropdownBounds
    point = $null
  }
  Trace-Uia 'open-dropdown message-click start'
  return Click-Target-By-Message $dropdownTarget
}

function Commit-Open-Dropdown-By-Typeahead {
  param(
    $Window,
    [string]$OptionText,
    $DropdownBounds
  )
  $dropdownTarget = [pscustomobject]@{
    window = $Window
    element = $null
    hwnd = [IntPtr][int]$Window._handle
    bounds = $DropdownBounds
    point = $null
  }
  $keyboardHwnd = Resolve-Keyboard-Hwnd $dropdownTarget
  if ($keyboardHwnd -eq [IntPtr]::Zero) {
    return $null
  }
  Trace-Uia ("select-option typeahead start hwnd={0}" -f $keyboardHwnd.ToInt64())
  Post-Window-Text-Chars $keyboardHwnd $OptionText 0
  Start-Sleep -Milliseconds 35
  Press-Key-Target $keyboardHwnd 'Enter'
  Trace-Uia 'select-option typeahead returned'
  return [ordered]@{
    action = 'select_option'
    method = 'wm_typeahead_enter'
    option_text = $OptionText
  }
}

function Select-Option-For-Element {
  param(
    $Window,
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$OptionText,
    [int]$MaxElements = 2000
  )

  $initialBounds = Rect-Object $Element.Current.BoundingRectangle
  $resolvedElement = Resolve-Dropdown-Owner-Element $Element
  if ($null -ne $resolvedElement -and ![object]::ReferenceEquals($resolvedElement, $Element)) {
    Trace-Uia ("select-option resolved owner from control={0} name='{1}' to control={2} name='{3}'" -f $Element.Current.ControlType.ProgrammaticName, $Element.Current.Name, $resolvedElement.Current.ControlType.ProgrammaticName, $resolvedElement.Current.Name)
    $Element = $resolvedElement
  }
  if ($Element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Image) {
    $nearOwner = Find-Dropdown-Owner-NearBounds $Window $initialBounds
    if ($null -ne $nearOwner) {
      Trace-Uia ("select-option resolved nearby owner from control={0} name='{1}' bounds={2},{3},{4},{5} to control={6} name='{7}' bounds={8},{9},{10},{11}" -f $Element.Current.ControlType.ProgrammaticName, $Element.Current.Name, $initialBounds.x, $initialBounds.y, $initialBounds.width, $initialBounds.height, $nearOwner.element.Current.ControlType.ProgrammaticName, $nearOwner.element.Current.Name, $nearOwner.bounds.x, $nearOwner.bounds.y, $nearOwner.bounds.width, $nearOwner.bounds.height)
      $Element = $nearOwner.element
    }
  }
  $dropdownBounds = Rect-Object $Element.Current.BoundingRectangle
  Trace-Uia ("select-option start option='{0}' control={1} name='{2}' bounds={3},{4},{5},{6}" -f $OptionText, $Element.Current.ControlType.ProgrammaticName, $Element.Current.Name, $dropdownBounds.x, $dropdownBounds.y, $dropdownBounds.width, $dropdownBounds.height)
  if ($null -eq $dropdownBounds -or $dropdownBounds.width -le 0 -or $dropdownBounds.height -le 0) {
    Fail 'INVALID_TARGET' 'Dropdown target did not include usable bounds.'
  }
  Trace-Uia 'select-option try-value start'
  $valueSelection = Try-Set-Combo-Value $Element $OptionText
  if ($null -ne $valueSelection) {
    Trace-Uia 'select-option try-value returned'
    return $valueSelection
  }
  Trace-Uia 'select-option try-value skipped'

  $dropdownHwnd = [IntPtr][int]$Element.Current.NativeWindowHandle
  if (
    $dropdownHwnd -ne [IntPtr]::Zero -and
    $Element.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox
  ) {
    $dropdownClassName = [InterpreterWin32Uia]::ReadClassName($dropdownHwnd)
    Trace-Uia ("select-option native-hwnd={0} class='{1}'" -f $dropdownHwnd.ToInt64(), $dropdownClassName)
    if ($dropdownClassName -match '^(ComboBox|ComboBoxEx32|ListBox)$') {
      Trace-Uia 'select-option cb-selectstring start'
      $selectionIndex = [InterpreterWin32Uia]::SendMessageString(
        $dropdownHwnd,
        $CB_SELECTSTRING,
        [IntPtr](-1),
        $OptionText
      ).ToInt32()
      Trace-Uia ("select-option cb-selectstring returned index={0}" -f $selectionIndex)
      if ($selectionIndex -ge 0) {
        return [ordered]@{
          action = 'wm_combo_select_string'
          option_text = $OptionText
          selected_index = $selectionIndex
          native_class = $dropdownClassName
        }
      }
    }
  }
  Trace-Uia 'select-option open start'
  $openMethod = Open-Dropdown-Element $Window $Element $dropdownBounds
  Trace-Uia ("select-option open returned method={0}" -f $openMethod)
  Start-Sleep -Milliseconds 80

  $typeaheadSelection = Commit-Open-Dropdown-By-Typeahead $Window $OptionText $dropdownBounds
  if ($null -ne $typeaheadSelection) {
    $typeaheadSelection.open_method = $openMethod
    return $typeaheadSelection
  }

  $option = $null
  $deadline = (Get-Date).AddMilliseconds(600)
  while ((Get-Date) -lt $deadline) {
    Trace-Uia 'select-option find-window-option tick'
    $option = Find-Visible-Option-Element $Window $OptionText ([Math]::Min($MaxElements, 350)) $false
    if ($null -ne $option) { break }
    Start-Sleep -Milliseconds 120
  }
  if ($null -eq $option) {
    Trace-Uia 'select-option root-search start'
    $rootOption = Find-Visible-Root-Option-ByName $OptionText $dropdownBounds
    Trace-Uia 'select-option root-search returned'
    $method = Invoke-Element $rootOption.element
    Trace-Uia ("select-option root-invoke returned method={0}" -f $method)
    return [ordered]@{
      action = 'select_option'
      open_method = $openMethod
      method = $method
      close_method = 'root_option_invoke'
      option_text = $OptionText
      option_bounds = $rootOption.bounds
      option_control_type = $rootOption.control_type
    }
  }
  if ($null -eq $option) {
    Fail 'OPTION_NOT_FOUND_AFTER_OPEN' "No visible option matched '$OptionText' after non-foreground dropdown open."
  }
  Trace-Uia 'select-option option-invoke start'
  $method = Invoke-Element $option.element
  Trace-Uia ("select-option option-invoke returned method={0}" -f $method)
  return [ordered]@{
    action = 'select_option'
    open_method = $openMethod
    method = $method
    close_method = 'option_invoke'
    option_text = $OptionText
    option_bounds = $option.bounds
  }
}

function Element-Has-Direct-Click-Pattern {
  param([System.Windows.Automation.AutomationElement]$Element)
  if ($null -eq $Element) { return $false }
  $controlType = $Element.Current.ControlType
  $elementHwnd = [IntPtr][int]$Element.Current.NativeWindowHandle
  return (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)) -or
    (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty)) -or
    (Pattern-Available $Element ([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty))
}

function Resolve-Message-Hwnd-At-Point {
  param($Target, $Point)
  $rootHwnd = [IntPtr][int]$Target.window._handle
  if ($rootHwnd -eq [IntPtr]::Zero -or $null -eq $Point) {
    return $rootHwnd
  }

  $nativePoint = New-Object InterpreterWin32Uia+POINT
  $nativePoint.X = [int]$Point.x
  $nativePoint.Y = [int]$Point.y
  $pointHwnd = [InterpreterWin32Uia]::WindowFromPoint($nativePoint)
  if ($pointHwnd -eq [IntPtr]::Zero) {
    return $rootHwnd
  }

  $pointRoot = [InterpreterWin32Uia]::GetAncestor($pointHwnd, [InterpreterWin32Uia]::GA_ROOT)
  if ($pointRoot -eq $rootHwnd) {
    return $pointHwnd
  }
  return $rootHwnd
}

function Click-Target-By-Message {
  param($Target)
  $bounds = Object-Value $Target 'bounds'
  $rawHwnd = Object-Value $Target 'hwnd'
  if ($null -eq $rawHwnd) { Fail 'INVALID_TARGET' 'click target did not include a native hwnd.' }
  $clickHwnd = [IntPtr]$rawHwnd
  $element = Object-Value $Target 'element'
  $point = Object-Value $Target 'point'
  if ($null -eq $point) {
    $point = Center-Of-Rect $bounds
  }
  if ($null -eq $point) {
    Fail 'INVALID_TARGET' 'click target did not include usable bounds.'
  }
  $inputHwnd = [IntPtr]::Zero
  if ($element) {
    $elementHwnd = [IntPtr][int]$element.Current.NativeWindowHandle
    if ($elementHwnd -ne [IntPtr]::Zero) {
      if (
        Element-Is-Native-Button-Family-Control $element
      ) {
        Post-Window-Message $elementHwnd $BM_CLICK ([IntPtr]::Zero) ([IntPtr]::Zero)
        return 'wm_button_click'
      }
      $clickHwnd = $elementHwnd
    } else {
      $inputHwnd = Resolve-Message-Hwnd-At-Point $Target $point
      $clickHwnd = if ($inputHwnd -ne [IntPtr]::Zero) { $inputHwnd } else { Resolve-Keyboard-Hwnd $Target }
    }
  } elseif ($null -ne (Object-Value $Target 'point')) {
    $inputHwnd = Resolve-Message-Hwnd-At-Point $Target $point
    if ($inputHwnd -ne [IntPtr]::Zero) {
      $clickHwnd = $inputHwnd
    }
  }
  if ($clickHwnd -eq [IntPtr]::Zero) {
    Fail 'INVALID_TARGET' 'click target resolved to an empty native hwnd.'
  }

  $clientPoint = New-Object InterpreterWin32Uia+POINT
  $clientPoint.X = [int]$point.x
  $clientPoint.Y = [int]$point.y
  [void][InterpreterWin32Uia]::ScreenToClient($clickHwnd, [ref]$clientPoint)
  $clientLParam = Make-LParam $clientPoint.X $clientPoint.Y
  Post-Window-Message $clickHwnd $WM_MOUSEMOVE ([IntPtr]0) $clientLParam
  Post-Window-Message $clickHwnd $WM_LBUTTONDOWN ([IntPtr]$MK_LBUTTON) $clientLParam
  Post-Window-Message $clickHwnd $WM_LBUTTONUP ([IntPtr]0) $clientLParam
  if ($inputHwnd -ne [IntPtr]::Zero -and $inputHwnd -ne [IntPtr][int]$Target.window._handle) {
    return 'wm_child_left_click'
  }
  return 'wm_left_click'
}

function Click-Target-With-Foreground {
  param($Target)
  $bounds = Object-Value $Target 'bounds'
  $point = Object-Value $Target 'point'
  if ($null -eq $point) {
    $point = Center-Of-Rect $bounds
  }
  if ($null -eq $point) {
    Fail 'INVALID_TARGET' 'foreground click target did not include usable bounds.'
  }
  $windowHwnd = [IntPtr][int]$Target.window._handle
  [void](Show-Agent-Cursor-Target $Target)
  $foreground = Bring-Window-To-Foreground $windowHwnd
  Start-Sleep -Milliseconds 80
  [InterpreterWin32Uia]::SendForegroundLeftClick([int]$point.x, [int]$point.y)
  return [ordered]@{
    action = 'foreground_left_click'
    x = [int]$point.x
    y = [int]$point.y
    was_foreground = [bool]$foreground.was_foreground
    is_foreground = $true
    real_cursor_moved = $true
  }
}

function Try-Set-Element-Value {
  param([System.Windows.Automation.AutomationElement]$Element, [string]$Value)
  $handle = [IntPtr][int]$Element.Current.NativeWindowHandle
  if ($handle -ne [IntPtr]::Zero) {
    [void][InterpreterWin32Uia]::SendMessageString($handle, $WM_SETTEXT, [IntPtr]::Zero, $Value)
    Start-Sleep -Milliseconds 20
    if ([string](Element-Value $Element) -ne $Value) {
      return $null
    }
    return 'wm_settext'
  }

  $valuePattern = Element-Value-Pattern-Or-Null $Element
  if ($null -eq $valuePattern) {
    return $null
  }
  if ($valuePattern.Current.IsReadOnly) {
    Fail 'ACTION_UNSUPPORTED' 'Element value is read-only.'
  }
  $valuePattern.SetValue($Value)
  Start-Sleep -Milliseconds 20
  if ([string](Element-Value $Element) -ne $Value) {
    return $null
  }
  return 'uia_value'
}

function Replace-Target-Text-With-ForegroundKeyboard {
  param($Target, [string]$Value)
  $clickData = Click-Target-With-Foreground $Target
  Start-Sleep -Milliseconds 80
  [InterpreterWin32Uia]::SendForegroundVirtualKey(0x11, $false)
  [InterpreterWin32Uia]::SendForegroundVirtualKey(0x41, $false)
  [InterpreterWin32Uia]::SendForegroundVirtualKey(0x41, $true)
  [InterpreterWin32Uia]::SendForegroundVirtualKey(0x11, $true)
  Start-Sleep -Milliseconds 30
  [InterpreterWin32Uia]::SendForegroundUnicodeText($Value)
  return [ordered]@{
    action = 'foreground_keyboard_replace'
    click = $clickData
  }
}

function Type-Target-Text-With-ForegroundKeyboard {
  param($Target, [string]$Value, [bool]$ClearFirst)
  $clickData = Click-Target-With-Foreground $Target
  Start-Sleep -Milliseconds 80
  if ($ClearFirst) {
    [InterpreterWin32Uia]::SendForegroundVirtualKey(0x11, $false)
    [InterpreterWin32Uia]::SendForegroundVirtualKey(0x41, $false)
    [InterpreterWin32Uia]::SendForegroundVirtualKey(0x41, $true)
    [InterpreterWin32Uia]::SendForegroundVirtualKey(0x11, $true)
    Start-Sleep -Milliseconds 30
    [InterpreterWin32Uia]::SendForegroundVirtualKey(0x08, $false)
    [InterpreterWin32Uia]::SendForegroundVirtualKey(0x08, $true)
    Start-Sleep -Milliseconds 30
  }
  [InterpreterWin32Uia]::SendForegroundUnicodeText($Value)
  Start-Sleep -Milliseconds 100
  return [ordered]@{
    action = $(if ($ClearFirst) { 'foreground_keyboard_unicode_replace' } else { 'foreground_keyboard_unicode' })
    click = $clickData
    clear_first = $ClearFirst
  }
}

function Set-Target-Text-By-Resolved-Hwnd {
  param($Target, [string]$Value)
  $point = Object-Value $Target 'point'
  if ($null -eq $point) {
    $point = Center-Of-Rect (Object-Value $Target 'bounds')
  }
  if ($null -eq $point) {
    return $null
  }
  $keyboardHwnd = Resolve-Native-Descendant-Hwnd $Target.element
  if ($keyboardHwnd -eq [IntPtr]::Zero) {
    $keyboardHwnd = Resolve-Message-Hwnd-At-Point $Target $point
  }
  if ($keyboardHwnd -eq [IntPtr]::Zero) {
    return $null
  }
  [void][InterpreterWin32Uia]::SendMessageString($keyboardHwnd, $WM_SETTEXT, [IntPtr]::Zero, $Value)
  Start-Sleep -Milliseconds 40
  $actualValue = [InterpreterWin32Uia]::ReadWindowText($keyboardHwnd)
  if ($actualValue -ne $Value) {
    return $null
  }
  return 'wm_resolved_settext'
}

function Try-Set-Target-Value {
  param($Target, [string]$Value)
  if ($null -eq $Target.element) {
    return $null
  }
  $method = Try-Set-Element-Value $Target.element $Value
  if ($null -ne $method) {
    return $method
  }
  if (!(Element-Is-Text-Entry-Control $Target.element)) {
    return $null
  }
  $method = Set-Target-Text-By-Resolved-Hwnd $Target $Value
  if ($null -eq $method) {
    return $null
  }
  if ($method -eq 'wm_resolved_settext') {
    return $method
  }
  Start-Sleep -Milliseconds 40
  $actualValue = [string](Element-Value $Target.element)
  if ($actualValue -ne $Value) {
    return $null
  }
  return $method
}

function Append-Element-Text {
  param([System.Windows.Automation.AutomationElement]$Element, [string]$Text)
  $handle = [IntPtr][int]$Element.Current.NativeWindowHandle
  if ($handle -ne [IntPtr]::Zero) {
    $currentValue = Element-Value $Element
    if ($null -eq $currentValue) { $currentValue = '' }
    [void][InterpreterWin32Uia]::SendMessageString($handle, $WM_SETTEXT, [IntPtr]::Zero, "$currentValue$Text")
    [void][InterpreterWin32Uia]::SendMessagePtr($handle, $EM_SETSEL, [IntPtr](-1), [IntPtr](-1))
    return 'wm_append_settext'
  }

  $valuePattern = Element-Value-Pattern-Or-Null $Element
  if ($null -eq $valuePattern) {
    return $null
  }
  if ($valuePattern.Current.IsReadOnly) {
    Fail 'ACTION_UNSUPPORTED' 'Element value is read-only.'
  }
  $currentValue = ''
  try {
    $currentValue = [string]$valuePattern.Current.Value
  } catch {}
  $valuePattern.SetValue("$currentValue$Text")
  return 'uia_append_value'
}

function Try-Edit-Control-Key {
  param([System.Windows.Automation.AutomationElement]$Element, [string]$Key)
  if ($null -eq $Element) { return $null }
  $handle = [IntPtr][int]$Element.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $normalized = $Key.Trim().ToLowerInvariant()
  switch ($normalized) {
    'end' {
      [void][InterpreterWin32Uia]::SendMessagePtr($handle, $EM_SETSEL, [IntPtr](-1), [IntPtr](-1))
      return 'wm_edit_end'
    }
    'home' {
      [void][InterpreterWin32Uia]::SendMessagePtr($handle, $EM_SETSEL, [IntPtr]0, [IntPtr]0)
      return 'wm_edit_home'
    }
    'backspace' {
      $currentValue = Element-Value $Element
      if ($null -eq $currentValue) { return $null }
      if ($currentValue.Length -gt 0) {
        $nextValue = $currentValue.Substring(0, $currentValue.Length - 1)
        [void][InterpreterWin32Uia]::SendMessageString($handle, $WM_SETTEXT, [IntPtr]::Zero, $nextValue)
        [void][InterpreterWin32Uia]::SendMessagePtr($handle, $EM_SETSEL, [IntPtr](-1), [IntPtr](-1))
      }
      return 'wm_edit_backspace'
    }
  }
  return $null
}

function Resolve-Virtual-Key {
  param([string]$Key)
  $normalized = $Key.Trim().ToLowerInvariant()
  switch ($normalized) {
    'backspace' { return 0x08 }
    'tab' { return 0x09 }
    'enter' { return 0x0D }
    'return' { return 0x0D }
    'shift' { return 0x10 }
    'ctrl' { return 0x11 }
    'control' { return 0x11 }
    'alt' { return 0x12 }
    'option' { return 0x12 }
    'menu' { return 0x12 }
    'pause' { return 0x13 }
    'capslock' { return 0x14 }
    'escape' { return 0x1B }
    'esc' { return 0x1B }
    'space' { return 0x20 }
    'add' { return 0xBB }
    'plus' { return 0xBB }
    '+' { return 0xBB }
    'numpad_add' { return 0x6B }
    'multiply' { return 0x6A }
    'asterisk' { return 0x6A }
    '*' { return 0x6A }
    'subtract' { return 0xBD }
    'minus' { return 0xBD }
    '-' { return 0xBD }
    'numpad_subtract' { return 0x6D }
    'divide' { return 0x6F }
    'slash' { return 0x6F }
    '/' { return 0x6F }
    'decimal' { return 0x6E }
    '.' { return 0x6E }
    'pageup' { return 0x21 }
    'page_up' { return 0x21 }
    'pagedown' { return 0x22 }
    'page_down' { return 0x22 }
    'end' { return 0x23 }
    'home' { return 0x24 }
    'left' { return 0x25 }
    'arrowleft' { return 0x25 }
    'up' { return 0x26 }
    'arrowup' { return 0x26 }
    'right' { return 0x27 }
    'arrowright' { return 0x27 }
    'down' { return 0x28 }
    'arrowdown' { return 0x28 }
    'insert' { return 0x2D }
    'ins' { return 0x2D }
    'delete' { return 0x2E }
    'del' { return 0x2E }
    'apps' { return 0x5D }
    'contextmenu' { return 0x5D }
    'win' { return 0x5B }
    'meta' { return 0x5B }
    'cmd' { return 0x5B }
    'command' { return 0x5B }
  }
  if ($normalized -match '^f([1-9]|1[0-9]|2[0-4])$') {
    return 0x70 + ([int]$Matches[1]) - 1
  }
  if ($Key.Length -eq 1) {
    $code = [int][char]$Key.ToUpperInvariant()
    if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) {
      return $code
    }
  }
  Fail 'INVALID_KEY' "Unsupported key '$Key'."
}

function Is-Extended-Key {
  param([int]$VirtualKey)
  return @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D) -contains $VirtualKey
}

function Key-LParam {
  param([int]$VirtualKey, [bool]$IsUp, [bool]$AltContext)
  $scanCode = [int][InterpreterWin32Uia]::MapVirtualKey([uint32]$VirtualKey, [uint32]$MAPVK_VK_TO_VSC)
  $value = 1 -bor (($scanCode -band 0xff) -shl 16)
  if (Is-Extended-Key $VirtualKey) {
    $value = $value -bor (1 -shl 24)
  }
  if ($AltContext) {
    $value = $value -bor (1 -shl 29)
  }
  if ($IsUp) {
    $value = $value -bor (1 -shl 30) -bor (1 -shl 31)
  }
  return [IntPtr][int]$value
}

function Post-Virtual-Key {
  param([IntPtr]$Hwnd, [int]$VirtualKey, [bool]$IsDown, [bool]$AltContext = $false)
  $message = if ($AltContext) {
    if ($IsDown) { $WM_SYSKEYDOWN } else { $WM_SYSKEYUP }
  } else {
    if ($IsDown) { $WM_KEYDOWN } else { $WM_KEYUP }
  }
  Post-Window-Message $Hwnd $message ([IntPtr]$VirtualKey) (Key-LParam $VirtualKey (!$IsDown) $AltContext)
}

function Normalize-Modifier-Key {
  param([string]$Modifier)
  $vk = Resolve-Virtual-Key $Modifier
  if (@(0x10, 0x11, 0x12, 0x5B) -notcontains $vk) {
    Fail 'INVALID_MODIFIER' "Unsupported modifier '$Modifier'."
  }
  return $vk
}

function Parse-Modifier-List {
  param($InputArgs)
  $modifiers = @()
  if (Has-Arg $InputArgs 'modifiers' -and $null -ne $InputArgs.modifiers) {
    foreach ($modifier in @($InputArgs.modifiers)) {
      $modifiers += [string]$modifier
    }
  }
  return $modifiers
}

function Resolve-Key-Char {
  param([string]$Key)
  $normalized = $Key.Trim().ToLowerInvariant()
  switch ($normalized) {
    'add' { return '+' }
    'plus' { return '+' }
    '+' { return '+' }
    'subtract' { return '-' }
    'minus' { return '-' }
    '-' { return '-' }
    'divide' { return '/' }
    'slash' { return '/' }
    '/' { return '/' }
    'multiply' { return '*' }
    'asterisk' { return '*' }
    '*' { return '*' }
    'decimal' { return '.' }
    '.' { return '.' }
  }
  return $null
}

function Press-Key-Target {
  param([IntPtr]$Hwnd, [string]$Key, [string[]]$Modifiers = @())
  $virtualKey = Resolve-Virtual-Key $Key
  $modifierKeys = @()
  foreach ($modifier in $Modifiers) {
    if (![string]::IsNullOrWhiteSpace([string]$modifier)) {
      $modifierKeys += Normalize-Modifier-Key ([string]$modifier)
    }
  }
  $hasAlt = $modifierKeys -contains 0x12
  $keyChar = Resolve-Key-Char $Key
  foreach ($modifierKey in $modifierKeys) {
    Post-Virtual-Key $Hwnd $modifierKey $true ($modifierKey -eq 0x12)
  }
  Post-Virtual-Key $Hwnd $virtualKey $true $hasAlt
  if ($null -ne $keyChar -and !$hasAlt -and $modifierKeys.Count -eq 0) {
    Post-Window-Message $Hwnd $WM_CHAR ([IntPtr][int][char]$keyChar) (Key-LParam $virtualKey $false $false)
  }
  Post-Virtual-Key $Hwnd $virtualKey $false $hasAlt
  for ($i = $modifierKeys.Count - 1; $i -ge 0; $i--) {
    $modifierKey = $modifierKeys[$i]
    Post-Virtual-Key $Hwnd $modifierKey $false ($modifierKey -eq 0x12)
  }
}

function Post-Text-Chars {
  param([IntPtr]$Hwnd, [string]$Text, [int]$DelayMs = 0)
  [void][InterpreterWin32Uia]::SendMessagePtr($Hwnd, $EM_SETSEL, [IntPtr](-1), [IntPtr](-1))
  foreach ($character in $Text.ToCharArray()) {
    [void][InterpreterWin32Uia]::SendMessageString($Hwnd, $EM_REPLACESEL, [IntPtr]1, [string]$character)
    if ($DelayMs -gt 0) {
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Post-Window-Text-Chars {
  param([IntPtr]$Hwnd, [string]$Text, [int]$DelayMs = 0)
  foreach ($character in $Text.ToCharArray()) {
    if ($character -eq "`r" -or $character -eq "`n") {
      Press-Key-Target $Hwnd 'Enter'
    } else {
      Post-Window-Message $Hwnd $WM_CHAR ([IntPtr][int][char]$character) ([IntPtr]1)
    }
    if ($DelayMs -gt 0) {
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Parse-Hotkey {
  param($InputArgs)
  if (Has-Arg $InputArgs 'keys' -and $null -ne $InputArgs.keys) {
    return @($InputArgs.keys | ForEach-Object { [string]$_ })
  }
  if (Has-Arg $InputArgs 'hotkey' -and $InputArgs.hotkey) {
    return @(([string]$InputArgs.hotkey) -split '\+')
  }
  if (Has-Arg $InputArgs 'key' -and $InputArgs.key) {
    $keyText = [string]$InputArgs.key
    if ($keyText.Contains('+')) {
      return @($keyText -split '\+')
    }
    return @((Parse-Modifier-List $InputArgs) + $keyText)
  }
  Fail 'INVALID_ARGS' 'hotkey requires keys, hotkey, or key.'
}

function Invoke-Right-Click {
  param($Target, $InputArgs)
  $point = $null
  if ((Has-Arg $InputArgs 'x') -and (Has-Arg $InputArgs 'y')) {
    $point = [ordered]@{ x = [int]$InputArgs.x; y = [int]$InputArgs.y }
  } else {
    $point = Center-Of-Rect $Target.bounds
  }
  if ($null -eq $point) {
    Fail 'INVALID_ARGS' 'right_click requires x/y or an element/window with bounds.'
  }

  $clientPoint = New-Object InterpreterWin32Uia+POINT
  $clientPoint.X = [int]$point.x
  $clientPoint.Y = [int]$point.y
  [void][InterpreterWin32Uia]::ScreenToClient($Target.hwnd, [ref]$clientPoint)
  $clientLParam = Make-LParam $clientPoint.X $clientPoint.Y
  $screenLParam = Make-LParam ([int]$point.x) ([int]$point.y)
  Post-Window-Message $Target.hwnd $WM_MOUSEMOVE ([IntPtr]0) $clientLParam
  Post-Window-Message $Target.hwnd $WM_RBUTTONDOWN ([IntPtr]$MK_RBUTTON) $clientLParam
  Post-Window-Message $Target.hwnd $WM_RBUTTONUP ([IntPtr]0) $clientLParam
  Post-Window-Message $Target.hwnd $WM_CONTEXTMENU $Target.hwnd $screenLParam
  return [ordered]@{ action = 'wm_right_click'; x = [int]$point.x; y = [int]$point.y }
}

function Capture-Window {
  param($Window, $InputArgs, [bool]$Crop)
  $cropX = if (Has-Arg $InputArgs 'x') { [int]$InputArgs.x } else { 0 }
  $cropY = if (Has-Arg $InputArgs 'y') { [int]$InputArgs.y } else { 0 }
  $cropWidth = if (Has-Arg $InputArgs 'width') { [int]$InputArgs.width } elseif ($Window.bounds) { [int]$Window.bounds.width } else { 0 }
  $cropHeight = if (Has-Arg $InputArgs 'height') { [int]$InputArgs.height } elseif ($Window.bounds) { [int]$Window.bounds.height } else { 0 }
  $base64 = [InterpreterWin32Uia]::CaptureWindowPngBase64([IntPtr][int]$Window._handle, $cropX, $cropY, $cropWidth, $cropHeight, $Crop)
  return [ordered]@{
    pid = $Window.pid
    title = $Window.title
    window_id = $Window.window_id
    mime_type = 'image/png'
    width = if ($Crop) { $cropWidth } else { [int]$Window.bounds.width }
    height = if ($Crop) { $cropHeight } else { [int]$Window.bounds.height }
    screenshot_png_b64 = $base64
    png_base64 = $base64
  }
}

function Invoke-WindowsUiaTool {
  param([string]$RequestToolName, [string]$RequestJsonArgs = '{}')
  $script:ToolName = $RequestToolName
  $script:JsonArgs = $RequestJsonArgs
try {
  $argsObject = Args-Object
  switch ($ToolName) {
    '__agent_cursor_overlay' {
      Run-Agent-Cursor-Overlay
      exit 0
    }
    'check_permissions' {
      Write-JsonResult -Ok $true -Data ([ordered]@{
        accessibility = $true
        screen_recording = $true
        note = 'Windows UI Automation does not use macOS TCC permissions. Elevated target apps may require matching elevation.'
      })
    }
    'list_windows' {
      $windows = @(Top-Level-Windows | ForEach-Object { Public-Window $_ })
      Write-JsonResult -Ok $true -Data $windows
    }
    'set_window_bounds' {
      $data = Set-Window-Bounds $argsObject
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'focus_window' {
      $data = Focus-Window $argsObject
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'close_window' {
      $data = Close-Window $argsObject
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'get_window_at_point' {
      if (!(Has-Arg $argsObject 'x') -or !(Has-Arg $argsObject 'y')) {
        Fail 'INVALID_ARGS' 'get_window_at_point requires x and y.'
      }
      $window = Window-At-Point ([int]$argsObject.x) ([int]$argsObject.y)
      Write-JsonResult -Ok $true -Data (Public-Window $window)
    }
    'get_window_state_at_point' {
      if (!(Has-Arg $argsObject 'x') -or !(Has-Arg $argsObject 'y')) {
        Fail 'INVALID_ARGS' 'get_window_state_at_point requires x and y.'
      }
      $window = Window-At-Point ([int]$argsObject.x) ([int]$argsObject.y)
      $maxDepth = if (Has-Arg $argsObject 'max_depth') { [int]$argsObject.max_depth } else { 12 }
      $maxElements = if (Has-Arg $argsObject 'max_elements') { [int]$argsObject.max_elements } else { 600 }
      $viewMode = if (Has-Arg $argsObject 'view_mode') { ([string]$argsObject.view_mode).Trim().ToLowerInvariant() } else { 'control' }
      if ($viewMode -ne 'control' -and $viewMode -ne 'raw' -and $viewMode -ne 'interactive') {
        Fail 'INVALID_ARGS' 'get_window_state_at_point view_mode must be control, raw, or interactive.'
      }
      $state = Build-Window-State $window $maxDepth $maxElements $viewMode
      $state.Remove('_elementRefs')
      Write-JsonResult -Ok $true -Data $state
    }
    'get_window_state_for_pid' {
      $window = Window-For-Pid $argsObject
      $maxDepth = if (Has-Arg $argsObject 'max_depth') { [int]$argsObject.max_depth } else { 12 }
      $maxElements = if (Has-Arg $argsObject 'max_elements') { [int]$argsObject.max_elements } else { 600 }
      $viewMode = if (Has-Arg $argsObject 'view_mode') { ([string]$argsObject.view_mode).Trim().ToLowerInvariant() } else { 'control' }
      if ($viewMode -ne 'control' -and $viewMode -ne 'raw' -and $viewMode -ne 'interactive') {
        Fail 'INVALID_ARGS' 'get_window_state_for_pid view_mode must be control, raw, or interactive.'
      }
      $state = Build-Window-State $window $maxDepth $maxElements $viewMode
      $state.Remove('_elementRefs')
      Write-JsonResult -Ok $true -Data $state
    }
    'list_apps' {
      $apps = @{}
      foreach ($window in Top-Level-Windows) {
        $key = "$($window.pid):$($window.app_name)"
        if (!$apps.ContainsKey($key)) {
          $apps[$key] = [ordered]@{
            name = $window.app_name
            pid = $window.pid
            window_count = 0
          }
        }
        $apps[$key].window_count += 1
      }
      Write-JsonResult -Ok $true -Data @($apps.Values)
    }
    'list_automation_targets' {
      $query = if (Has-Arg $argsObject 'query') { [string]$argsObject.query } else { '' }
      $limit = if (Has-Arg $argsObject 'limit') { [int]$argsObject.limit } else { 80 }
      $targets = @(Top-Level-Windows | ForEach-Object { Public-Automation-Target $_ })
      if (![string]::IsNullOrWhiteSpace($query)) {
        $targets = @($targets | Where-Object {
          $haystack = @(
            $_.app_name,
            $_.title,
            ($_.automation_channels.com.candidates | ForEach-Object { $_.progid })
          ) -join ' '
          $haystack.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
      }
      Write-JsonResult -Ok $true -Data @($targets | Select-Object -First ([Math]::Max(1, [Math]::Min(500, $limit))))
    }
    'list_com_objects' {
      $query = if (Has-Arg $argsObject 'query') { [string]$argsObject.query } else { '' }
      $limit = if (Has-Arg $argsObject 'limit') { [int]$argsObject.limit } else { 120 }
      Write-JsonResult -Ok $true -Data @(Registered-Com-Automation-Objects -Query $query -Limit $limit)
    }
    'get_window_state' {
      $window = Resolve-Window $argsObject
      if (Has-Arg $argsObject 'element_index' -and $null -ne $argsObject.element_index) {
        $resolved = Resolve-Indexed-Element $argsObject
        Write-JsonResult -Ok $true -Data (Build-Single-Element-State $resolved.window $resolved.element)
        return
      }
      if (Has-Arg $argsObject 'automation_id' -and $null -ne $argsObject.automation_id) {
        $element = Find-Element-By-Automation-Id $window ([string]$argsObject.automation_id)
        Write-JsonResult -Ok $true -Data (Build-Single-Element-State $window $element)
        return
      }
      $maxDepth = if (Has-Arg $argsObject 'max_depth') { [int]$argsObject.max_depth } else { 12 }
      $maxElements = if (Has-Arg $argsObject 'max_elements') { [int]$argsObject.max_elements } else { 600 }
      $viewMode = if (Has-Arg $argsObject 'view_mode') { ([string]$argsObject.view_mode).Trim().ToLowerInvariant() } else { 'control' }
      if ($viewMode -ne 'control' -and $viewMode -ne 'raw' -and $viewMode -ne 'interactive') {
        Fail 'INVALID_ARGS' 'get_window_state view_mode must be control, raw, or interactive.'
      }
      $state = Build-Window-State $window $maxDepth $maxElements $viewMode
      $state.Remove('_elementRefs')
      Write-JsonResult -Ok $true -Data $state
    }
    'get_window_bounds' {
      $window = Resolve-Window $argsObject
      Write-JsonResult -Ok $true -Data ([ordered]@{
        window_id = $window.window_id
        bounds = $window.bounds
        title = $window.title
        pid = $window.pid
      })
    }
    'click' {
      if (Has-Arg $argsObject 'native_hwnd' -and $null -ne $argsObject.native_hwnd) {
        $nativeHwnd = [IntPtr][int]$argsObject.native_hwnd
        if ($nativeHwnd -eq [IntPtr]::Zero) {
          Fail 'INVALID_TARGET' 'native_hwnd must be a non-zero HWND.'
        }
        if (![InterpreterWin32Uia]::IsWindow($nativeHwnd)) {
          Fail 'INVALID_TARGET' 'native_hwnd does not refer to a live window.'
        }
        $nativeClickKind = if (Has-Arg $argsObject 'native_click_kind') { [string]$argsObject.native_click_kind } else { 'point' }
        if ($nativeClickKind -eq 'button') {
          Post-Window-Message $nativeHwnd $BM_CLICK ([IntPtr]::Zero) ([IntPtr]::Zero)
          $data = [ordered]@{ action = 'wm_button_click'; native_hwnd = [int]$nativeHwnd }
        } else {
          if (!(Has-Arg $argsObject 'x') -or !(Has-Arg $argsObject 'y')) {
            Fail 'INVALID_ARGS' 'native HWND point click requires x and y.'
          }
          $clientPoint = New-Object InterpreterWin32Uia+POINT
          $clientPoint.X = [int]$argsObject.x
          $clientPoint.Y = [int]$argsObject.y
          [void][InterpreterWin32Uia]::ScreenToClient($nativeHwnd, [ref]$clientPoint)
          $clientLParam = Make-LParam $clientPoint.X $clientPoint.Y
          Post-Window-Message $nativeHwnd $WM_MOUSEMOVE ([IntPtr]0) $clientLParam
          Post-Window-Message $nativeHwnd $WM_LBUTTONDOWN ([IntPtr]$MK_LBUTTON) $clientLParam
          Post-Window-Message $nativeHwnd $WM_LBUTTONUP ([IntPtr]0) $clientLParam
          $data = [ordered]@{ action = 'wm_native_left_click'; native_hwnd = [int]$nativeHwnd; x = [int]$argsObject.x; y = [int]$argsObject.y }
        }
        if (Has-Arg $argsObject 'window_id') {
          $data.window_id = [string]$argsObject.window_id
        }
        Add-Recorded-Event $ToolName $argsObject $data
        Write-JsonResult -Ok $true -Data $data
        return
      }
      $useForeground = Has-Arg $argsObject 'bring_to_foreground' -and [bool]$argsObject.bring_to_foreground
      if (Has-Arg $argsObject 'automation_id' -and $null -ne $argsObject.automation_id -and !(Has-Arg $argsObject 'element_index')) {
        $resolved = Resolve-Action-Target $argsObject
        if ($useForeground) {
          $data = Click-Target-With-Foreground $resolved
        } else {
          [void](Show-Agent-Cursor-Target $resolved)
          $elementHwnd = if ($resolved.element) { [IntPtr][int]$resolved.element.Current.NativeWindowHandle } else { [IntPtr]::Zero }
          if ($elementHwnd -ne [IntPtr]::Zero) {
            $method = Click-Target-By-Message $resolved
          } elseif (Element-Has-Direct-Click-Pattern $resolved.element) {
            $method = Invoke-Element-For-Click $resolved.element ([IntPtr]$resolved.hwnd)
          } else {
            $method = Click-Target-By-Message $resolved
          }
          $data = [ordered]@{ action = $method }
        }
        $data.automation_id = [string]$argsObject.automation_id
        Add-Recorded-Event $ToolName $argsObject $data
        Write-JsonResult -Ok $true -Data $data
        return
      }
      $resolved = Resolve-Action-Target $argsObject
      if ($useForeground) {
        $data = Click-Target-With-Foreground $resolved
      } else {
        [void](Show-Agent-Cursor-Target $resolved)
        $hasExplicitPoint = (Has-Arg $argsObject 'x') -and (Has-Arg $argsObject 'y')
        $elementControlType = if ($resolved.element) { $resolved.element.Current.ControlType } else { $null }
        $elementHwnd = if ($resolved.element) { [IntPtr][int]$resolved.element.Current.NativeWindowHandle } else { [IntPtr]::Zero }
        if (
          !$hasExplicitPoint -and
          $resolved.element -and
          $elementControlType -eq [System.Windows.Automation.ControlType]::Button -and
          $elementHwnd -eq [IntPtr]::Zero -and
          (Element-Has-Direct-Click-Pattern $resolved.element)
        ) {
          $method = Invoke-Element-For-Click $resolved.element ([IntPtr]$resolved.hwnd)
          $data = [ordered]@{ action = $method }
        } elseif (
          !$hasExplicitPoint -and
          $resolved.element -and
          $elementControlType -eq [System.Windows.Automation.ControlType]::Button -and
          $elementHwnd -eq [IntPtr]::Zero
        ) {
          $data = Click-Target-With-Foreground $resolved
        } elseif (!$hasExplicitPoint -and $resolved.element -and $elementHwnd -ne [IntPtr]::Zero) {
          $method = Click-Target-By-Message $resolved
          $data = [ordered]@{ action = $method }
        } elseif (!$hasExplicitPoint -and (Element-Has-Direct-Click-Pattern $resolved.element)) {
          $method = Invoke-Element-For-Click $resolved.element ([IntPtr]$resolved.hwnd)
          $data = [ordered]@{ action = $method }
        } else {
          $method = Click-Target-By-Message $resolved
          $data = [ordered]@{ action = $method }
        }
      }
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      if (Has-Arg $argsObject 'automation_id') { $data.automation_id = [string]$argsObject.automation_id }
      if ((Has-Arg $argsObject 'x') -and (Has-Arg $argsObject 'y')) {
        $data.x = [int]$argsObject.x
        $data.y = [int]$argsObject.y
      }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'drag' {
      if (!(Has-Arg $argsObject 'from_x') -or !(Has-Arg $argsObject 'from_y') -or !(Has-Arg $argsObject 'to_x') -or !(Has-Arg $argsObject 'to_y')) {
        Fail 'INVALID_ARGS' 'drag requires from_x, from_y, to_x, and to_y.'
      }
      $window = Resolve-Window $argsObject
      [InterpreterWin32Uia]::ShowWindowAsync([IntPtr][int]$window._handle, 5) | Out-Null
      [InterpreterWin32Uia]::BringWindowToTop([IntPtr][int]$window._handle) | Out-Null
      [InterpreterWin32Uia]::SetForegroundWindow([IntPtr][int]$window._handle) | Out-Null
      [InterpreterWin32Uia]::SendForegroundLeftDrag(
        [int]$argsObject.from_x,
        [int]$argsObject.from_y,
        [int]$argsObject.to_x,
        [int]$argsObject.to_y
      )
      $data = [ordered]@{
        action = 'foreground_left_drag'
        from_x = [int]$argsObject.from_x
        from_y = [int]$argsObject.from_y
        to_x = [int]$argsObject.to_x
        to_y = [int]$argsObject.to_y
      }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'double_click' {
      $resolved = Resolve-Action-Target $argsObject
      [void](Show-Agent-Cursor-Target $resolved)
      $method = Invoke-Element $resolved.element
      $method = Invoke-Element $resolved.element
      $data = [ordered]@{ action = "double_$method" }
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      if (Has-Arg $argsObject 'automation_id') { $data.automation_id = [string]$argsObject.automation_id }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'set_value' {
      $resolved = Resolve-Action-Target $argsObject
      [void](Show-Agent-Cursor-Target $resolved 'typing' ([string]$argsObject.value))
      $method = Try-Set-Target-Value $resolved ([string]$argsObject.value)
      if ($null -eq $method) {
        Fail 'ACTION_UNSUPPORTED' 'Element does not support background-safe value setting.'
      }
      $data = [ordered]@{ action = $method; value = [string]$argsObject.value }
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      if (Has-Arg $argsObject 'automation_id') { $data.automation_id = [string]$argsObject.automation_id }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'type_text' {
      $target = Resolve-Action-Target $argsObject
      [void](Show-Agent-Cursor-Target $target 'typing' ([string]$argsObject.text))
      $useForeground = Has-Arg $argsObject 'bring_to_foreground' -and [bool]$argsObject.bring_to_foreground
      if ($useForeground) {
        $method = Type-Target-Text-With-ForegroundKeyboard $target ([string]$argsObject.text) $true
      } else {
        $method = Try-Set-Target-Value $target ([string]$argsObject.text)
      }
      if ($null -eq $method) {
        Fail 'ACTION_UNSUPPORTED' 'Element does not support background-safe text setting.'
      }
      $data = [ordered]@{ action = $method; value = [string]$argsObject.text }
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      if (Has-Arg $argsObject 'automation_id') { $data.automation_id = [string]$argsObject.automation_id }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'type_text_chars' {
      $target = Resolve-Action-Target $argsObject
      [void](Show-Agent-Cursor-Target $target 'typing' ([string]$argsObject.text))
      $delayMs = if (Has-Arg $argsObject 'delay_ms') { [int]$argsObject.delay_ms } else { 0 }
      $method = $null
      if ($target.element) {
        $method = Append-Element-Text $target.element ([string]$argsObject.text)
      }
      if ($null -eq $method) {
        $keyboardHwnd = Resolve-Keyboard-Hwnd $target
        Post-Window-Text-Chars $keyboardHwnd ([string]$argsObject.text) $delayMs
        $method = 'wm_char'
      }
      $data = [ordered]@{ action = $method; value = [string]$argsObject.text }
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      if (Has-Arg $argsObject 'automation_id') { $data.automation_id = [string]$argsObject.automation_id }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'select_option' {
      $resolved = Resolve-Indexed-Element $argsObject
      $maxElements = if (Has-Arg $argsObject 'max_elements') { [int]$argsObject.max_elements } else { 2000 }
      $data = Select-Option-For-Element $resolved.window $resolved.element ([string]$argsObject.option_text) $maxElements
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      if (Has-Arg $argsObject 'automation_id') { $data.automation_id = [string]$argsObject.automation_id }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'select_option_at_point' {
      if (!(Has-Arg $argsObject 'x') -or !(Has-Arg $argsObject 'y')) {
        Fail 'INVALID_ARGS' 'select_option_at_point requires x and y.'
      }
      $window = Resolve-Window $argsObject
      $maxElements = if (Has-Arg $argsObject 'max_elements') { [int]$argsObject.max_elements } else { 2000 }
      $data = Select-Option-At-Point $window ([int]$argsObject.x) ([int]$argsObject.y) ([string]$argsObject.option_text) $maxElements
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'select_visible_option' {
      $nearBounds = $null
      if (Has-Arg $argsObject 'near_bounds' -and $null -ne $argsObject.near_bounds) {
        $nearBounds = $argsObject.near_bounds
      }
      $data = Select-Visible-Option-ByName ([string]$argsObject.option_text) $nearBounds
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'scroll' {
      $resolved = Resolve-Action-Target $argsObject
      [void](Show-Agent-Cursor-Target $resolved 'scroll' ([string]$argsObject.direction))
      $scroll = Element-Scroll-Pattern-Or-Null $resolved.element
      if ($null -eq $scroll) { Fail 'ACTION_UNSUPPORTED' 'Element does not support ScrollPattern.' }
      $direction = [string]$argsObject.direction
      $amount = if ($argsObject.amount) { [int]$argsObject.amount } else { 1 }
      for ($i = 0; $i -lt $amount; $i++) {
        if ($direction -eq 'up') {
          $scroll.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::SmallDecrement)
        } elseif ($direction -eq 'down') {
          $scroll.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::SmallIncrement)
        } elseif ($direction -eq 'left') {
          $scroll.Scroll([System.Windows.Automation.ScrollAmount]::SmallDecrement, [System.Windows.Automation.ScrollAmount]::NoAmount)
        } else {
          $scroll.Scroll([System.Windows.Automation.ScrollAmount]::SmallIncrement, [System.Windows.Automation.ScrollAmount]::NoAmount)
        }
      }
      $data = [ordered]@{ action = 'scroll' }
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      if (Has-Arg $argsObject 'automation_id') { $data.automation_id = [string]$argsObject.automation_id }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'get_screen_size' {
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      Write-JsonResult -Ok $true -Data ([ordered]@{ width = $bounds.Width; height = $bounds.Height })
    }
    'get_cursor_position' {
      $point = [System.Windows.Forms.Cursor]::Position
      Write-JsonResult -Ok $true -Data ([ordered]@{ x = $point.X; y = $point.Y })
    }
    'get_config' {
      $state = Read-Driver-State
      Write-JsonResult -Ok $true -Data $state.config
    }
    'get_agent_cursor_state' {
      $state = Read-Driver-State
      if ([bool]$state.agent_cursor.enabled) {
        $state = Start-Agent-Cursor-Overlay $state
      } else {
        $state = Refresh-Agent-Cursor-Overlay-State $state
        Write-Driver-State $state
      }
      Write-JsonResult -Ok $true -Data $state.agent_cursor
    }
    'get_recording_state' {
      $state = Read-Driver-State
      Write-JsonResult -Ok $true -Data $state.recording
    }
    'press_key' {
      $target = Resolve-Action-Target $argsObject
      $key = if (Has-Arg $argsObject 'key') { [string]$argsObject.key } else { Fail 'INVALID_ARGS' 'press_key requires key.' }
      [void](Show-Agent-Cursor-Target $target 'key' $key)
      $method = $null
      if (!(Has-Arg $argsObject 'modifiers') -and $target.element) {
        $method = Try-Edit-Control-Key $target.element $key
      }
      if ($null -eq $method) {
        $keyboardHwnd = Resolve-Keyboard-Hwnd $target
        Press-Key-Target $keyboardHwnd $key (Parse-Modifier-List $argsObject)
        $method = 'wm_key'
      }
      $data = [ordered]@{ action = $method; key = $key }
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'hotkey' {
      $target = Resolve-Action-Target $argsObject
      $parts = @(Parse-Hotkey $argsObject | Where-Object { ![string]::IsNullOrWhiteSpace([string]$_) })
      if ($parts.Count -lt 1) { Fail 'INVALID_ARGS' 'hotkey requires at least one key.' }
      [void](Show-Agent-Cursor-Target $target 'hotkey' (($parts | ForEach-Object { [string]$_ }) -join '+'))
      $key = [string]$parts[$parts.Count - 1]
      $modifiers = @()
      if ($parts.Count -gt 1) {
        $modifiers = @($parts[0..($parts.Count - 2)] | ForEach-Object { [string]$_ })
      }
      $keyboardHwnd = Resolve-Keyboard-Hwnd $target
      Press-Key-Target $keyboardHwnd $key $modifiers
      $data = [ordered]@{ action = 'wm_hotkey'; key = $key; modifiers = $modifiers }
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'move_cursor' {
      $state = Read-Driver-State
      $target = Resolve-Action-Target $argsObject
      $point = if ((Has-Arg $argsObject 'x') -and (Has-Arg $argsObject 'y')) {
        [ordered]@{ x = [int]$argsObject.x; y = [int]$argsObject.y }
      } else {
        Center-Of-Rect $target.bounds
      }
      if ($null -eq $point) { Fail 'INVALID_ARGS' 'move_cursor requires x/y or a bounded target.' }
      $state = Set-Agent-Cursor-Position $state $point ([IntPtr][int]$target.window._handle)
      $data = [ordered]@{
        action = 'agent_cursor_move'
        x = [int]$point.x
        y = [int]$point.y
        rendered = [bool]$state.agent_cursor.rendered
        overlay_pid = $state.agent_cursor.overlay_pid
        real_cursor_moved = $false
      }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'right_click' {
      $target = Resolve-Action-Target $argsObject
      $cursorPoint = if ((Has-Arg $argsObject 'x') -and (Has-Arg $argsObject 'y')) {
        [ordered]@{ x = [int]$argsObject.x; y = [int]$argsObject.y }
      } else {
        Center-Of-Rect $target.bounds
      }
      if ($null -ne $cursorPoint) {
        [void](Set-Agent-Cursor-Position (Read-Driver-State) $cursorPoint ([IntPtr][int]$target.window._handle))
      }
      $data = Invoke-Right-Click $target $argsObject
      if (Has-Arg $argsObject 'element_index') { $data.element_index = [int]$argsObject.element_index }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'com_automation' {
      $data = Invoke-Com-Automation $argsObject
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'replay_trajectory' {
      $events = @()
      if (Has-Arg $argsObject 'events' -and $null -ne $argsObject.events) {
        $events = @($argsObject.events)
      } elseif (Has-Arg $argsObject 'trajectory' -and $null -ne $argsObject.trajectory) {
        $events = @($argsObject.trajectory)
      } else {
        $state = Read-Driver-State
        $events = @($state.recording.events)
      }
      $allowed = @('click', 'double_click', 'set_value', 'type_text', 'type_text_chars', 'select_option', 'select_visible_option', 'scroll', 'press_key', 'hotkey', 'move_cursor', 'right_click')
      $results = @()
      foreach ($event in $events) {
        $eventTool = [string]$event.tool
        if ($allowed -notcontains $eventTool) {
          Fail 'ACTION_UNSUPPORTED' "Cannot replay unsupported Windows trajectory event '$eventTool'."
        }
        $eventArgsJson = $event.args | ConvertTo-Json -Depth 80 -Compress
        $output = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath $eventTool $eventArgsJson
        $results += [ordered]@{ tool = $eventTool; output = [string]$output }
      }
      Write-JsonResult -Ok $true -Data ([ordered]@{ action = 'replay_trajectory'; count = $events.Count; results = $results })
    }
    'launch_app' {
      $targetPath = if (Has-Arg $argsObject 'path') { [string]$argsObject.path } elseif (Has-Arg $argsObject 'app') { [string]$argsObject.app } elseif (Has-Arg $argsObject 'executable') { [string]$argsObject.executable } else { '' }
      if ([string]::IsNullOrWhiteSpace($targetPath)) {
        Fail 'INVALID_ARGS' 'launch_app requires path, app, or executable on Windows.'
      }
      $windowStyleName = if (Has-Arg $argsObject 'window_style') { ([string]$argsObject.window_style).Trim().ToLowerInvariant() } else { 'minimized' }
      $windowStyle = switch ($windowStyleName) {
        'normal' { [System.Diagnostics.ProcessWindowStyle]::Normal }
        'minimized' { [System.Diagnostics.ProcessWindowStyle]::Minimized }
        'maximized' { [System.Diagnostics.ProcessWindowStyle]::Maximized }
        'hidden' { [System.Diagnostics.ProcessWindowStyle]::Hidden }
        default { Fail 'INVALID_ARGS' "launch_app window_style must be normal, minimized, maximized, or hidden." }
      }
      $startInfo = New-Object System.Diagnostics.ProcessStartInfo
      $startInfo.FileName = $targetPath
      if (Has-Arg $argsObject 'arguments' -and $argsObject.arguments) { $startInfo.Arguments = [string]$argsObject.arguments }
      $startInfo.UseShellExecute = $true
      $startInfo.WindowStyle = $windowStyle
      $process = [System.Diagnostics.Process]::Start($startInfo)
      $data = [ordered]@{ action = 'launch_app'; pid = $process.Id; path = $targetPath; window_style = $windowStyleName }
      Add-Recorded-Event $ToolName $argsObject $data
      Write-JsonResult -Ok $true -Data $data
    }
    'screenshot' {
      $window = Resolve-Window $argsObject
      Write-JsonResult -Ok $true -Data (Capture-Window $window $argsObject $false)
    }
    'zoom' {
      $window = Resolve-Window $argsObject
      Write-JsonResult -Ok $true -Data (Capture-Window $window $argsObject $true)
    }
    'get_accessibility_tree' {
      $window = Resolve-Window $argsObject
      $state = Build-Window-State $window
      $state.Remove('_elementRefs')
      Write-JsonResult -Ok $true -Data $state
    }
    'set_config' {
      $state = Read-Driver-State
      $key = if (Has-Arg $argsObject 'key') { [string]$argsObject.key } else { Fail 'INVALID_ARGS' 'set_config requires key.' }
      $value = if (Has-Arg $argsObject 'value') { $argsObject.value } else { Fail 'INVALID_ARGS' 'set_config requires value.' }
      Set-State-Property $state.config $key $value
      Write-Driver-State $state
      Write-JsonResult -Ok $true -Data $state.config
    }
    'set_recording' {
      $state = Read-Driver-State
      $enabled = if (Has-Arg $argsObject 'enabled') { [bool]$argsObject.enabled } else { !$state.recording.enabled }
      $state.recording.enabled = $enabled
      $state.recording.supported = $true
      if ($enabled -and !(Has-Arg $argsObject 'append' -and [bool]$argsObject.append)) {
        $state.recording.events = @()
      }
      Write-Driver-State $state
      Write-JsonResult -Ok $true -Data $state.recording
    }
    'set_agent_cursor_enabled' {
      $state = Read-Driver-State
      $enabled = if (Has-Arg $argsObject 'enabled') { [bool]$argsObject.enabled } else { ![bool]$state.agent_cursor.enabled }
      Set-State-Property $state.agent_cursor 'enabled' $enabled
      Set-State-Property $state.agent_cursor 'supported' $true
      if ($enabled) {
        $state = Start-Agent-Cursor-Overlay $state
      } else {
        $state = Stop-Agent-Cursor-Overlay $state
      }
      Write-JsonResult -Ok $true -Data $state.agent_cursor
    }
    'set_agent_cursor_motion' {
      $state = Read-Driver-State
      foreach ($property in $argsObject.PSObject.Properties) {
        Set-State-Property $state.agent_cursor.motion $property.Name $property.Value
      }
      if ([bool]$state.agent_cursor.enabled) {
        $state = Start-Agent-Cursor-Overlay $state
      } else {
        Write-Driver-State $state
      }
      Write-JsonResult -Ok $true -Data $state.agent_cursor
    }
    default {
      Fail 'TOOL_UNSUPPORTED' "Windows UIA backend does not support '$ToolName' yet."
    }
  }
} catch {
  $message = $_.Exception.Message
  if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
    $message = "$message`n$($_.InvocationInfo.PositionMessage)"
  }
  Fail 'WINDOWS_UIA_ERROR' $message
}
}

function Run-WindowsUiaDriverDaemon {
  $script:WINDOWS_UIA_DAEMON_MODE = $true
  Initialize-Agent-Cursor-Session
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $requestId = $null
    try {
      $request = $line | ConvertFrom-Json
      $requestId = if ($request.PSObject.Properties.Name -contains 'id') { [string]$request.id } else { $null }
      $requestTool = if ($request.PSObject.Properties.Name -contains 'tool') { [string]$request.tool } else { '' }
      $requestArgsJson = if ($request.PSObject.Properties.Name -contains 'args' -and $null -ne $request.args) {
        $request.args | ConvertTo-Json -Depth 80 -Compress
      } else {
        '{}'
      }
      $output = @(Invoke-WindowsUiaTool $requestTool $requestArgsJson)
      $stdout = ($output | Out-String).Trim()
      $response = [ordered]@{
        id = $requestId
        ok = $true
        stdout = $stdout
        stderr = ''
      }
      [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 80 -Compress))
      [Console]::Out.Flush()
    } catch {
      $message = $_.Exception.Message
      $response = [ordered]@{
        id = $requestId
        ok = $false
        stdout = ''
        stderr = $message
      }
      [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 80 -Compress))
      [Console]::Out.Flush()
    }
  }
}

if ($ToolName -eq '__driver_daemon') {
  Run-WindowsUiaDriverDaemon
  exit 0
}

Invoke-WindowsUiaTool $ToolName $JsonArgs
exit 0
