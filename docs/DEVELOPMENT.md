# Local development

[Back to README](../README.md)

Requires Node.js **24 or newer** and Chromium (or Puppeteer's managed browser).

```sh
cp .env.example .env
cd server
npm ci
npm start
```

`npm ci` normally downloads Puppeteer's browser. To use system Chromium, install with `PUPPETEER_SKIP_DOWNLOAD=true npm ci` and set `PUPPETEER_EXECUTABLE_PATH=/path/to/chromium` if it isn't in a standard Linux location. State defaults to the repository's `data/` directory.

From the repository root, run:

```sh
cd server
npm test
```

Tests use temporary databases and local fixtures, including failed delivery/restart, extraction edge cases, backup/restore and concurrent state edits. Browser integration tests run when `PUPPETEER_EXECUTABLE_PATH` or `/usr/bin/chromium` is available. CI runs the suite before publishing images and smoke-tests Compose startup.

See [verification notes](VERIFICATION.md) for tested behavior and verification limits.
