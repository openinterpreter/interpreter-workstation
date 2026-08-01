{
  "targets": [
    {
      "target_name": "window_pin",
      "sources": [],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NAPI_VERSION=8"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS==\"mac\"", {
          "sources": ["src/window_pin_mac.mm"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "OTHER_CFLAGS": ["-ObjC++"],
            "OTHER_LDFLAGS": ["-framework", "AppKit", "-framework", "CoreGraphics"],
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          }
        }],
        ["OS==\"win\"", {
          "sources": ["src/window_pin_win.cc"],
          "libraries": [
            "-lUser32.lib",
            "-lDwmapi.lib",
            "-lPsapi.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17", "/EHsc"]
            }
          },
          "defines": [
            "WIN32_LEAN_AND_MEAN",
            "NOMINMAX",
            "_HAS_EXCEPTIONS=1"
          ]
        }],
        ["OS!=\"mac\" and OS!=\"win\"", {
          "sources": ["src/window_pin_stub.cc"]
        }]
      ]
    }
  ]
}
