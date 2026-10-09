# Contributing

Bug reports and ideas are the most useful thing right now: open an issue, and
for bugs paste the output of "Copy diagnostics" from the popup.

If you'd like to send code:

- `npm ci`, `npm test`, `npm run build`, and `npm run test:live` if you touched
  anything the browser does (it loads the build into a throwaway Chrome profile).
- Keep the promise in the README: no network requests, no analytics, no
  account. A change that needs any of that won't be merged.
- Small pull requests with a line on why are easiest to review.

By contributing you agree that your code is released under the MIT license.
