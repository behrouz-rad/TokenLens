# TokenLens privacy policy

TokenLens is a Chrome DevTools extension that decodes JWT and Bearer tokens observed in the
inspected page's network requests. This policy describes what the extension does with that data.

## Data the extension handles

While Chrome DevTools is open on a page, TokenLens reads the `Authorization: Bearer` header of
requests that the DevTools network API reports for that page, together with each request's URL,
method, status code and timing. It also decodes any token you paste into its Decoder section.
Bearer tokens are authentication information.

## What happens to it

- Everything is processed locally, inside the DevTools panel of your own browser.
- Nothing is transmitted anywhere. TokenLens makes no network requests of its own, has no server,
  and contains no analytics, telemetry, crash reporting or advertising.
- Captured tokens and requests are kept in memory only, for the duration of the DevTools session.
  Closing DevTools, or clicking *Clear*, discards them. They are never written to disk.
- A token pasted into the Decoder is kept in memory only while the panel is open, separately from
  captured data. It is never stored, and it is discarded when you click *Clear input*, close
  DevTools, or when DevTools reloads the panel after the inspected page navigates.
- The only data stored persistently are UI preferences (theme, thresholds, capture limits, layout),
  saved in the panel's `localStorage`. They contain no tokens or request data.
- A token value or decoded content is copied to the clipboard only when you click a copy button.

## Permissions

The extension declares no permissions, no host permissions, no background service worker and no
content scripts. It consists solely of a DevTools page and panel.

## Data sharing and sale

TokenLens processes authentication information (JWT and Bearer tokens) and associated network request metadata locally within the user's browser.

No data is transmitted to or collected by the developer or any third party. TokenLens does not share or sell user data, use it for purposes unrelated to its single purpose, or use it to determine creditworthiness or for lending purposes.

## Changes and contact

Changes to this policy are published in this repository. Questions can be raised at
<https://github.com/behrouz-rad/TokenLens/issues>.
