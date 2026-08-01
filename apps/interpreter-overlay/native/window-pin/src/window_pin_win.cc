// In-process Windows pinning + enumeration for the world overlay.
//
// Mirror of the macOS pinning surface (window_pin_mac.mm), built around the
// Win32 z-order primitives:
//
//   pinAbove(hwndBuffer, targetHwndId)
//     SetWindowPos(ourHwnd, HWND_BOTTOM, ...)         // drop to back
//     SetWindowPos(ourHwnd, targetHwnd,    ...)       // re-insert directly
//                                                       above target
//
// The two-step is exactly the macOS orderBack-then-orderAbove fix: SetWindowPos
// silently no-ops if the source window is already above the target, so once a
// foreign app raises above the target we'd never slip below it on the next
// repin. Forcing HWND_BOTTOM first guarantees re-insertion every tick.
//
// In addition this file exposes the small Win32 enumeration surface the world
// overlay needs (windowAtPoint, frontmostByPid, watchFrontmostByPid). On
// macOS those live in a separate Swift CLI; on Windows it's cheaper to keep
// them in the addon since we already need its build pipeline.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dwmapi.h>
#include <psapi.h>
#include <string>
#include <vector>
#include <atomic>
#include <thread>
#include <chrono>
#include <algorithm>
#include <cmath>
#include <napi.h>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "psapi.lib")

namespace {

HWND HWNDFromBuffer(const Napi::Buffer<char> &buffer) {
  if (buffer.Length() < sizeof(HWND)) return nullptr;
  HWND hwnd = nullptr;
  memcpy(&hwnd, buffer.Data(), sizeof(HWND));
  return hwnd;
}

std::wstring Utf8ToWide(const std::string &input) {
  if (input.empty()) return L"";
  int needed = MultiByteToWideChar(CP_UTF8, 0, input.data(), (int)input.size(), nullptr, 0);
  std::wstring out(needed, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, input.data(), (int)input.size(), out.data(), needed);
  return out;
}

std::string WideToUtf8(const std::wstring &input) {
  if (input.empty()) return std::string();
  int needed = WideCharToMultiByte(CP_UTF8, 0, input.data(), (int)input.size(), nullptr, 0, nullptr, nullptr);
  std::string out(needed, '\0');
  WideCharToMultiByte(CP_UTF8, 0, input.data(), (int)input.size(), out.data(), needed, nullptr, nullptr);
  return out;
}

std::string GetProcessImageBase(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return std::string();
  wchar_t path[MAX_PATH] = {0};
  DWORD len = MAX_PATH;
  std::string out;
  if (QueryFullProcessImageNameW(h, 0, path, &len)) {
    std::wstring w(path, len);
    auto slash = w.find_last_of(L"\\/");
    if (slash != std::wstring::npos) w = w.substr(slash + 1);
    auto dot = w.find_last_of(L'.');
    if (dot != std::wstring::npos) w = w.substr(0, dot);
    out = WideToUtf8(w);
  }
  CloseHandle(h);
  return out;
}

std::string GetWindowTitleUtf8(HWND hwnd) {
  int len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return std::string();
  std::wstring buf(len + 1, L'\0');
  GetWindowTextW(hwnd, buf.data(), len + 1);
  buf.resize(wcslen(buf.c_str()));
  return WideToUtf8(buf);
}

bool IsTopLevelVisible(HWND hwnd) {
  if (!IsWindow(hwnd)) return false;
  if (!IsWindowVisible(hwnd)) return false;
  if (IsIconic(hwnd)) return false;
  // Skip cloaked windows (UWP placeholder, virtual desktop hidden).
  BOOL cloaked = FALSE;
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, /*DWMWA_CLOAKED*/ 14, &cloaked, sizeof(cloaked))) && cloaked) {
    return false;
  }
  return GetWindow(hwnd, GW_OWNER) == nullptr;
}

