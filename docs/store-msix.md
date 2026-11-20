# Build an MSIX package

Install the Windows SDK packaging tools, Node.js 20 or 22, and Hydra's npm dependencies. Build a portable package and prepare its runtime before staging the MSIX.

```powershell
npm ci
node build/fetch-runtime.js engine
npm run runtime
npm run pack
```

For a local test package, use `npm run build:msix -- --allow-placeholder`. A signed test package requires a trusted local signing certificate and a manifest publisher that matches the certificate subject.

For Microsoft Store submission, copy the package identity and publisher from the Hydra Emulator product in Partner Center. Supply those values through `HYDRA_MSIX_IDENTITY` and `HYDRA_MSIX_PUBLISHER`, then run `npm run build:msix`. You can override the publisher display name with `HYDRA_MSIX_PUBLISHER_DISPLAY`.

The script writes packages to `dist/store/`, for example `Hydra Emulator_0.6.3.0_x64.msix` for version 0.6.3. It stages the app, runtime, manifest, and Store artwork. See [Store submission](store-upload-walkthrough.md) for the next steps.
