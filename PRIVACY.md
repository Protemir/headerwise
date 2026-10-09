# Privacy

Headerwise does not collect, store or send any personal data.

- Your profiles are stored with `chrome.storage.local` on your computer.
- The extension makes no network requests, and can't: its manifest sets
  `connect-src 'none'` for all its pages and its background worker, so the
  browser blocks any attempt (see `content_security_policy` in `manifest.json`).
- Header changes are applied by the browser through the `declarativeNetRequest`
  API, so Headerwise never sees page content or request bodies.
- When you open the popup, it reads the address of the current tab and asks the
  browser which Headerwise rules matched there, to show "On this tab". This is
  only shown in the popup and is not stored.
- "Move from ModHeader" reads only the folder you pick, inside that page. The
  files are not uploaded or kept; only the profiles you choose to import are saved.
- Access to sites is optional and asked for only when you click "Allow on all
  sites". You can revoke it in the browser's extension settings at any time.

If a paid version is added later, license checks will go to the payment provider
only, and this page will be updated before that ships.

Contact: the support email on the store listing.