bool IsWindowTopmost(HWND hwnd) {
  return (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
}

bool IsIgnoredOwner(const std::string &owner, const std::string &title = std::string()) {
  bool isShell = (owner == "explorer" || owner == "ShellExperienceHost" ||
                  owner == "TextInputHost" || owner == "SystemSettings" ||
                  owner == "ApplicationFrameHost");
  bool isElectron = (owner == "Electron" || owner == "interpreter" ||
                     owner.find("Interpreter") != std::string::npos);
  return isShell || isElectron;
}

bool IsIgnoredWindow(HWND hwnd) {
  if (!hwnd || !IsWindow(hwnd)) return true;
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  return IsIgnoredOwner(GetProcessImageBase(pid), GetWindowTitleUtf8(hwnd));
}

// -- Pinning -----------------------------------------------------------------

Napi::Value PinAbove(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "pinAbove(handleBuffer, targetHwnd)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<char> handle = info[0].As<Napi::Buffer<char>>();
  uintptr_t targetRaw = (uintptr_t)info[1].As<Napi::Number>().Int64Value();
  HWND target = (HWND)targetRaw;
  if (!target || !IsWindow(target)) return Napi::Boolean::New(env, false);
  HWND ours = HWNDFromBuffer(handle);
  if (!ours || !IsWindow(ours)) return Napi::Boolean::New(env, false);

  // Make sure we're never marked TOPMOST — a topmost window can't sit below
  // a non-topmost foreign app, which would defeat the whole point.
  LONG_PTR ex = GetWindowLongPtrW(ours, GWL_EXSTYLE);
  if (ex & WS_EX_TOPMOST) {
    SetWindowPos(ours, HWND_NOTOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  // Drop to bottom, then re-insert above the target. Skip our own/system UI
  // windows as insertion points so they cannot sit between the target and
  // overlay.
  SetWindowPos(ours, HWND_BOTTOM, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  HWND insertAfter = GetWindow(target, GW_HWNDPREV);
  while (insertAfter && IsIgnoredWindow(insertAfter)) {
    insertAfter = GetWindow(insertAfter, GW_HWNDPREV);
  }
  if (!insertAfter) insertAfter = HWND_TOP;
  BOOL ok = SetWindowPos(ours, insertAfter, 0, 0, 0, 0,
                         SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  return Napi::Boolean::New(env, ok ? true : false);
}

Napi::Value SetWindowLevelNormal(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "setWindowLevelNormal(handleBuffer)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<char> handle = info[0].As<Napi::Buffer<char>>();
  HWND ours = HWNDFromBuffer(handle);
  if (!ours || !IsWindow(ours)) return Napi::Boolean::New(env, false);
  LONG_PTR ex = GetWindowLongPtrW(ours, GWL_EXSTYLE);
  if (ex & WS_EX_TOPMOST) {
    SetWindowPos(ours, HWND_NOTOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value GetWindowNumber(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "getWindowNumber(handleBuffer)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<char> handle = info[0].As<Napi::Buffer<char>>();
  HWND ours = HWNDFromBuffer(handle);
  return Napi::Number::New(env, ours ? (double)(intptr_t)ours : 0);
}

// -- Diagnostics -------------------------------------------------------------

Napi::Value DescribeZOrder(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "describeZOrder(handleBuffer)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<char> handle = info[0].As<Napi::Buffer<char>>();
  HWND ours = HWNDFromBuffer(handle);
  Napi::Object out = Napi::Object::New(env);
  if (!ours) {
    out.Set("ok", Napi::Boolean::New(env, false));
    return out;
  }
  // Walk top→bottom from the topmost window, collecting everything until we
  // hit ours. Skip non-visible/cloaked/owned windows so the list reflects what
  // a user actually sees on screen.
  Napi::Array windowsAbove = Napi::Array::New(env);
  uint32_t aboveCount = 0;
  HWND cursor = GetTopWindow(nullptr);
  bool found = false;
  long index = 0;
  while (cursor) {
    if (cursor == ours) { found = true; break; }
    if (IsTopLevelVisible(cursor)) {
      DWORD pid = 0;
      GetWindowThreadProcessId(cursor, &pid);
      Napi::Object item = Napi::Object::New(env);
      item.Set("hwnd", Napi::Number::New(env, (double)(intptr_t)cursor));
      item.Set("pid", Napi::Number::New(env, (double)pid));
      item.Set("owner", Napi::String::New(env, GetProcessImageBase(pid)));
      item.Set("title", Napi::String::New(env, GetWindowTitleUtf8(cursor)));
      item.Set("topmost", Napi::Boolean::New(env, IsWindowTopmost(cursor)));
      windowsAbove.Set(aboveCount++, item);
      index++;
    }
    cursor = GetWindow(cursor, GW_HWNDNEXT);
  }
  out.Set("ok", Napi::Boolean::New(env, true));
  out.Set("worldHwnd", Napi::Number::New(env, (double)(intptr_t)ours));
  out.Set("worldTopmost", Napi::Boolean::New(env, IsWindowTopmost(ours)));
  out.Set("worldFound", Napi::Boolean::New(env, found));
  out.Set("worldIndexInOnScreenList", Napi::Number::New(env, found ? (double)index : -1.0));
  out.Set("windowsAbove", windowsAbove);
  return out;
}

// -- Enumeration surface -----------------------------------------------------

struct Excluded {
  std::vector<DWORD> pids;
};

bool ExcludesPid(const Excluded &e, DWORD pid) {
  for (DWORD p : e.pids) if (p == pid) return true;
  return false;
}

Excluded BuildExcludedFromOptions(const Napi::Object &opts) {
  Excluded e;
  if (opts.Has("excludePids")) {
    Napi::Value v = opts.Get("excludePids");
    if (v.IsArray()) {
      Napi::Array arr = v.As<Napi::Array>();
      for (uint32_t i = 0; i < arr.Length(); i++) {
        Napi::Value el = arr.Get(i);
        if (el.IsNumber()) e.pids.push_back((DWORD)el.As<Napi::Number>().Uint32Value());
      }
    }
  }
  return e;
}

Napi::Object DescribeWindow(Napi::Env env, HWND hwnd) {
  Napi::Object o = Napi::Object::New(env);
  RECT r{0,0,0,0};
  GetWindowRect(hwnd, &r);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  o.Set("hwnd", Napi::Number::New(env, (double)(intptr_t)hwnd));
  o.Set("pid", Napi::Number::New(env, (double)pid));
  o.Set("owner", Napi::String::New(env, GetProcessImageBase(pid)));
  o.Set("title", Napi::String::New(env, GetWindowTitleUtf8(hwnd)));
  Napi::Object bounds = Napi::Object::New(env);
  bounds.Set("x", Napi::Number::New(env, (double)r.left));
  bounds.Set("y", Napi::Number::New(env, (double)r.top));
  bounds.Set("width", Napi::Number::New(env, (double)(r.right - r.left)));
  bounds.Set("height", Napi::Number::New(env, (double)(r.bottom - r.top)));
  o.Set("bounds", bounds);
  return o;
}

HWND UsableRootWindowAtPoint(POINT p, const Excluded &excluded) {
  HWND hit = WindowFromPoint(p);
  if (!hit) return nullptr;
  HWND root = GetAncestor(hit, GA_ROOT);
  if (!root || !IsTopLevelVisible(root)) return nullptr;
  DWORD pid = 0;
  GetWindowThreadProcessId(root, &pid);
  if (ExcludesPid(excluded, pid)) return nullptr;
  if (IsIgnoredOwner(GetProcessImageBase(pid), GetWindowTitleUtf8(root))) return nullptr;
  RECT r;
  if (!GetWindowRect(root, &r)) return nullptr;
  if (p.x < r.left || p.x >= r.right || p.y < r.top || p.y >= r.bottom) return nullptr;
  return root;
}

Napi::Value WindowAtPoint(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "windowAtPoint(x, y, opts?)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  POINT p{(LONG)info[0].As<Napi::Number>().Int32Value(),
          (LONG)info[1].As<Napi::Number>().Int32Value()};
  Excluded excluded;
  if (info.Length() >= 3 && info[2].IsObject()) {
    excluded = BuildExcludedFromOptions(info[2].As<Napi::Object>());
  }
  // Prefer the OS hit-test result. It respects transparent/click-through
  // surfaces better than a plain z-order rectangle walk, which can otherwise
  // select an invisible host window that happens to cover the point.
  HWND hitRoot = UsableRootWindowAtPoint(p, excluded);
  if (hitRoot) {
    return DescribeWindow(env, hitRoot);
  }
  // Walk top→bottom and pick the first non-excluded, visible top-level window
  // whose rect contains (x, y). Skips our own pids and obvious system chrome.
  HWND cursor = GetTopWindow(nullptr);
  while (cursor) {
    if (IsTopLevelVisible(cursor)) {
      DWORD pid = 0;
      GetWindowThreadProcessId(cursor, &pid);
      if (!ExcludesPid(excluded, pid)) {
        std::string owner = GetProcessImageBase(pid);
        if (!IsIgnoredOwner(owner, GetWindowTitleUtf8(cursor))) {
          RECT r;
          if (GetWindowRect(cursor, &r) &&
              p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom) {
            return DescribeWindow(env, cursor);
          }
        }
      }
    }
    cursor = GetWindow(cursor, GW_HWNDNEXT);
  }
  return env.Null();
}

Napi::Value FrontmostByPid(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "frontmostByPid(pid)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  DWORD targetPid = (DWORD)info[0].As<Napi::Number>().Uint32Value();
  HWND cursor = GetTopWindow(nullptr);
  while (cursor) {
    if (IsTopLevelVisible(cursor)) {
      DWORD pid = 0;
      GetWindowThreadProcessId(cursor, &pid);
      if (pid == targetPid) {
        return DescribeWindow(env, cursor);
      }
    }
    cursor = GetWindow(cursor, GW_HWNDNEXT);
  }
  return env.Null();
}

Napi::Value WindowBoundsByHwnd(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "windowBoundsByHwnd(hwnd)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  HWND hwnd = (HWND)(uintptr_t)info[0].As<Napi::Number>().Int64Value();
  if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return env.Null();
  return DescribeWindow(env, hwnd);
}

Napi::Value PostButtonClick(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "postButtonClick(hwnd)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  HWND hwnd = (HWND)(uintptr_t)info[0].As<Napi::Number>().Int64Value();
  if (!IsWindow(hwnd)) return Napi::Boolean::New(env, false);
  return Napi::Boolean::New(env, PostMessageW(hwnd, BM_CLICK, 0, 0) != 0);
}

Napi::Value PostLeftClick(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "postLeftClick(hwnd, screenX, screenY)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  HWND hwnd = (HWND)(uintptr_t)info[0].As<Napi::Number>().Int64Value();
  if (!IsWindow(hwnd)) return Napi::Boolean::New(env, false);
  POINT point{
      (LONG)std::lround(info[1].As<Napi::Number>().DoubleValue()),
      (LONG)std::lround(info[2].As<Napi::Number>().DoubleValue()),
  };
  ScreenToClient(hwnd, &point);
  LPARAM lparam = MAKELPARAM(point.x, point.y);
  bool ok = true;
  ok = PostMessageW(hwnd, WM_MOUSEMOVE, 0, lparam) != 0 && ok;
  ok = PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lparam) != 0 && ok;
  ok = PostMessageW(hwnd, WM_LBUTTONUP, 0, lparam) != 0 && ok;
  return Napi::Boolean::New(env, ok);
}

// -- Async watch loop --------------------------------------------------------
//
// The mac side exposes `watch` via a long-running Swift CLI streaming over
// stdout. On Windows we keep that lifecycle in-process: a worker thread polls
// the frontmost window owned by the target pid and posts updates back to the
// JS thread via a ThreadSafeFunction.

struct WatchContext {
  std::atomic<bool> running{true};
  std::thread thread;
  Napi::ThreadSafeFunction tsfn;
  DWORD pid = 0;
  int intervalMs = 33;
};

void WatcherThread(WatchContext *ctx) {
  HWND lastHwnd = nullptr;
  RECT lastRect{0,0,0,0};
  while (ctx->running.load()) {
    HWND found = nullptr;
    HWND cursor = GetTopWindow(nullptr);
    while (cursor) {
      if (IsTopLevelVisible(cursor)) {
        DWORD pid = 0;
        GetWindowThreadProcessId(cursor, &pid);
        if (pid == ctx->pid) { found = cursor; break; }
      }
      cursor = GetWindow(cursor, GW_HWNDNEXT);
    }
    bool changed = false;
    RECT r{0,0,0,0};
    if (found && GetWindowRect(found, &r)) {
      if (found != lastHwnd ||
          r.left != lastRect.left || r.top != lastRect.top ||
          r.right != lastRect.right || r.bottom != lastRect.bottom) {
        changed = true;
        lastHwnd = found;
        lastRect = r;
      }
    } else {
      if (lastHwnd != nullptr) {
        changed = true;
        lastHwnd = nullptr;
        lastRect = RECT{0,0,0,0};
      }
    }
    if (changed) {
      HWND emitHwnd = found;
      RECT emitRect = r;
      DWORD emitPid = ctx->pid;
      auto callback = [emitHwnd, emitRect, emitPid](Napi::Env env, Napi::Function jsCallback) {
        Napi::Object payload = Napi::Object::New(env);
        if (emitHwnd) {
          payload.Set("kind", Napi::String::New(env, "update"));
          payload.Set("hwnd", Napi::Number::New(env, (double)(intptr_t)emitHwnd));
          payload.Set("pid", Napi::Number::New(env, (double)emitPid));
          Napi::Object bounds = Napi::Object::New(env);
          bounds.Set("x", Napi::Number::New(env, (double)emitRect.left));
          bounds.Set("y", Napi::Number::New(env, (double)emitRect.top));
          bounds.Set("width", Napi::Number::New(env, (double)(emitRect.right - emitRect.left)));
          bounds.Set("height", Napi::Number::New(env, (double)(emitRect.bottom - emitRect.top)));
          payload.Set("bounds", bounds);
        } else {
          payload.Set("kind", Napi::String::New(env, "gone"));
        }
        jsCallback.Call({payload});
      };
      ctx->tsfn.NonBlockingCall(callback);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(ctx->intervalMs));
  }
}

class Watcher : public Napi::ObjectWrap<Watcher> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function ctor = DefineClass(env, "WindowWatcher", {
      InstanceMethod("stop", &Watcher::Stop),
    });
    exports.Set("WindowWatcher", ctor);
    return exports;
  }
  Watcher(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Watcher>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsFunction()) {
      Napi::TypeError::New(env, "new WindowWatcher(pid, intervalMs, onEvent)").ThrowAsJavaScriptException();
      return;
    }
    ctx_ = new WatchContext();
    ctx_->pid = (DWORD)info[0].As<Napi::Number>().Uint32Value();
    ctx_->intervalMs = std::max(16, info[1].As<Napi::Number>().Int32Value());
    ctx_->tsfn = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(), "WindowWatcher", 0, 1);
    ctx_->thread = std::thread(WatcherThread, ctx_);
  }
  ~Watcher() {
    StopInternal();
  }
  Napi::Value Stop(const Napi::CallbackInfo &info) {
    StopInternal();
    return info.Env().Undefined();
  }
private:
  void StopInternal() {
    if (!ctx_) return;
    ctx_->running.store(false);
    if (ctx_->thread.joinable()) ctx_->thread.join();
    ctx_->tsfn.Release();
    delete ctx_;
    ctx_ = nullptr;
  }
  WatchContext *ctx_ = nullptr;
};

}  // namespace

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("pinAbove", Napi::Function::New(env, PinAbove));
  exports.Set("setWindowLevelNormal", Napi::Function::New(env, SetWindowLevelNormal));
  exports.Set("getWindowNumber", Napi::Function::New(env, GetWindowNumber));
  exports.Set("describeZOrder", Napi::Function::New(env, DescribeZOrder));
  exports.Set("windowAtPoint", Napi::Function::New(env, WindowAtPoint));
  exports.Set("frontmostByPid", Napi::Function::New(env, FrontmostByPid));
  exports.Set("windowBoundsByHwnd", Napi::Function::New(env, WindowBoundsByHwnd));
  exports.Set("postButtonClick", Napi::Function::New(env, PostButtonClick));
  exports.Set("postLeftClick", Napi::Function::New(env, PostLeftClick));
  Watcher::Init(env, exports);
  exports.Set("platform", Napi::String::New(env, "win32"));
  return exports;
}

NODE_API_MODULE(window_pin, Init)
