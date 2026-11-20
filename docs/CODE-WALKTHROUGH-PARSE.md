# APK parsing code walkthrough

[`src/core/apk.js`](../src/core/apk.js) reads the APK manifest, validates the package name, and resolves launch metadata and the app icon. [`src/core/axml.js`](../src/core/axml.js) reads compiled Android XML. [`src/core/arsc.js`](../src/core/arsc.js) resolves resources from the APK resource table.

[`src/core/zip.js`](../src/core/zip.js) reads ZIP archives and supports streaming larger entries to disk. Extraction resolves paths within the intended destination. [`src/core/installer.js`](../src/core/installer.js) prepares split APKs, installs packages through ADB, and records installed apps. [`src/core/adb.js`](../src/core/adb.js) maps common Android installer errors into English guidance while retaining the Android error code.

[`src/core/png.js`](../src/core/png.js) encodes generated PNGs. [`src/core/shortcut.js`](../src/core/shortcut.js) writes Windows shortcuts with per-app icons and taskbar identities. [`src/core/assoc.js`](../src/core/assoc.js) manages the optional Windows `.apk` association.

The synthetic APK fixtures in [`test/lib/make-apk.js`](../test/lib/make-apk.js) and the standard suite cover manifest parsing, image decoding, package validation, and installation behavior.
