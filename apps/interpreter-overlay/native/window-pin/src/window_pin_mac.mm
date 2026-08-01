// In-process macOS pinning for an Electron BrowserWindow.
//
// Electron's BrowserWindow.getNativeWindowHandle() returns a Buffer whose bytes
// are an `NSView **` (pointer to the content view pointer). To pin the window's
// z-order above another window owned by another process, we deref to NSView*,
// hop to its NSWindow*, and call -[NSWindow orderWindow:relativeTo:] passing
// the target's CGWindowID. While pinned we keep the source at floating level so
// target app activation cannot temporarily cover the overlay between repins.

#import <AppKit/AppKit.h>
#include <napi.h>

static NSWindow *NSWindowFromHandleBuffer(const Napi::Buffer<char> &buffer) {
  if (buffer.Length() < sizeof(void *)) {
    return nil;
  }
  // Electron's getNativeWindowHandle() returns a Buffer of size sizeof(void*)
  // whose bytes are the underlying NSView*. Read the raw pointer, then bridge
  // it back into an ARC-managed reference to call -window safely.
  void *raw = nullptr;
  memcpy(&raw, buffer.Data(), sizeof(void *));
  if (!raw) {
    return nil;
  }
  NSView *view = (__bridge NSView *)raw;
  return [view window];
}

// Pin the given Electron NSWindow's z-position to be just above the target
// window identified by `targetCgWindowId`. Returns true on success, false if
// the source window can't be resolved or the target id is 0.
static Napi::Value PinAbove(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "pinAbove(handleBuffer, targetCgWindowId)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<char> handle = info[0].As<Napi::Buffer<char>>();
  uint32_t targetId = info[1].As<Napi::Number>().Uint32Value();
  if (targetId == 0) {
    return Napi::Boolean::New(env, false);
  }

  NSWindow *win = NSWindowFromHandleBuffer(handle);
  if (!win) {
    return Napi::Boolean::New(env, false);
  }

  __block BOOL ok = NO;
  void (^pin)(void) = ^{
    if ([win level] != NSFloatingWindowLevel) {
      [win setLevel:NSFloatingWindowLevel];
    }
    if ([win windowNumber] <= 0) {
      ok = NO;
      return;
    }
    [win orderWindow:NSWindowAbove relativeTo:(NSInteger)targetId];
    ok = YES;
  };
  if ([NSThread isMainThread]) {
    pin();
  } else {
    dispatch_sync(dispatch_get_main_queue(), pin);
  }
  return Napi::Boolean::New(env, ok ? true : false);
}

static Napi::Value SetWindowLevelNormal(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "setWindowLevelNormal(handleBuffer)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<char> handle = info[0].As<Napi::Buffer<char>>();
  NSWindow *win = NSWindowFromHandleBuffer(handle);
  if (!win) {
    return Napi::Boolean::New(env, false);
  }
  void (^apply)(void) = ^{
    [win setLevel:NSNormalWindowLevel];
  };
  if ([NSThread isMainThread]) {
    apply();
  } else {
    dispatch_sync(dispatch_get_main_queue(), apply);
  }
  return Napi::Boolean::New(env, true);
}

static Napi::Value GetWindowNumber(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "getWindowNumber(handleBuffer)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<char> handle = info[0].As<Napi::Buffer<char>>();
  NSWindow *win = NSWindowFromHandleBuffer(handle);
  if (!win) {
    return Napi::Number::New(env, 0);
  }
  __block NSInteger num = 0;
  void (^read)(void) = ^{
    num = [win windowNumber];
  };
  if ([NSThread isMainThread]) {
    read();
  } else {
    dispatch_sync(dispatch_get_main_queue(), read);
  }
  return Napi::Number::New(env, (double)num);
}

// Diagnose z-order: returns the index of the world window in the WindowServer's
// front-to-back on-screen list, plus the indices of all PIDs of windows above
// us. Used to confirm whether our window is actually below foreign apps after
// the pin call.
static Napi::Value DescribeZOrder(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "describeZOrder(handleBuffer)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<char> handle = info[0].As<Napi::Buffer<char>>();
  NSWindow *win = NSWindowFromHandleBuffer(handle);
  if (!win) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("ok", Napi::Boolean::New(env, false));
    return o;
  }
  __block NSInteger ourNum = 0;
  __block NSInteger ourLevel = 0;
  void (^read)(void) = ^{
    ourNum = [win windowNumber];
    ourLevel = [win level];
  };
  if ([NSThread isMainThread]) read(); else dispatch_sync(dispatch_get_main_queue(), read);

  CFArrayRef list = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  Napi::Array windowsAbove = Napi::Array::New(env);
  uint32_t aboveCount = 0;
  NSInteger ourIndex = -1;
  if (list) {
    NSArray *arr = (__bridge NSArray *)list;
    for (NSUInteger i = 0; i < [arr count]; i++) {
      NSDictionary *entry = arr[i];
      NSNumber *winNum = entry[(__bridge NSString *)kCGWindowNumber];
      if (!winNum) continue;
      NSInteger num = [winNum integerValue];
      if (num == ourNum) {
        ourIndex = (NSInteger)i;
        break;
      }
      Napi::Object item = Napi::Object::New(env);
      item.Set("windowNumber", Napi::Number::New(env, (double)num));
      NSString *owner = entry[(__bridge NSString *)kCGWindowOwnerName];
      item.Set("owner", Napi::String::New(env, owner ? [owner UTF8String] : ""));
      NSNumber *layer = entry[(__bridge NSString *)kCGWindowLayer];
      item.Set("layer", Napi::Number::New(env, layer ? [layer integerValue] : 0));
      windowsAbove.Set(aboveCount++, item);
    }
    CFRelease(list);
  }
  Napi::Object out = Napi::Object::New(env);
  out.Set("ok", Napi::Boolean::New(env, true));
  out.Set("worldWindowNumber", Napi::Number::New(env, (double)ourNum));
  out.Set("worldWindowLevel", Napi::Number::New(env, (double)ourLevel));
  out.Set("worldIndexInOnScreenList", Napi::Number::New(env, (double)ourIndex));
  out.Set("windowsAbove", windowsAbove);
  return out;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("pinAbove", Napi::Function::New(env, PinAbove));
  exports.Set("setWindowLevelNormal", Napi::Function::New(env, SetWindowLevelNormal));
  exports.Set("getWindowNumber", Napi::Function::New(env, GetWindowNumber));
  exports.Set("describeZOrder", Napi::Function::New(env, DescribeZOrder));
  exports.Set("platform", Napi::String::New(env, "darwin"));
  return exports;
}

NODE_API_MODULE(window_pin, Init)
