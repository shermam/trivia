# Inter (self-hosted)

`inter-v20-latin.woff2` and `inter-v20-latin-ext.woff2` are the variable-weight
Inter subsets Google Fonts serves for `Inter:wght@100..900`, taken from release
`v20` of that catalogue and committed here rather than requested at runtime.

**Why self-hosted.** Hot-linking `fonts.googleapis.com` sends every visitor's IP
address to Google before the page has asked for any consent. LG München I
(3 O 17493/20) held that to be a GDPR breach. Self-hosting removes the transfer
outright, and removes two preconnects and a render-blocking stylesheet with it.
See `AUDIT_REMEDIATION.md` finding H5.

**Licence.** Inter is © 2016 The Inter Project Authors and licensed under the
SIL Open Font License 1.1 — full text in `LICENSE.txt`, which the OFL requires
to accompany the font files wherever they are redistributed. The licence permits
this bundling; it does not permit selling the fonts on their own, and it
requires that any derivative be released under the same licence and not use the
reserved name.

**Updating.** Fetch the current CSS with a browser user-agent (Google serves
woff2 only to agents that support it), take the `latin` and `latin-ext` `src`
URLs, and save them under a **new** filename carrying the new revision:

```bash
curl -A "Mozilla/5.0 ... Chrome/131.0.0.0 ..." \
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap"
```

The version has to be in the filename because `public/` is copied into the build
verbatim, with no content hash, while `firebase.json` serves woff2 with
`Cache-Control: immutable, max-age=31536000`. Replacing a file in place would be
invisible to every returning visitor for a year. Update the two `@font-face`
`src` URLs in `src/styles.css` and the preload in `src/index.html` to match.
