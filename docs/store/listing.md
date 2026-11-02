# Chrome Web Store listing

The values entered in the Developer Dashboard for the TokenLens item, kept here so the listing can
be reproduced or reviewed without the dashboard. Title and summary come from `manifest.json` and
cannot be edited in the dashboard.

## Store listing

| Field | Value |
| --- | --- |
| Description | `description.txt` |
| Category | Developer Tools |
| Language | English |
| Store icon | `src/assets/icon-128.png` |
| Screenshots (1280×800 JPEG) | `screenshot-1-overview-dark.jpg`, `screenshot-2-requests.jpg`, `screenshot-3-timeline.jpg`, `screenshot-4-overview-light.jpg` |
| Small promo tile (440×280) | `promo-small-440x280.jpg` |
| Marquee promo tile (1400×560) | `promo-marquee-1400x560.jpg` |
| Homepage URL | <https://github.com/behrouz-rad/TokenLens> |
| Support URL | <https://github.com/behrouz-rad/TokenLens/issues> |
| Mature content | off |

The screenshots are the real-DevTools captures from `docs/evidence/`, letterboxed to 16:10 on a
DevTools-coloured background. Regenerate them whenever the evidence images change.

## Privacy practices

| Field | Value |
| --- | --- |
| Single purpose description | TokenLens has a single purpose: letting developers inspect the JWT and Bearer tokens that the page they are debugging sends in Authorization: Bearer headers. It adds one DevTools panel that decodes those tokens locally, correlates each token with the requests that carried it and shows temporal diagnostics (expiry, not-before, issued-at, failed responses). It has no other features, no background activity, no permissions and makes no network requests of its own. |
| Remote code | No, I am not using Remote code |
| Permission justifications | none; the manifest declares no permissions |
| Data usage | TokenLens handles authentication information (Bearer tokens) locally and never collects or transmits it. The store's user-data FAQ treats local-only handling as handling, so declaring **Authentication information** is the transparent choice; the publisher decides and ticks it. |
| Certifications | the three "I certify" statements are the publisher's attestations and are ticked by hand |
| Privacy policy URL | <https://github.com/behrouz-rad/TokenLens/blob/main/PRIVACY.md> (must be publicly reachable at submission time) |

## Distribution

Free of charge, Public, all regions (dashboard defaults). Unlisted is the alternative for a
soft launch.
