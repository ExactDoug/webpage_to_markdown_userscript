# CLAUDE.md — Easy Web Page to Markdown

A Tampermonkey/Violentmonkey userscript that converts a hovered page element to Markdown.
Fork of shiquda's original. Single deliverable: `General/html2md.user.js`.

## Current state (2026-08-21)

- **Released on `main`:** v0.3.17
- **In review:** v0.4.0 on branch `fix/captcha-crash-and-element-selection`, PR
  [#5](https://github.com/ExactDoug/webpage_to_markdown_userscript/pull/5) — OPEN, mergeable,
  awaiting manual testing by Doug.
- **Next step:** Doug tests from the branch raw URL, then merges. No further code planned.

Install for testing (branch build — `@updateURL`/`@downloadURL` in the header still point at
`main`, so a manager's update check will not see this version):

```
https://raw.githubusercontent.com/ExactDoug/webpage_to_markdown_userscript/fix/captcha-crash-and-element-selection/General/html2md.user.js
```

## Hard constraints

These are decisions with reasons behind them. Do not undo them without a deliberate discussion.

1. **Never fetch code at install time or run time.** No `@require`, no `@resource`, no
   `@connect`, no runtime request. Both `@require` and `@resource` let the script start running
   code that was never reviewed. Libraries are vendored into the script (see below).
2. **Never execute library code at page load.** Every vendored library sits in a factory
   function called only from `initLibs()` on first activation. A page that is never converted
   executes none of it. This is what keeps the script clear of hardened frames.
3. **Keep working inside iframes.** `@noframes` was proposed and rejected — content worth
   converting lives in frames (docs sites, embedded readers, framesets). Captcha frames are
   excluded by URL instead.
4. **Do not reintroduce jQuery.** It was the cause of the Turnstile crash and jQuery UI was
   never called at all.

## Why v0.4.0 exists — the Turnstile crash

jQuery 3.6.0 runs this probe at load, before any of our code:

```js
div.innerHTML = "<textarea>x</textarea>";
support.noCloneChecked = !!div.cloneNode(true).lastChild.defaultValue;
```

Inside a Cloudflare Turnstile challenge frame that `innerHTML` assignment produces no child, so
`lastChild` is `null` and jQuery throws. Turnstile treats any uncaught error in its own frame as
tampering and fails the challenge with **error 300010**, which broke captchas in the browser.
The script never touched the page — loading `@require` in that frame was enough.

Confirmed by matching the reported stack column (`2:38141`) to the `.defaultValue` read at
column 38141 of `jquery-3.6.0.min.js`.

## Architecture of `General/html2md.user.js`

One IIFE, `'use strict'`, sections in this order:

| Section | Purpose |
|---|---|
| Metadata + loading note | `@match`/`@exclude`/`@grant`. Records why there is no `@require` |
| User config | Shortcut and Obsidian settings via `GM_getValue`/`GM_setValue` |
| Tiny DOM helpers | `h()`, `toSafeFragment()`, `setHTML()` — replaced jQuery |
| Library initialization | `initLibs()` / `ensureLibs()` — calls the vendored factories once |
| HTML2Markdown | `cloneForExport()` (form state + shadow expansion), `convertToMarkdown()` |
| Preview modal | Native DOM; copy / download / Obsidian / live preview / synced scroll |
| Highlight overlay | Fixed overlay + label, drawn from `getBoundingClientRect()` |
| Hit testing | `pick()`, `deepElementFromPoint()`, `stackAt()`, peel depth |
| Cross-frame coordination | `eachFrame()`, `broadcast()`, `message` listener |
| Selection mode | `beginSelecting()` / `endSelecting()` / `confirmSelection()` |
| Event wiring | All capture-phase |
| Turndown configuration | `buildTurndownService()` — GFM plugin, form rules, link normalization |
| Styles | `GM_addStyle` |
| **Vendored libraries** | Bottom of file — see below |

### Selection is per-document, coordinated by postMessage

Every frame runs its own copy. The top frame broadcasts `start`/`stop` to all frames; a frame
that takes the pointer broadcasts `claim` so others drop their stale highlight; a subframe that
converts posts `result` to the top frame, which owns the modal (a modal inside a small iframe
would be unusable). Messages are tagged `__h2m: 'h2m:v1'`. The menu command registers only in
the top frame to avoid one duplicate entry per iframe.

### Why the hit testing looks the way it does

Each piece exists because of a specific way selection failed:

| Technique | Failure it fixes |
|---|---|
| Capture-phase listeners | Widgets calling `stopPropagation()` were dead zones — hovering highlighted nothing |
| `composedPath()[0]` + shadow recursion | `event.target` is retargeted to the shadow host, making component internals unreachable |
| Shadow expansion in `cloneForExport()` | Shadow content is absent from `outerHTML`, so components converted to nothing |
| Overlay highlight instead of a CSS class | Page CSS with higher specificity hid the highlight; the added border also reflowed the page under the cursor |
| `Z` / `Shift+Z` peel via `elementsFromPoint` | Transparent overlays, sticky headers and full-page shields were the only selectable thing |
| `rectOf()` union fallback | `display:contents` elements have an empty border box, so the highlight vanished on ArrowUp |
| Click suppression window (excluding `.h2m-ui`) | The confirming click still reached the page (links navigated); a naive fix then ate clicks on our own modal |

## Vendored libraries

At the bottom of the script, each wrapped in a factory function. The bytes between the
`BEGIN`/`END` markers are the published dist file **verbatim** — only the wrapper is ours.

| Library | Version | SHA-256 |
|---|---|---|
| turndown | 7.2.4 | `c97187f436d41638bf7acf346a39d9d42f2f2c02af18245a297c09e796f8e46f` |
| @guyplusplus/turndown-plugin-gfm | 1.0.7 | `ad5f83cbb02a3e684d67acf9e8279615c3d7aada1c4c1695a4ac85be6616c99a` |
| marked | 12.0.0 | `eb1f6b19880bc80a5fe34c6a61885173b60edda455ba7a33c98714db17d39f99` |

**To update one:** download the new pinned dist file, replace the bytes between that library's
markers, update version / URL / SHA-256 in the comment above it, run `node --check`, re-run the
test suite.

**To verify provenance:** extract the bytes between the markers and hash them; the result must
equal both the recorded SHA-256 and `sha256sum` of the file at the recorded source URL.

Notes for anyone touching this area:

- They initialize against a private `scope` object, never `window`, so nothing reaches the
  page's globals.
- `module` / `exports` / `define` are shadowed to `undefined` in the factory signature. This is
  load-bearing: on RequireJS pages the page's global `define` was visible and marked took the
  AMD branch, so `marked` was never defined and the preview modal silently never opened.
- The whole file is strict mode. All three libraries already declare `'use strict'` internally,
  so this is safe, but a future vendored library that relies on sloppy mode would break.

## Testing

Verified with a Chrome DevTools Protocol harness driving **real** mouse and keyboard input
against headless Chromium (Playwright's build at
`~/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome`), with the userscript injected via
`Page.addScriptToEvaluateOnNewDocument` and `GM_*` stubbed. **The harness is deliberately not in
this repo** — rebuild it or ask for the copy from the session that wrote it.

The 14 checks it makes:

1. Loads with zero libraries initialized, zero globals leaked, zero errors
2. `Ctrl+M` enters selection mode without fetching anything (`@resource` reads must be 0)
3. Highlights a normal element on a page whose CSS kills borders with `!important`
4. Highlights inside a widget that calls `stopPropagation()` on its mouse events
5. Pierces shadow DOM on hover
6. `Z` peels underneath a transparent full-size overlay
7. Converts a normal element on click
8. Converts shadow DOM content with the host selected precisely (no leakage from outside it)
9. Captures live form values — text input, textarea, select, checkbox
10. A **cross-origin** iframe joins selection mode and converts through to the top frame's modal
11. `display:contents` wrapper still highlights something visible
12. Escape leaves no highlight and no guide behind
13. No uncaught errors in either document across the whole run
14. No off-origin request from any document at any point (`performance.getEntriesByType`)

Gotchas if you rebuild it: CDP page-session input is **not** routed into an out-of-process
iframe — dispatch to the frame's own session in frame-local coordinates. CDP also propagates the
page-level init script into the OOPIF, so wrap the injection in an idempotence guard (a
top-level `const` redeclaration fails at parse time, before any runtime guard can run).

## Open questions (not for an agent to decide)

- **License is inconsistent.** `LICENSE` is MIT © 2024 shiquda, root `README.md` says MIT, the
  script header says `@license AGPL-3.0`. Upstream fork lineage makes this non-obvious. Doug's
  call.
- **`@updateURL`/`@downloadURL` point at `main`.** Correct for release, but means branch builds
  never auto-update. Intentional for now.

## Reference

- Upstream original: shiquda's html2md userscript
- User docs: `General/readme.md`
- Obsidian integration uses [Obsidian Advanced URI](https://vinzent03.github.io/obsidian-advanced-uri/installing)
