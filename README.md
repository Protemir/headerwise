# Headerwise

Change HTTP request and response headers in Chrome and Edge. Set, append or remove
headers per profile, limit a profile to some URLs or keep it off others, and import
your old ModHeader profiles.

It runs entirely in your browser. No account, no analytics, no network requests of
its own. Rules are applied by Chrome itself through `declarativeNetRequest`, so the
extension never reads the pages you visit.

You don't have to take "no network requests" on trust: the manifest sets
`connect-src 'none'` for every extension page and the background worker, so the
browser itself blocks any request Headerwise might try to make. `npm run test:live`
checks this (fetch, image, beacon, worker) in a real browser.

Site: https://protemir.github.io/headerwise/ · Privacy: https://protemir.github.io/headerwise/privacy.html

## Status

Free, and staying free. Being submitted to the Chrome Web Store and Edge Add-ons;
until then, build it yourself (below). Bugs and requests: GitHub Issues.

## Develop

```
npm install
npm test          # unit tests, plain node --test
npm run build     # builds the extension into dist/
npm run test:live # loads dist/ into a throwaway Chrome profile and checks real requests
                  # (add -- --browser edge for Edge)
```

Then open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and
pick the `dist` folder. Click the Headerwise icon and allow access to sites.

## How rules map to Chrome

Each enabled profile becomes one `modifyHeaders` rule per "only on" filter (or one
rule for all URLs if there are none). "Never on" filters with a plain domain become
`excludedRequestDomains`. The first profile in the list has the highest priority.

Chrome has no way to say "skip URLs matching this regex", so a regex (or any other
non-domain) "never on" filter becomes an `allow` rule with the profile's priority.
Chrome then ignores all header rules with that priority or lower on matching URLs.
To keep this from switching off other profiles, profiles with such filters are
placed below the rest, and Headerwise warns if that changes which profile wins a
header.
Chrome only allows `append` for a short list of request headers; Headerwise tells
you when it skips one.

## License

MIT, see [LICENSE](LICENSE).
