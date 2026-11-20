# Contributing to Hydra Emulator

Thank you for contributing to Hydra Emulator! Our design philosophy focuses on **zero external shell dependencies, predictable runtime behavior, and minimal resource footprint**. Please review these guidelines before submitting an issue or pull request.

## Development Environment

- Windows 10/11 x64 (or Linux x64 for headless testing/development)
- Node.js >= 20
- `npm install && npm start`

## Verification & Testing

Before committing changes, run the offline test suite:

```bash
npm test          # Pure Node.js unit tests + runtime engine chain (no network required)
```

To verify UI layouts without regressions:

```powershell
electron . --smoke test\shot.png
```

## Architecture & Code Conventions

- **Zero Third-Party Shell Dependencies**: All parsers in `src/core/` (ZIP, AXML, ARSC, PNG, ICO) are built using standard Node.js APIs to avoid dependency bloat.
- The UI layer uses native HTML, modern CSS, and vanilla JavaScript without frontend frameworks.
- All Android communication must route through `src/core/adb.js`.
- Communication between the main process and renderer process is strictly isolated via `preload.js` with `contextIsolation: true`.
- All code, UI strings, documentation, and comments are written in English.

## Testing Guidelines

- Unit tests must not access external network resources. If HTTP behavior is required, mock it with a local `http` server (see `test/engine-test.js`).
- If you have an APK file available for deep inspection testing:
  ```powershell
  $env:HYDRA_TEST_APK="C:\path\to\app.apk"; npm test
  ```

## Commit Style

We follow the Conventional Commits specification:
```
feat(engine): support custom qcow2 disk image paths
fix(axml): resolve attribute table base offset calculation
docs: update hardware acceleration instructions
```

## Legal & Boundaries

- Hydra Emulator does not distribute proprietary system images, QEMU binaries, or Google proprietary components; all components are acquired on demand.
- Do not commit copyrighted binaries, commercial APKs, or crack tools to the repository.
