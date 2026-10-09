# Building Headerwise from source

This is how the packages in the stores are made, for anyone who wants to check
them (and for add-on reviewers).

You need Node.js 24 and npm 11 (CI uses Node 24 on ubuntu-latest). Any OS works.

```
npm ci                    # exact dependency versions from package-lock.json
npm run build             # Chrome / Edge build in dist/
npm run build:firefox     # Firefox build in dist-firefox/ and headerwise-firefox-<version>.zip
```

`npm run build` runs Vite (vite.config.ts): it compiles the TypeScript and Vue
files in `src/` and minifies them; nothing is obfuscated. `scripts/firefox.mjs`
copies `dist/` and changes only `manifest.json` (background as an event page,
Firefox add-on id, data collection declared as none), then zips it.

The Chrome Web Store zip is `dist/` zipped as is. CI builds both on every push
(`.github/workflows/ci.yml`) and keeps them as run artifacts.

Tests: `npm test` (unit tests, plain `node --test`), `npm run test:live` (loads
the build into a throwaway Chrome profile and checks real requests).
