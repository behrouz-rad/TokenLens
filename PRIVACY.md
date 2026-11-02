# TokenLens privacy policy

TokenLens is a Chrome DevTools extension that decodes JWT and Bearer tokens observed in the
inspected page's network requests. This policy describes what the extension does with that data.

## Data the extension handles

While Chrome DevTools is open on a page, TokenLens reads the `Authorization: Bearer` header of
requests that the DevTools network API reports for that page, together with each request's URL,
method, status code and timing. Bearer tokens are authentication information.

## What happens to it

- Everything is processed locally, inside the DevTools panel of your own browser.
- Nothing is transmitted anywhere. TokenLens makes no network requests of its own, has no server,
  and contains no analytics, telemetry, crash reporting or advertising.
- Captured tokens and requests are kept in memory only, for the duration of the DevTools session.
  Closing DevTools, or clicking *Clear*, discards them. They are never written to disk.
- The only data stored persistently are UI preferences (theme, thresholds, capture limits, layout),
  saved in the panel's `localStorage`. They contain no tokens or request data.
- A token value is copied to the clipboard only when you click *Copy*.

## Permissions

The extension declares no permissions, no host permissions, no background service worker and no
content scripts. It consists solely of a DevTools page and panel.

## Data sharing and sale

No data is collected, so none is shared or sold, used for purposes unrelated to the extension's
single purpose, or used to determine creditworthiness or for lending purposes.

## Changes and contact

Changes to this policy are published in this repository. Questions can be raised at
<https://github.com/behrouz-rad/TokenLens/issues>.
