# Portable adb

Unpress Android Platform-tools into this directory (should appear) `adb.exe`), Hydra Emulator will use it first.:

```
tools/platform-tools/
└─ adb.exe
```

Download Address: https://developer.android.com/tools/releases/platform-tools

If this directory is empty, Hydra Emulator will try it in turn.:

1. Sets a manual adb path for the settings
2. Contents
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
4. Common emulator self-carried adb (LDPlayer / Mumu / BlueStacks))
5. System PATH
