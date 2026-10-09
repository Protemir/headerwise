# Security

Headerwise holds things people care about (tokens and cookies in headers), so
security reports are welcome and taken seriously.

Please report privately through GitHub: Security → Report a vulnerability
(https://github.com/Protemir/headerwise/security/advisories/new), not in a public issue.
I'll reply within a few days and credit you in the fix if you like.

What the extension is supposed to guarantee, and what's worth testing:

- It makes no network requests: `connect-src 'none'` and the rest of the CSP in
  `public/manifest.json` cover every extension page and the service worker.
- Profiles stay in `chrome.storage.local`; nothing is synced or sent.
- Header changes go through `declarativeNetRequest`; the extension never reads
  page content or request bodies.
- Exports leave secret values out unless the user asks for them.
