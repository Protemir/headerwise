# Store listing (Chrome Web Store and Edge Add-ons)

Everything to paste into the two developer dashboards. Images are in this folder;
`node scripts/store/shots.mjs` (after `npm run build`) makes them again from the real UI.

## Basics

- **Name** (from the manifest): Headerwise: Modify HTTP Headers
- **Short description** (from the manifest, 118 of 132 chars):
  Modify request and response headers per profile. Import your ModHeader profiles. Runs locally, sends nothing anywhere.
- **Category:** Developer Tools
- **Language:** English
- **Price:** free
- **Privacy policy URL:** https://protemir.github.io/headerwise/privacy.html (live, from `docs/` via GitHub Pages)
- **Homepage:** https://protemir.github.io/headerwise/
- **Support:** https://github.com/Protemir/headerwise/issues

## Detailed description

```
Headerwise changes HTTP request and response headers in Chrome and Edge. Set, append or remove headers, group them in profiles, and turn them on only where you need them.

It runs entirely in your browser. There is no account and no analytics, and the extension cannot send anything anywhere: its manifest forbids network requests, so the browser itself blocks them. Header changes are applied by the browser through declarativeNetRequest, so Headerwise never reads the pages you visit.

WHAT YOU CAN DO
• Request and response headers: set, append or remove, per profile.
• Profiles: as many as you like, several on at once. Duplicate them, drag to reorder (the leftmost wins a shared header), switch with a keyboard shortcut.
• Filters: only on or never on URL patterns and regular expressions, only for requests made by some sites, only for some request types (page, fetch/XHR, scripts…) or methods, or only in one tab.
• On this tab: open the popup to see which profile changed how many requests on the current page, and why another one didn't.
• Paste from DevTools: copy a request as cURL, fetch or PowerShell, paste it, and pick the headers you want.
• Redirects: replace part of the address, for example send api.example.com requests to your staging server. ModHeader's URL replacements import as redirects, and its cookie rules as Cookie and Set-Cookie headers.
• Presets: CORS, remove Content-Security-Policy, allow a site in an iframe, Bearer token, no cache, iPhone or Googlebot User-Agent, and more.
• Variables: {{uuid}}, {{timestamp}}, {{date}} and others, filled in on every edit and refreshed every minute.
• Secrets stay hidden: tokens and cookies show as dots until you click the eye, handy when you share your screen.
• Export and import profiles as JSON. Secret values are left out unless you ask for them.
• Automated tests: a separate build for Selenium, Playwright and Puppeteer sets headers from your test, and runs tests written for ModHeader with only the extension swapped. Download and setup: https://protemir.github.io/headerwise/automation.html
• Light and dark theme.

COMING FROM MODHEADER?
ModHeader was removed from the Chrome and Edge stores in July 2026. If your browser turned it off, its Export button is gone too, but your profiles are still on your disk. Headerwise reads ModHeader's folder right in the page (nothing is uploaded) and brings the profiles over, filters included. Exported ModHeader JSON files work too.

WHY NOT JUST DEVTOOLS?
DevTools is great for looking at headers. It can't add request headers like Authorization to every request, and its overrides only work while DevTools is open in that one tab. Headerwise works in every tab, all the time, until you pause it.

Free, with no limits. Everything listed here is free and will stay free.

Open source (MIT): https://github.com/Protemir/headerwise
```

## Single purpose (Chrome)

```
Modify HTTP request and response headers in the browser, organized in profiles that the user turns on and off.
```

## Permission justifications

| Permission | Justification to paste |
|---|---|
| declarativeNetRequest | Applies the user's header changes as browser rules. This is the extension's only function; the browser applies the rules, the extension never sees request or page content. |
| storage | Saves the user's profiles on the user's computer (chrome.storage.local). Nothing is synced or sent anywhere. |
| activeTab | When the user clicks the toolbar button, the popup reads the current tab's address and asks the browser which of the extension's rules matched there, to show "On this tab". Nothing is stored or sent. |
| alarms | When a header value uses a variable such as {{uuid}} or {{timestamp}}, refreshes the value once a minute. No alarm runs otherwise. |
| Host permission `<all_urls>` (optional) | The browser only lets an extension change headers on sites it has access to. Requested at runtime, only after the user clicks "Allow on all sites"; the user can revoke it any time. |
| Remote code | No. All code is in the package; the extension's content security policy forbids network requests. |

## Data usage (Chrome "Privacy practices" tab)

- Collects none of the listed data types (personally identifiable information, health, financial, authentication, personal communications, location, web history, user activity, website content).
- Certify all three: data is not sold to third parties, not used or transferred for purposes unrelated to the single purpose, not used for creditworthiness or lending.

## Edge extras

- **Search terms** (up to 7): modify headers, http headers, request headers, response headers, cors, user agent, header editor
- **Store logo:** `logo-300.png` (300×300)
- **Screenshots:** the same five, 1280×800

## Images

| File | Use |
|---|---|
| `screenshots/1-headers.png` … `5-filters.png` | Screenshots, 1280×800, in this order |
| `promo-small-440x280.png` | Chrome small promo tile (required) |
| `promo-marquee-1400x560.png` | Chrome marquee (optional, used if featured) |
| `logo-300.png` | Edge store logo |
| `../public/icons/icon-128.png` | Store icon (Chrome takes it from the package) |

## Before submitting

1. Version in `public/manifest.json` and `package.json`: 1.0.4 in main, 1.0.0 in review (raise it for every later upload, the stores reject a repeated version).
2. `npm run build`, `npm test`, `npm run test:live` (and `-- --browser edge`).
3. Upload the zip CI builds from `dist/` (Actions → latest run → artifact).
4. After approval: put the listing URLs into the install buttons in `docs/index.html` (they search the stores for now).

## Other languages (from 1.0.1)

The package carries a translated name and summary for es, pt_BR, de, fr, ja,
zh_CN and ru (`public/_locales`), so the store can show a localized listing.
Full descriptions to paste for each language: `store/translations/<locale>.txt`.
In the dashboard: Store listing → language selector → pick the language →
paste the description. Screenshots can stay the same (the UI is in English).
