# Privacy

Headerwise does not collect, store or send any personal data.

- Your profiles are stored with `chrome.storage.local` on your computer.
- If you tick "Sync profiles across my computers", they are also handed to the
  browser's own sync (`chrome.storage.sync`), which the browser keeps in the
  Google or Microsoft account it is signed in to. Headerwise has no server of its
  own. Secret values, and which profiles are switched on, are never synced. It is
  off unless you switch it on, on each computer.
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
- "Share…" (and "Copy link" in Export) puts the chosen profiles, without secret values, into
  the link itself, after "#". Browsers don't send that part to any server: the
  share page on protemir.github.io reads it in your browser. Its "Add to
  Headerwise" button hands the link to the extension; only that site can, and
  the profiles come in switched off.
- Access to sites is optional and asked for only when you click "Allow on all
  sites". You can revoke it in the browser's extension settings at any time.

If a paid version is added later, license checks will go to the payment provider
only, and this page will be updated before that ships.

Contact: the support email on the store listing.
