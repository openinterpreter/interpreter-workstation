#include <napi.h>

static Napi::Value PinAbove(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), false);
}

static Napi::Value SetWindowLevelNormal(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), false);
}

static Napi::Value GetWindowNumber(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), 0);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("pinAbove", Napi::Function::New(env, PinAbove));
  exports.Set("setWindowLevelNormal", Napi::Function::New(env, SetWindowLevelNormal));
  exports.Set("getWindowNumber", Napi::Function::New(env, GetWindowNumber));
  exports.Set("platform", Napi::String::New(env, "stub"));
  return exports;
}

NODE_API_MODULE(window_pin, Init)
