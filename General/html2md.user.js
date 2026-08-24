// ==UserScript==
// @name         Easy Web Page to Markdown
// @namespace    http://tampermonkey.net/
// @version      0.4.1
// @description  Convert selected HTML to Markdown
// @author       ExactDoug (forked from shiquda)
// @match        *://*/*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://*/cdn-cgi/challenge-platform/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://www.google.com/recaptcha/*
// @exclude      *://www.recaptcha.net/recaptcha/*
// @namespace    https://github.com/ExactDoug/webpage_to_markdown_userscript
// @supportURL   https://github.com/ExactDoug/webpage_to_markdown_userscript/issues
// @updateURL   https://raw.githubusercontent.com/ExactDoug/webpage_to_markdown_userscript/main/General/html2md.user.js
// @downloadURL https://raw.githubusercontent.com/ExactDoug/webpage_to_markdown_userscript/main/General/html2md.user.js
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @license      AGPL-3.0
// ==/UserScript==

// NOTE ON LOADING (v0.4.0):
// This script fetches nothing, ever. The conversion libraries are vendored
// verbatim at the bottom of this file -- no @require, no @resource, no runtime
// request -- so the code that ships is the code that was reviewed, and no
// upstream change can alter this script's behaviour after the fact. Each
// vendored block records its version, source URL and SHA-256.
//
// They are still loaded lazily, which is a separate property from where they
// come from: each library sits inside a factory function that is only CALLED on
// first activation. That is what keeps this script out of the way of hardened
// frames. v0.3.x broke Cloudflare Turnstile because @require executes on every
// page and frame at document start: jQuery's load-time feature detection
// assumes `innerHTML` parses normally, that assumption does not hold inside a
// challenge frame, jQuery threw, and Turnstile treats any uncaught error in its
// frame as tampering (error 300010). jQuery and jQuery UI are gone entirely.

(function () {
    'use strict';

    const IS_TOP = window.top === window.self;
    const MSG = 'h2m:v1';

    // User Config
    // Short cut

    const shortCutUserConfig = {
        /* Example:
        "Shift": false,
        "Ctrl": true,
        "Alt": false,
        "Key": "m"
        */
    }

    // Obsidian
    const obsidianEnabledUserConfig = false; // Set to true to enable Obsidian functionality
    const obsidianUserConfig = {
        /* Example:
            "my note": [
                "Inbox/Web/",
                "Collection/Web/Reading/"
            ]
        */
    }

    const guide = `
- Move the mouse to highlight an element
- **Click** or press \`Enter\` to convert it
- Use **Arrow Keys** to select elements
    - Up: Select parent element
    - Down: Select first child element
    - Left: Select previous sibling element
    - Right: Select next sibling element
- Use **Mouse Wheel** to zoom in/out
    - Up: Select parent element
    - Down: Select first child element
- Press \`Z\` to dig underneath a stacked/overlapping element (\`Shift+Z\` to come back up)
- Press \`Esc\` to cancel selection
    `

    // Global variables
    var isSelecting = false;
    var selectedElement = null;
    let shortCutConfig, obsidianEnabled, obsidianConfig;
    // Read configuration
    // Initialize shortcut key configuration
    let storedShortCutConfig = GM_getValue('shortCutConfig');
    if (Object.keys(shortCutUserConfig).length !== 0) {
        GM_setValue('shortCutConfig', JSON.stringify(shortCutUserConfig));
        shortCutConfig = shortCutUserConfig;
    } else if (storedShortCutConfig) {
        shortCutConfig = JSON.parse(storedShortCutConfig);
    }

    // Initialize Obsidian enabled setting
    let storedObsidianEnabled = GM_getValue('obsidianEnabled');
    if (storedObsidianEnabled !== undefined) {
        obsidianEnabled = storedObsidianEnabled;
    } else {
        obsidianEnabled = obsidianEnabledUserConfig;
        GM_setValue('obsidianEnabled', obsidianEnabled);
    }

    // Initialize Obsidian configuration (only if enabled)
    if (obsidianEnabled) {
        let storedObsidianConfig = GM_getValue('obsidianConfig');
        if (Object.keys(obsidianUserConfig).length !== 0) {
            GM_setValue('obsidianConfig', JSON.stringify(obsidianUserConfig));
            obsidianConfig = obsidianUserConfig;
        } else if (storedObsidianConfig) {
            obsidianConfig = JSON.parse(storedObsidianConfig);
        }
    }

    // ========================================================================
    // TINY DOM HELPERS (replaces jQuery)
    // ========================================================================

    function h(tag, attrs) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const key in attrs) {
                if (key === 'class') node.className = attrs[key];
                else if (key === 'text') node.textContent = attrs[key];
                else node.setAttribute(key, attrs[key]);
            }
        }
        for (let i = 2; i < arguments.length; i++) {
            const kid = arguments[i];
            if (kid === null || kid === undefined) continue;
            node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
        }
        return node;
    }

    // Parse untrusted HTML into an inert fragment and strip anything active.
    // <template> content does not load resources or run scripts while parsing;
    // this removes the event handlers and javascript: URLs that would run once
    // the fragment is attached to the preview pane.
    function toSafeFragment(html) {
        const tpl = document.createElement('template');
        try {
            tpl.innerHTML = html;
        } catch (e) {
            // Trusted Types / hardened document: degrade to plain text.
            const frag = document.createDocumentFragment();
            frag.appendChild(document.createTextNode(html));
            return frag;
        }
        const banned = { SCRIPT: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1, STYLE: 1, BASE: 1, FORM: 1 };
        const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
        const doomed = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (banned[node.nodeName]) { doomed.push(node); continue; }
            const attrs = Array.prototype.slice.call(node.attributes);
            for (const attr of attrs) {
                const name = attr.name.toLowerCase();
                if (name.indexOf('on') === 0) node.removeAttribute(attr.name);
                else if ((name === 'href' || name === 'src' || name === 'xlink:href') &&
                         /^\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
            }
        }
        for (const node of doomed) if (node.parentNode) node.parentNode.removeChild(node);
        return tpl.content;
    }

    function setHTML(target, html) {
        while (target.firstChild) target.removeChild(target.firstChild);
        target.appendChild(toSafeFragment(html));
    }

    // ========================================================================
    // LIBRARY INITIALIZATION
    //
    // The libraries are vendored at the bottom of this file, so there is
    // nothing to fetch and nothing that can change underneath us. All this does
    // is call their factories the first time you actually convert something.
    // ========================================================================

    let libs = null;
    let turndownService = null;

    function initLibs() {
        // A private object stands in for the global that UMD bundles expect, so
        // the libraries are never written to `window` and never touch the page.
        const scope = {};
        const args = [window, document, scope, scope, undefined, undefined, undefined];
        const out = {
            TurndownService: __h2mVendorTurndown.apply(window, args),
            TurndownPluginGfmService: __h2mVendorTurndownGfm.apply(window, args),
            marked: __h2mVendorMarked.apply(window, args)
        };
        if (!out.TurndownService || !out.TurndownPluginGfmService || !out.marked) {
            throw new Error('vendored libraries failed to initialize');
        }
        return out;
    }

    // Promise-shaped so callers stay uniform, but it resolves synchronously --
    // there is no I/O left to wait for.
    function ensureLibs() {
        try {
            if (!libs) {
                libs = initLibs();
                turndownService = buildTurndownService(libs);
            }
            return Promise.resolve(libs);
        } catch (err) {
            libs = null;
            turndownService = null;
            return Promise.reject(err);
        }
    }

    // ========================================================================
    // HTML2Markdown
    // ========================================================================

    // Clone the subtree for export.
    //
    // Two things a plain cloneNode(true) + outerHTML misses:
    //   1. Live form state. DOM .value/.checked never appear in outerHTML, so
    //      Turndown would see empty fields (fixed in v0.3.17).
    //   2. Shadow DOM. A web component renders its content in a shadow root,
    //      which outerHTML does not include at all, so such an element
    //      converted to nothing. When a host has a shadow root and no light
    //      children, we export the shadow content instead. Hosts that DO have
    //      light children are left alone, since their children are the slotted
    //      content and taking both would duplicate it.
    function cloneForExport(node) {
        const clone = node.cloneNode(false);
        const tag = node.nodeName;

        if (tag === 'TEXTAREA') {
            const val = typeof node.value === 'string' ? node.value : node.textContent;
            clone.textContent = val || '';
            return clone;
        }

        if (tag === 'INPUT') {
            const type = (node.getAttribute('type') || 'text').toLowerCase();
            if (type === 'checkbox' || type === 'radio') {
                if (node.checked) clone.setAttribute('checked', 'checked');
                else clone.removeAttribute('checked');
            } else if (node.value) {
                clone.setAttribute('value', node.value);
            }
            return clone;
        }

        const shadow = node.shadowRoot;
        const source = (shadow && node.children.length === 0) ? shadow : node;
        for (const child of source.childNodes) {
            if (child.nodeType === 1) clone.appendChild(cloneForExport(child));
            else if (child.nodeType === 3) clone.appendChild(child.cloneNode(false));
        }

        if (tag === 'SELECT') {
            const options = clone.querySelectorAll('option');
            for (const opt of options) opt.removeAttribute('selected');
            if (node.selectedIndex >= 0 && options[node.selectedIndex]) {
                options[node.selectedIndex].setAttribute('selected', 'selected');
            }
        }

        return clone;
    }

    function convertToMarkdown(element) {
        return turndownService.turndown(cloneForExport(element).outerHTML);
    }

    // ========================================================================
    // Preview modal
    // ========================================================================

    function showMarkdownModal(markdown) {
        const textarea = h('textarea');
        const preview = h('div', { class: 'h2m-preview' });
        const copyBtn = h('button', { class: 'h2m-copy', text: 'Copy to clipboard' });
        const downloadBtn = h('button', { class: 'h2m-download', text: 'Download as MD' });
        const closeBtn = h('button', { class: 'h2m-close', text: 'X' });
        const buttons = h('div', { class: 'h2m-buttons' }, copyBtn, downloadBtn);

        let obsidianSelect = null;
        if (obsidianEnabled) {
            obsidianSelect = h('select', { class: 'h2m-obsidian-select' });
            obsidianSelect.appendChild(h('option', { value: '', text: 'Send to Obsidian' }));
            for (const vault in obsidianConfig) {
                for (const path of obsidianConfig[vault]) {
                    obsidianSelect.appendChild(h('option', {
                        value: `obsidian://advanced-uri?vault=${vault}&filepath=${path}`,
                        text: `${vault}: ${path}`
                    }));
                }
            }
            buttons.appendChild(obsidianSelect);
        }

        const modal = h('div', { class: 'h2m-modal' }, textarea, preview, buttons, closeBtn);
        const overlay = h('div', { class: 'h2m-modal-overlay h2m-ui' }, modal);

        textarea.value = markdown;
        setHTML(preview, libs.marked.parse(markdown));

        textarea.addEventListener('input', function () {
            setHTML(preview, libs.marked.parse(textarea.value));
        });

        function close() {
            document.removeEventListener('keydown', onEscape, true);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }

        function onEscape(e) {
            if (e.key === 'Escape') { e.stopPropagation(); close(); }
        }

        closeBtn.addEventListener('click', close);
        document.addEventListener('keydown', onEscape, true);

        copyBtn.addEventListener('click', function () {
            GM_setClipboard(textarea.value);
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = 'Copy to clipboard'; }, 1000);
        });

        downloadBtn.addEventListener('click', function () {
            const blob = new Blob([textarea.value], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            // The anchor is deliberately NOT attached to the document, and this
            // is load-bearing. An anchor inside the page's DOM sends its click
            // through the page's own handlers: SPA routers and analytics
            // wrappers routinely preventDefault() anchor clicks and reopen the
            // href themselves, which turns the download into a blob: tab. It
            // would also pass through our own capture-phase click suppression,
            // which swallows it entirely if you download within 700ms of
            // converting. A detached anchor has no propagation path, so neither
            // can interfere. (Both were v0.4.0 regressions; v0.3.x did this.)
            const a = document.createElement('a');
            a.href = url;
            a.download = `${document.title.replace(/ /g, '_')}-${new Date().toISOString().replace(/:/g, '-')}.md`;
            a.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        });

        if (obsidianSelect) {
            obsidianSelect.addEventListener('change', function () {
                const val = obsidianSelect.value;
                if (!val) return;
                GM_setClipboard(textarea.value);
                const title = document.title.replace(/[\\/:*?"<>|]/g, '_');
                window.open(`${val}${title}.md&clipboard=true`);
            });
        }

        // Sync scrolling
        let isScrolling = false;
        textarea.addEventListener('scroll', function () {
            if (isScrolling) { isScrolling = false; return; }
            const pct = textarea.scrollTop / (textarea.scrollHeight - textarea.offsetHeight);
            preview.scrollTop = pct * (preview.scrollHeight - preview.offsetHeight);
            isScrolling = true;
        });
        preview.addEventListener('scroll', function () {
            if (isScrolling) { isScrolling = false; return; }
            const pct = preview.scrollTop / (preview.scrollHeight - preview.offsetHeight);
            textarea.scrollTop = pct * (textarea.scrollHeight - textarea.offsetHeight);
            isScrolling = true;
        });

        document.body.appendChild(overlay);
    }

    function tip(message, timeout) {
        const el = h('div', { class: 'h2m-tip h2m-ui' });
        setHTML(el, message);
        document.body.appendChild(el);
        if (!timeout) return el;
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, timeout);
        return el;
    }

    // ========================================================================
    // HIGHLIGHT OVERLAY
    //
    // v0.3.x added a CSS class to the hovered element itself. That fails in two
    // ways users read as "it didn't see the element": page CSS with higher
    // specificity (or !important) simply overrode the border, so the element
    // was selected but showed no highlight; and adding a 2px border reflowed
    // the page under the cursor, which moved the very thing being pointed at.
    // A separate fixed-position overlay drawn from getBoundingClientRect() has
    // neither problem, and cannot be styled away by the page.
    // ========================================================================

    let hlBox = null;
    let hlLabel = null;

    function ensureBox() {
        if (hlBox && hlBox.isConnected) return hlBox;
        hlBox = h('div', { class: 'h2m-ui' });
        hlBox.style.cssText = [
            'position:fixed !important', 'z-index:2147483646 !important',
            'pointer-events:none !important', 'display:none',
            'box-sizing:border-box !important',
            'border:2px dashed #f00 !important',
            'background-color:rgba(255,0,0,0.2) !important',
            'margin:0 !important', 'padding:0 !important', 'border-radius:0 !important',
            'transition:none !important', 'transform:none !important', 'opacity:1 !important'
        ].join(';');
        hlLabel = h('div', { class: 'h2m-ui' });
        hlLabel.style.cssText = [
            'position:absolute !important', 'left:0 !important', 'top:-20px !important',
            'font:11px/16px ui-monospace,Consolas,monospace !important',
            'color:#fff !important', 'background:#f00 !important',
            'padding:1px 5px !important', 'border-radius:3px !important',
            'white-space:nowrap !important', 'pointer-events:none !important'
        ].join(';');
        hlBox.appendChild(hlLabel);
        document.documentElement.appendChild(hlBox);
        return hlBox;
    }

    function describe(el) {
        let desc = el.nodeName.toLowerCase();
        if (el.id) desc += '#' + el.id;
        else if (el.classList && el.classList.length) desc += '.' + el.classList[0];
        if (el.getRootNode && el.getRootNode() !== document) desc += ' (shadow)';
        return desc;
    }

    // An element can be selected and still have an empty border box --
    // display:contents wrappers are the common case, and ArrowUp lands on them
    // regularly. Drawing the union of what it actually renders keeps the
    // highlight visible instead of silently blinking out.
    function rectOf(el, depth) {
        const r = el.getBoundingClientRect();
        if (r.width >= 1 || r.height >= 1) return r;
        if ((depth || 0) > 3) return r;
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, found = false;
        const kids = el.children;
        for (let i = 0; i < kids.length && i < 50; i++) {
            const kr = rectOf(kids[i], (depth || 0) + 1);
            if (kr.width < 1 && kr.height < 1) continue;
            found = true;
            left = Math.min(left, kr.left);
            top = Math.min(top, kr.top);
            right = Math.max(right, kr.right);
            bottom = Math.max(bottom, kr.bottom);
        }
        if (!found) return r;
        return { left: left, top: top, width: right - left, height: bottom - top };
    }

    function drawBox() {
        if (!selectedElement || !selectedElement.isConnected) { hideBox(); return; }
        const box = ensureBox();
        const r = rectOf(selectedElement, 0);
        box.style.display = 'block';
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        hlLabel.textContent = describe(selectedElement) + '  ' +
            Math.round(r.width) + '×' + Math.round(r.height) +
            (peelDepth > 0 ? '  z-' + peelDepth : '');
        hlLabel.style.top = (r.top < 20 ? r.height : -20) + 'px';
    }

    function hideBox() {
        if (hlBox) hlBox.style.display = 'none';
    }

    function select(el) {
        if (!el) { selectedElement = null; hideBox(); return; }
        selectedElement = el;
        drawBox();
    }

    // ========================================================================
    // HIT TESTING
    // ========================================================================

    function isCandidate(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node === document.documentElement) return false;
        if (node.closest && node.closest('.h2m-ui')) return false;
        return true;
    }

    // elementFromPoint stops at a shadow host; recurse into open shadow roots
    // so components resolve to the element actually under the cursor.
    function deepElementFromPoint(x, y) {
        let node = document.elementFromPoint(x, y);
        while (node && node.shadowRoot) {
            const inner = node.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === node) break;
            node = inner;
        }
        return node;
    }

    let peelDepth = 0;
    let peelBase = null;

    function stackAt(x, y) {
        const stack = document.elementsFromPoint(x, y).filter(isCandidate);
        return stack.length ? stack : null;
    }

    function pick(x, y, evt) {
        let target = null;
        // composedPath()[0] is the real target inside a shadow tree; plain
        // event.target is retargeted to the host and loses the inner element.
        if (evt && typeof evt.composedPath === 'function') {
            const path = evt.composedPath();
            if (path && path.length) target = path[0];
        }
        if (!target || target.nodeType !== 1) target = evt ? evt.target : null;
        if (!isCandidate(target)) target = deepElementFromPoint(x, y);

        if (target !== peelBase) { peelDepth = 0; peelBase = target; }
        if (peelDepth > 0) {
            const stack = stackAt(x, y);
            if (stack) target = stack[Math.min(peelDepth, stack.length - 1)];
        }
        return isCandidate(target) ? target : null;
    }

    // ========================================================================
    // CROSS-FRAME COORDINATION
    //
    // Selection state is per-document, so without this, moving the pointer into
    // an iframe lands in a document that is not in selecting mode and nothing
    // highlights -- the other half of "it doesn't even see the element".
    // Frames highlight and convert their own DOM; the modal always opens in the
    // top frame, where there is room for it.
    // ========================================================================

    function eachFrame(win, fn) {
        fn(win);
        let count = 0;
        try { count = win.length; } catch (e) { return; }
        for (let i = 0; i < count; i++) {
            try { eachFrame(win[i], fn); } catch (e) { /* cross-origin: still reachable via postMessage */ }
        }
    }

    function post(target, payload) {
        try { target.postMessage(Object.assign({ __h2m: MSG }, payload), '*'); } catch (e) { }
    }

    function broadcast(payload) {
        eachFrame(window.top, function (win) { post(win, payload); });
    }

    window.addEventListener('message', function (e) {
        const data = e.data;
        if (!data || data.__h2m !== MSG) return;
        switch (data.cmd) {
            case 'requestStart':
                if (IS_TOP) broadcast({ cmd: 'start' });
                break;
            case 'start':
                beginSelecting();
                break;
            case 'stop':
                endSelecting();
                break;
            case 'claim':
                // Another frame owns the pointer now; drop our stale highlight.
                if (data.frame !== frameId) { selectedElement = null; hideBox(); }
                break;
            case 'result':
                if (IS_TOP && typeof data.markdown === 'string') {
                    broadcast({ cmd: 'stop' });
                    showMarkdownModal(data.markdown);
                }
                break;
        }
    });

    const frameId = Math.random().toString(36).slice(2);
    let claimedAt = 0;

    function claimHover() {
        const now = Date.now();
        if (now - claimedAt < 150) return;
        claimedAt = now;
        if (!IS_TOP) post(window.top, { cmd: 'claim', frame: frameId });
        else broadcast({ cmd: 'claim', frame: frameId });
    }

    // ========================================================================
    // SELECTION MODE
    // ========================================================================

    let guideTip = null;

    function startSelecting() {
        // Route through the top frame so every frame enters the mode together.
        if (IS_TOP) broadcast({ cmd: 'start' });
        else post(window.top, { cmd: 'requestStart' });
    }

    function beginSelecting() {
        if (isSelecting) return;
        isSelecting = true;
        peelDepth = 0;
        peelBase = null;
        ensureLibs().catch(function (err) {
            if (IS_TOP) tip('Easy Web Page to Markdown: ' + err.message, 4000);
        });
        if (IS_TOP) {
            ensureLibs().then(function () {
                if (isSelecting && !guideTip) guideTip = tip(libs.marked.parse(guide));
            }).catch(function () { });
        }
    }

    function endSelecting() {
        isSelecting = false;
        selectedElement = null;
        peelDepth = 0;
        peelBase = null;
        hideBox();
        if (guideTip && guideTip.parentNode) guideTip.parentNode.removeChild(guideTip);
        guideTip = null;
    }

    function confirmSelection() {
        if (!selectedElement) return;
        const element = selectedElement;
        ensureLibs().then(function () {
            const markdown = convertToMarkdown(element);
            if (IS_TOP) {
                broadcast({ cmd: 'stop' });
                showMarkdownModal(markdown);
            } else {
                post(window.top, { cmd: 'result', markdown: markdown });
            }
        }).catch(function (err) {
            broadcast({ cmd: 'stop' });
            if (IS_TOP) tip('Easy Web Page to Markdown: ' + err.message, 4000);
        });
        endSelecting();
    }

    function stopEverywhere() {
        if (IS_TOP) broadcast({ cmd: 'stop' });
        else { post(window.top, { cmd: 'stop' }); endSelecting(); }
    }

    // ========================================================================
    // EVENT WIRING
    //
    // Everything is capture-phase. v0.3.x used bubble-phase handlers on
    // document, so any widget that called stopPropagation() on its own mouse
    // events created a dead zone where hovering highlighted nothing at all.
    // Capture runs before the page gets the event, so those zones now work.
    // ========================================================================

    function onMouseMove(e) {
        if (!isSelecting) return;
        claimHover();
        select(pick(e.clientX, e.clientY, e));
    }

    // Swallowing the mousedown is not enough: the mouseup, click and auxclick
    // that follow it must die too, or the page still sees a real click on
    // whatever was under the cursor -- selecting a link would navigate away.
    // A short window covers the whole sequence without stranding a boolean flag
    // when a page synthesizes only part of it.
    let suppressUntil = 0;

    function onMouseDown(e) {
        if (!isSelecting) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressUntil = Date.now() + 700;
        select(pick(e.clientX, e.clientY, e));
        confirmSelection();
    }

    function onClickish(e) {
        if (Date.now() > suppressUntil) return;
        // The modal opens immediately on conversion and sits under the cursor,
        // so never let the suppression window swallow clicks on our own UI.
        const target = e.target;
        if (target && target.closest && target.closest('.h2m-ui')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    function onWheel(e) {
        if (!isSelecting) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!selectedElement) return;
        if (e.deltaY < 0) selectParent();
        else selectFirstChild();
    }

    function selectParent() {
        const parent = selectedElement.parentElement ||
            (selectedElement.getRootNode() instanceof ShadowRoot ? selectedElement.getRootNode().host : null);
        if (parent && parent !== document.documentElement) select(parent);
    }

    function selectFirstChild() {
        const kid = selectedElement.firstElementChild ||
            (selectedElement.shadowRoot ? selectedElement.shadowRoot.firstElementChild : null);
        if (kid) select(kid);
    }

    function matchesShortcut(e) {
        return e.ctrlKey === shortCutConfig['Ctrl'] &&
            e.altKey === shortCutConfig['Alt'] &&
            e.shiftKey === shortCutConfig['Shift'] &&
            typeof e.key === 'string' &&
            e.key.toUpperCase() === shortCutConfig['Key'].toUpperCase();
    }

    function onKeyDown(e) {
        if (!isSelecting) {
            if (matchesShortcut(e)) { e.preventDefault(); startSelecting(); }
            return;
        }

        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stopEverywhere(); return; }
        if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); confirmSelection(); return; }
        if (!selectedElement) return;

        let handled = true;
        switch (e.key) {
            case 'ArrowUp': selectParent(); break;
            case 'ArrowDown': selectFirstChild(); break;
            case 'ArrowLeft': {
                let node = selectedElement;
                while (node && !node.previousElementSibling && node.parentElement) node = node.parentElement;
                if (node && node.previousElementSibling) select(node.previousElementSibling);
                break;
            }
            case 'ArrowRight': {
                let node = selectedElement;
                while (node && !node.nextElementSibling && node.parentElement) node = node.parentElement;
                if (node && node.nextElementSibling) select(node.nextElementSibling);
                break;
            }
            case 'z': case 'Z': {
                // Dig through overlapping layers at the cursor: transparent
                // overlays, sticky headers and full-page shields sit on top of
                // the content and would otherwise be all you can select.
                const stack = stackAt(lastX, lastY);
                if (stack) {
                    peelDepth = e.shiftKey ? Math.max(0, peelDepth - 1)
                                           : Math.min(peelDepth + 1, stack.length - 1);
                    peelBase = stack[0];
                    select(stack[Math.min(peelDepth, stack.length - 1)]);
                }
                break;
            }
            default: handled = false;
        }
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    }

    let lastX = 0, lastY = 0;
    document.addEventListener('mousemove', function (e) { lastX = e.clientX; lastY = e.clientY; }, true);

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onClickish, true);
    document.addEventListener('click', onClickish, true);
    document.addEventListener('auxclick', onClickish, true);
    document.addEventListener('dblclick', onClickish, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', function () { if (isSelecting) drawBox(); }, true);
    window.addEventListener('resize', function () { if (isSelecting) drawBox(); }, true);

    // ========================================================================
    // Turndown configuration
    // ========================================================================

    function buildTurndownService(lib) {
        const service = new lib.TurndownService({ codeBlockStyle: 'fenced' });
        lib.TurndownPluginGfmService.gfm(service); // Import all plugins

        // Remove metadata/non-content elements that should not appear in markdown output
        service.remove(['script', 'style', 'noscript']);

        // ====================================================================
        // FORM FIELD RULES - Capture input values, checkboxes, selects, textareas
        // ====================================================================

        // Helper: get input value (property first for live DOM, then attribute)
        function getFieldValue(node) {
            const prop = typeof node.value === 'string' ? node.value : null;
            const attr = node.getAttribute('value');
            return (prop ?? attr ?? '').trim();
        }

        // Rule: Checkbox and radio inputs - show checked state
        service.addRule('formCheckboxRadio', {
            filter: function (node) {
                if (node.nodeName !== 'INPUT') return false;
                const type = (node.getAttribute('type') || '').toLowerCase();
                return type === 'checkbox' || type === 'radio';
            },
            replacement: function (content, node) {
                const checked = node.checked || node.hasAttribute('checked');
                return `[${checked ? 'x' : ' '}]`;
            }
        });

        // Rule: Text-like inputs - output value inline
        service.addRule('formTextInputs', {
            filter: function (node) {
                if (node.nodeName !== 'INPUT') return false;
                const type = (node.getAttribute('type') || 'text').toLowerCase();
                const excludeTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'hidden', 'image'];
                return !excludeTypes.includes(type);
            },
            replacement: function (content, node) {
                return getFieldValue(node) || '';
            }
        });

        // Rule: Select elements - show selected option text
        service.addRule('formSelect', {
            filter: 'select',
            replacement: function (content, node) {
                const selectedIndex = node.selectedIndex;
                if (selectedIndex >= 0 && node.options && node.options[selectedIndex]) {
                    const opt = node.options[selectedIndex];
                    return opt.text || opt.value || '';
                }
                const selectedOpt = node.querySelector('option[selected]');
                if (selectedOpt) {
                    return selectedOpt.textContent || selectedOpt.getAttribute('value') || '';
                }
                return '';
            }
        });

        // Rule: Textarea - output content
        service.addRule('formTextarea', {
            filter: 'textarea',
            replacement: function (content, node) {
                const val = (node.value ?? node.textContent ?? '').trim();
                if (!val) return '';
                if (val.includes('\n')) return '\n```\n' + val + '\n```\n';
                return val;
            }
        });

        // Rule: Remove submit/reset/button inputs from output
        service.addRule('formButtonsRemove', {
            filter: function (node) {
                if (node.nodeName === 'BUTTON') return true;
                if (node.nodeName !== 'INPUT') return false;
                const type = (node.getAttribute('type') || '').toLowerCase();
                return type === 'button' || type === 'submit' || type === 'reset' || type === 'image';
            },
            replacement: function () { return ''; }
        });

        // ====================================================================
        // END FORM FIELD RULES
        // ====================================================================

        // Custom rule to normalize whitespace in link text
        service.addRule('normalizeLinkText', {
            filter: 'a',
            replacement: function (content, node) {
                const text = content.replace(/\s+/g, ' ').trim();
                const href = node.getAttribute('href') || '';
                const title = node.getAttribute('title');
                if (!href) return text;
                const titlePart = title ? ' "' + title.replace(/"/g, '\\"') + '"' : '';
                return '[' + text + '](' + href + titlePart + ')';
            }
        });

        return service;
    }

    // ========================================================================
    // Styles
    // ========================================================================

    GM_addStyle(`
        .h2m-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 80%;
            height: 80%;
            background: white;
            border-radius: 10px;
            display: flex;
            flex-direction: row;
            z-index: 9999;
        }
        .h2m-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 2147483645;
        }
        .h2m-modal textarea {
            width: 50%;
            height: 100%;
            padding: 20px;
            box-sizing: border-box;
            overflow-y: auto;
            color: #333;
            background-color: #fff;
            font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
            font-size: 14px;
            line-height: 1.6;
        }
        .h2m-modal .h2m-preview {
            all: initial;
            display: block;
            width: 50%;
            height: 100%;
            padding: 20px;
            box-sizing: border-box;
            overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 16px;
            line-height: 1.6;
            color: #333;
            background-color: #fff;
        }
        .h2m-modal .h2m-preview * {
            all: revert;
            color: inherit;
        }
        .h2m-modal .h2m-preview pre {
            background-color: #f6f8fa;
            border: 1px solid #e1e4e8;
            border-radius: 6px;
            padding: 12px 16px;
            overflow-x: auto;
        }
        .h2m-modal .h2m-preview code {
            font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
            font-size: 14px;
        }
        .h2m-modal .h2m-preview :not(pre) > code {
            background-color: #f0f0f0;
            padding: 2px 6px;
            border-radius: 4px;
        }
        .h2m-modal .h2m-buttons {
            position: absolute;
            bottom: 10px;
            right: 10px;
        }
        .h2m-modal .h2m-buttons button,
        .h2m-modal .h2m-obsidian-select {
            margin-left: 10px;
            background-color: #4CAF50;
            border: none;
            color: white;
            padding: 13px 16px;
            border-radius: 10px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 16px;
            transition-duration: 0.4s;
            cursor: pointer;
        }
        .h2m-modal .h2m-buttons button:hover,
        .h2m-modal .h2m-obsidian-select:hover {
            background-color: #45a049;
        }
        .h2m-modal .h2m-close {
            position: absolute;
            top: 10px;
            right: 10px;
            cursor: pointer;
            width: 25px;
            height: 25px;
            background-color: #f44336;
            color: white;
            font-size: 16px;
            border: none;
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .h2m-tip {
            position: fixed;
            top: 22%;
            left: 82%;
            transform: translate(-50%, -50%);
            border: 1px solid black;
            padding: 8px;
            z-index: 2147483647;
            border-radius: 10px;
            box-shadow: 5px 5px 10px rgba(0, 0, 0, 0.5);
            background-color: rgba(255, 255, 255, 0.9);
            color: #000;
            pointer-events: none;
            max-width: 320px;
        }
    `);

    // Register trigger
    shortCutConfig = shortCutConfig ? shortCutConfig : {
        "Shift": false,
        "Ctrl": true,
        "Alt": false,
        "Key": "m"
    };

    // Only the top frame registers a menu entry, otherwise every iframe on the
    // page adds its own duplicate command to the userscript manager's menu.
    if (IS_TOP) {
        GM_registerMenuCommand('Convert to Markdown', function () { startSelecting(); });
    }

    // ========================================================================
    // VENDORED LIBRARIES
    //
    // Inlined on purpose. @require and @resource both pull code from a CDN at
    // install or update time, which means the script can start running code
    // that nobody reviewed. These blocks are the published dist files verbatim;
    // the only edit is the wrapper function around each one, so the bytes
    // between the BEGIN and END markers hash to the SHA-256 recorded above them
    // and can be checked against the source URL at any time.
    //
    // Nothing here runs on page load. Declaring a function is free; these are
    // called only from initLibs(), on first activation.
    //
    // To update one: replace the bytes between its markers with the new dist
    // file, update the version, URL and SHA-256, and re-run the test suite.
    // ========================================================================

    /* turndown 7.2.4
       MIT -- Copyright (c) 2017 Dom Christie
       source: https://unpkg.com/turndown@7.2.4/dist/turndown.js
       sha256: c97187f436d41638bf7acf346a39d9d42f2f2c02af18245a297c09e796f8e46f
       Verbatim between the markers below; only the wrapper is ours. */
    function __h2mVendorTurndown(window, document, globalThis, self, module, exports, define) {
// --- BEGIN VENDORED turndown@7.2.4 ---
var TurndownService = (function () {
  'use strict';

  function extend(destination) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      for (var key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) destination[key] = source[key];
      }
    }
    return destination;
  }
  function repeat(character, count) {
    return Array(count + 1).join(character);
  }
  function trimLeadingNewlines(string) {
    return string.replace(/^\n*/, '');
  }
  function trimTrailingNewlines(string) {
    // avoid match-at-end regexp bottleneck, see #370
    var indexEnd = string.length;
    while (indexEnd > 0 && string[indexEnd - 1] === '\n') indexEnd--;
    return string.substring(0, indexEnd);
  }
  function trimNewlines(string) {
    return trimTrailingNewlines(trimLeadingNewlines(string));
  }
  var blockElements = ['ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'BLOCKQUOTE', 'BODY', 'CANVAS', 'CENTER', 'DD', 'DIR', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'FRAMESET', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'HTML', 'ISINDEX', 'LI', 'MAIN', 'MENU', 'NAV', 'NOFRAMES', 'NOSCRIPT', 'OL', 'OUTPUT', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'];
  function isBlock(node) {
    return is(node, blockElements);
  }
  var voidElements = ['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'];
  function isVoid(node) {
    return is(node, voidElements);
  }
  function hasVoid(node) {
    return has(node, voidElements);
  }
  var meaningfulWhenBlankElements = ['A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TH', 'TD', 'IFRAME', 'SCRIPT', 'AUDIO', 'VIDEO'];
  function isMeaningfulWhenBlank(node) {
    return is(node, meaningfulWhenBlankElements);
  }
  function hasMeaningfulWhenBlank(node) {
    return has(node, meaningfulWhenBlankElements);
  }
  function is(node, tagNames) {
    return tagNames.indexOf(node.nodeName) >= 0;
  }
  function has(node, tagNames) {
    return node.getElementsByTagName && tagNames.some(function (tagName) {
      return node.getElementsByTagName(tagName).length;
    });
  }
  var markdownEscapes = [[/\\/g, '\\\\'], [/\*/g, '\\*'], [/^-/g, '\\-'], [/^\+ /g, '\\+ '], [/^(=+)/g, '\\$1'], [/^(#{1,6}) /g, '\\$1 '], [/`/g, '\\`'], [/^~~~/g, '\\~~~'], [/\[/g, '\\['], [/\]/g, '\\]'], [/^>/g, '\\>'], [/_/g, '\\_'], [/^(\d+)\. /g, '$1\\. ']];
  function escapeMarkdown(string) {
    return markdownEscapes.reduce(function (accumulator, escape) {
      return accumulator.replace(escape[0], escape[1]);
    }, string);
  }

  var rules = {};
  rules.paragraph = {
    filter: 'p',
    replacement: function (content) {
      return '\n\n' + content + '\n\n';
    }
  };
  rules.lineBreak = {
    filter: 'br',
    replacement: function (content, node, options) {
      return options.br + '\n';
    }
  };
  rules.heading = {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: function (content, node, options) {
      var hLevel = Number(node.nodeName.charAt(1));
      if (options.headingStyle === 'setext' && hLevel < 3) {
        var underline = repeat(hLevel === 1 ? '=' : '-', content.length);
        return '\n\n' + content + '\n' + underline + '\n\n';
      } else {
        return '\n\n' + repeat('#', hLevel) + ' ' + content + '\n\n';
      }
    }
  };
  rules.blockquote = {
    filter: 'blockquote',
    replacement: function (content) {
      content = trimNewlines(content).replace(/^/gm, '> ');
      return '\n\n' + content + '\n\n';
    }
  };
  rules.list = {
    filter: ['ul', 'ol'],
    replacement: function (content, node) {
      var parent = node.parentNode;
      if (parent.nodeName === 'LI' && parent.lastElementChild === node) {
        return '\n' + content;
      } else {
        return '\n\n' + content + '\n\n';
      }
    }
  };
  rules.listItem = {
    filter: 'li',
    replacement: function (content, node, options) {
      var prefix = options.bulletListMarker + '   ';
      var parent = node.parentNode;
      if (parent.nodeName === 'OL') {
        var start = parent.getAttribute('start');
        var index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + '.  ';
      }
      var isParagraph = /\n$/.test(content);
      content = trimNewlines(content) + (isParagraph ? '\n' : '');
      content = content.replace(/\n/gm, '\n' + ' '.repeat(prefix.length)); // indent
      return prefix + content + (node.nextSibling ? '\n' : '');
    }
  };
  rules.indentedCodeBlock = {
    filter: function (node, options) {
      return options.codeBlockStyle === 'indented' && node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE';
    },
    replacement: function (content, node, options) {
      return '\n\n    ' + node.firstChild.textContent.replace(/\n/g, '\n    ') + '\n\n';
    }
  };
  rules.fencedCodeBlock = {
    filter: function (node, options) {
      return options.codeBlockStyle === 'fenced' && node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE';
    },
    replacement: function (content, node, options) {
      var className = node.firstChild.getAttribute('class') || '';
      var language = (className.match(/language-(\S+)/) || [null, ''])[1];
      var code = node.firstChild.textContent;
      var fenceChar = options.fence.charAt(0);
      var fenceSize = 3;
      var fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');
      var match;
      while (match = fenceInCodeRegex.exec(code)) {
        if (match[0].length >= fenceSize) {
          fenceSize = match[0].length + 1;
        }
      }
      var fence = repeat(fenceChar, fenceSize);
      return '\n\n' + fence + language + '\n' + code.replace(/\n$/, '') + '\n' + fence + '\n\n';
    }
  };
  rules.horizontalRule = {
    filter: 'hr',
    replacement: function (content, node, options) {
      return '\n\n' + options.hr + '\n\n';
    }
  };
  rules.inlineLink = {
    filter: function (node, options) {
      return options.linkStyle === 'inlined' && node.nodeName === 'A' && node.getAttribute('href');
    },
    replacement: function (content, node) {
      var href = escapeLinkDestination(node.getAttribute('href'));
      var title = escapeLinkTitle(cleanAttribute(node.getAttribute('title')));
      var titlePart = title ? ' "' + title + '"' : '';
      return '[' + content + '](' + href + titlePart + ')';
    }
  };
  rules.referenceLink = {
    filter: function (node, options) {
      return options.linkStyle === 'referenced' && node.nodeName === 'A' && node.getAttribute('href');
    },
    replacement: function (content, node, options) {
      var href = escapeLinkDestination(node.getAttribute('href'));
      var title = cleanAttribute(node.getAttribute('title'));
      if (title) title = ' "' + escapeLinkTitle(title) + '"';
      var replacement;
      var reference;
      switch (options.linkReferenceStyle) {
        case 'collapsed':
          replacement = '[' + content + '][]';
          reference = '[' + content + ']: ' + href + title;
          break;
        case 'shortcut':
          replacement = '[' + content + ']';
          reference = '[' + content + ']: ' + href + title;
          break;
        default:
          var id = this.references.length + 1;
          replacement = '[' + content + '][' + id + ']';
          reference = '[' + id + ']: ' + href + title;
      }
      this.references.push(reference);
      return replacement;
    },
    references: [],
    append: function (options) {
      var references = '';
      if (this.references.length) {
        references = '\n\n' + this.references.join('\n') + '\n\n';
        this.references = []; // Reset references
      }
      return references;
    }
  };
  rules.emphasis = {
    filter: ['em', 'i'],
    replacement: function (content, node, options) {
      if (!content.trim()) return '';
      return options.emDelimiter + content + options.emDelimiter;
    }
  };
  rules.strong = {
    filter: ['strong', 'b'],
    replacement: function (content, node, options) {
      if (!content.trim()) return '';
      return options.strongDelimiter + content + options.strongDelimiter;
    }
  };
  rules.code = {
    filter: function (node) {
      var hasSiblings = node.previousSibling || node.nextSibling;
      var isCodeBlock = node.parentNode.nodeName === 'PRE' && !hasSiblings;
      return node.nodeName === 'CODE' && !isCodeBlock;
    },
    replacement: function (content) {
      if (!content) return '';
      content = content.replace(/\r?\n|\r/g, ' ');
      var extraSpace = /^`|^ .*?[^ ].* $|`$/.test(content) ? ' ' : '';
      var delimiter = '`';
      var matches = content.match(/`+/gm) || [];
      while (matches.indexOf(delimiter) !== -1) delimiter = delimiter + '`';
      return delimiter + extraSpace + content + extraSpace + delimiter;
    }
  };
  rules.image = {
    filter: 'img',
    replacement: function (content, node) {
      var alt = escapeMarkdown(cleanAttribute(node.getAttribute('alt')));
      var src = escapeLinkDestination(node.getAttribute('src') || '');
      var title = cleanAttribute(node.getAttribute('title'));
      var titlePart = title ? ' "' + escapeLinkTitle(title) + '"' : '';
      return src ? '![' + alt + ']' + '(' + src + titlePart + ')' : '';
    }
  };
  function cleanAttribute(attribute) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
  }
  function escapeLinkDestination(destination) {
    var escaped = destination.replace(/([<>()])/g, '\\$1');
    return escaped.indexOf(' ') >= 0 ? '<' + escaped + '>' : escaped;
  }
  function escapeLinkTitle(title) {
    return title.replace(/"/g, '\\"');
  }

  /**
   * Manages a collection of rules used to convert HTML to Markdown
   */

  function Rules(options) {
    this.options = options;
    this._keep = [];
    this._remove = [];
    this.blankRule = {
      replacement: options.blankReplacement
    };
    this.keepReplacement = options.keepReplacement;
    this.defaultRule = {
      replacement: options.defaultReplacement
    };
    this.array = [];
    for (var key in options.rules) this.array.push(options.rules[key]);
  }
  Rules.prototype = {
    add: function (key, rule) {
      this.array.unshift(rule);
    },
    keep: function (filter) {
      this._keep.unshift({
        filter: filter,
        replacement: this.keepReplacement
      });
    },
    remove: function (filter) {
      this._remove.unshift({
        filter: filter,
        replacement: function () {
          return '';
        }
      });
    },
    forNode: function (node) {
      if (node.isBlank) return this.blankRule;
      var rule;
      if (rule = findRule(this.array, node, this.options)) return rule;
      if (rule = findRule(this._keep, node, this.options)) return rule;
      if (rule = findRule(this._remove, node, this.options)) return rule;
      return this.defaultRule;
    },
    forEach: function (fn) {
      for (var i = 0; i < this.array.length; i++) fn(this.array[i], i);
    }
  };
  function findRule(rules, node, options) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (filterValue(rule, node, options)) return rule;
    }
    return undefined;
  }
  function filterValue(rule, node, options) {
    var filter = rule.filter;
    if (typeof filter === 'string') {
      if (filter === node.nodeName.toLowerCase()) return true;
    } else if (Array.isArray(filter)) {
      if (filter.indexOf(node.nodeName.toLowerCase()) > -1) return true;
    } else if (typeof filter === 'function') {
      if (filter.call(rule, node, options)) return true;
    } else {
      throw new TypeError('`filter` needs to be a string, array, or function');
    }
  }

  /**
   * The collapseWhitespace function is adapted from collapse-whitespace
   * by Luc Thevenard.
   *
   * The MIT License (MIT)
   *
   * Copyright (c) 2014 Luc Thevenard <lucthevenard@gmail.com>
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in
   * all copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   * THE SOFTWARE.
   */

  /**
   * collapseWhitespace(options) removes extraneous whitespace from an the given element.
   *
   * @param {Object} options
   */
  function collapseWhitespace(options) {
    var element = options.element;
    var isBlock = options.isBlock;
    var isVoid = options.isVoid;
    var isPre = options.isPre || function (node) {
      return node.nodeName === 'PRE';
    };
    if (!element.firstChild || isPre(element)) return;
    var prevText = null;
    var keepLeadingWs = false;
    var prev = null;
    var node = next(prev, element, isPre);
    while (node !== element) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        // Node.TEXT_NODE or Node.CDATA_SECTION_NODE
        var text = node.data.replace(/[ \r\n\t]+/g, ' ');
        if ((!prevText || / $/.test(prevText.data)) && !keepLeadingWs && text[0] === ' ') {
          text = text.substr(1);
        }

        // `text` might be empty at this point.
        if (!text) {
          node = remove(node);
          continue;
        }
        node.data = text;
        prevText = node;
      } else if (node.nodeType === 1) {
        // Node.ELEMENT_NODE
        if (isBlock(node) || node.nodeName === 'BR') {
          if (prevText) {
            prevText.data = prevText.data.replace(/ $/, '');
          }
          prevText = null;
          keepLeadingWs = false;
        } else if (isVoid(node) || isPre(node)) {
          // Avoid trimming space around non-block, non-BR void elements and inline PRE.
          prevText = null;
          keepLeadingWs = true;
        } else if (prevText) {
          // Drop protection if set previously.
          keepLeadingWs = false;
        }
      } else {
        node = remove(node);
        continue;
      }
      var nextNode = next(prev, node, isPre);
      prev = node;
      node = nextNode;
    }
    if (prevText) {
      prevText.data = prevText.data.replace(/ $/, '');
      if (!prevText.data) {
        remove(prevText);
      }
    }
  }

  /**
   * remove(node) removes the given node from the DOM and returns the
   * next node in the sequence.
   *
   * @param {Node} node
   * @return {Node} node
   */
  function remove(node) {
    var next = node.nextSibling || node.parentNode;
    node.parentNode.removeChild(node);
    return next;
  }

  /**
   * next(prev, current, isPre) returns the next node in the sequence, given the
   * current and previous nodes.
   *
   * @param {Node} prev
   * @param {Node} current
   * @param {Function} isPre
   * @return {Node}
   */
  function next(prev, current, isPre) {
    if (prev && prev.parentNode === current || isPre(current)) {
      return current.nextSibling || current.parentNode;
    }
    return current.firstChild || current.nextSibling || current.parentNode;
  }

  /*
   * Set up window for Node.js
   */

  var root = typeof window !== 'undefined' ? window : {};

  /*
   * Parsing HTML strings
   */

  function canParseHTMLNatively() {
    var Parser = root.DOMParser;
    var canParse = false;

    // Adapted from https://gist.github.com/1129031
    // Firefox/Opera/IE throw errors on unsupported types
    try {
      // WebKit returns null on unsupported types
      if (new Parser().parseFromString('', 'text/html')) {
        canParse = true;
      }
    } catch (e) {}
    return canParse;
  }
  function createHTMLParser() {
    var Parser = function () {};
    {
      if (shouldUseActiveX()) {
        Parser.prototype.parseFromString = function (string) {
          var doc = new window.ActiveXObject('htmlfile');
          doc.designMode = 'on'; // disable on-page scripts
          doc.open();
          doc.write(string);
          doc.close();
          return doc;
        };
      } else {
        Parser.prototype.parseFromString = function (string) {
          var doc = document.implementation.createHTMLDocument('');
          doc.open();
          doc.write(string);
          doc.close();
          return doc;
        };
      }
    }
    return Parser;
  }
  function shouldUseActiveX() {
    var useActiveX = false;
    try {
      document.implementation.createHTMLDocument('').open();
    } catch (e) {
      if (root.ActiveXObject) useActiveX = true;
    }
    return useActiveX;
  }
  var HTMLParser = canParseHTMLNatively() ? root.DOMParser : createHTMLParser();

  function RootNode(input, options) {
    var root;
    if (typeof input === 'string') {
      var doc = htmlParser().parseFromString(
      // DOM parsers arrange elements in the <head> and <body>.
      // Wrapping in a custom element ensures elements are reliably arranged in
      // a single element.
      '<x-turndown id="turndown-root">' + input + '</x-turndown>', 'text/html');
      root = doc.getElementById('turndown-root');
    } else {
      root = input.cloneNode(true);
    }
    collapseWhitespace({
      element: root,
      isBlock: isBlock,
      isVoid: isVoid,
      isPre: options.preformattedCode ? isPreOrCode : null
    });
    return root;
  }
  var _htmlParser;
  function htmlParser() {
    _htmlParser = _htmlParser || new HTMLParser();
    return _htmlParser;
  }
  function isPreOrCode(node) {
    return node.nodeName === 'PRE' || node.nodeName === 'CODE';
  }

  function Node(node, options) {
    node.isBlock = isBlock(node);
    node.isCode = node.nodeName === 'CODE' || node.parentNode.isCode;
    node.isBlank = isBlank(node);
    node.flankingWhitespace = flankingWhitespace(node, options);
    return node;
  }
  function isBlank(node) {
    return !isVoid(node) && !isMeaningfulWhenBlank(node) && /^\s*$/i.test(node.textContent) && !hasVoid(node) && !hasMeaningfulWhenBlank(node);
  }
  function flankingWhitespace(node, options) {
    if (node.isBlock || options.preformattedCode && node.isCode) {
      return {
        leading: '',
        trailing: ''
      };
    }
    var edges = edgeWhitespace(node.textContent);

    // abandon leading ASCII WS if left-flanked by ASCII WS
    if (edges.leadingAscii && isFlankedByWhitespace('left', node, options)) {
      edges.leading = edges.leadingNonAscii;
    }

    // abandon trailing ASCII WS if right-flanked by ASCII WS
    if (edges.trailingAscii && isFlankedByWhitespace('right', node, options)) {
      edges.trailing = edges.trailingNonAscii;
    }
    return {
      leading: edges.leading,
      trailing: edges.trailing
    };
  }
  function edgeWhitespace(string) {
    var m = string.match(/^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/);
    return {
      leading: m[1],
      // whole string for whitespace-only strings
      leadingAscii: m[2],
      leadingNonAscii: m[3],
      trailing: m[4],
      // empty for whitespace-only strings
      trailingNonAscii: m[5],
      trailingAscii: m[6]
    };
  }
  function isFlankedByWhitespace(side, node, options) {
    var sibling;
    var regExp;
    var isFlanked;
    if (side === 'left') {
      sibling = node.previousSibling;
      regExp = / $/;
    } else {
      sibling = node.nextSibling;
      regExp = /^ /;
    }
    if (sibling) {
      if (sibling.nodeType === 3) {
        isFlanked = regExp.test(sibling.nodeValue);
      } else if (options.preformattedCode && sibling.nodeName === 'CODE') {
        isFlanked = false;
      } else if (sibling.nodeType === 1 && !isBlock(sibling)) {
        isFlanked = regExp.test(sibling.textContent);
      }
    }
    return isFlanked;
  }

  var reduce = Array.prototype.reduce;
  function TurndownService(options) {
    if (!(this instanceof TurndownService)) return new TurndownService(options);
    var defaults = {
      rules: rules,
      headingStyle: 'setext',
      hr: '* * *',
      bulletListMarker: '*',
      codeBlockStyle: 'indented',
      fence: '```',
      emDelimiter: '_',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      linkReferenceStyle: 'full',
      br: '  ',
      preformattedCode: false,
      blankReplacement: function (content, node) {
        return node.isBlock ? '\n\n' : '';
      },
      keepReplacement: function (content, node) {
        return node.isBlock ? '\n\n' + node.outerHTML + '\n\n' : node.outerHTML;
      },
      defaultReplacement: function (content, node) {
        return node.isBlock ? '\n\n' + content + '\n\n' : content;
      }
    };
    this.options = extend({}, defaults, options);
    this.rules = new Rules(this.options);
  }
  TurndownService.prototype = {
    /**
     * The entry point for converting a string or DOM node to Markdown
     * @public
     * @param {String|HTMLElement} input The string or DOM node to convert
     * @returns A Markdown representation of the input
     * @type String
     */

    turndown: function (input) {
      if (!canConvert(input)) {
        throw new TypeError(input + ' is not a string, or an element/document/fragment node.');
      }
      if (input === '') return '';
      var output = process.call(this, new RootNode(input, this.options));
      return postProcess.call(this, output);
    },
    /**
     * Add one or more plugins
     * @public
     * @param {Function|Array} plugin The plugin or array of plugins to add
     * @returns The Turndown instance for chaining
     * @type Object
     */

    use: function (plugin) {
      if (Array.isArray(plugin)) {
        for (var i = 0; i < plugin.length; i++) this.use(plugin[i]);
      } else if (typeof plugin === 'function') {
        plugin(this);
      } else {
        throw new TypeError('plugin must be a Function or an Array of Functions');
      }
      return this;
    },
    /**
     * Adds a rule
     * @public
     * @param {String} key The unique key of the rule
     * @param {Object} rule The rule
     * @returns The Turndown instance for chaining
     * @type Object
     */

    addRule: function (key, rule) {
      this.rules.add(key, rule);
      return this;
    },
    /**
     * Keep a node (as HTML) that matches the filter
     * @public
     * @param {String|Array|Function} filter The unique key of the rule
     * @returns The Turndown instance for chaining
     * @type Object
     */

    keep: function (filter) {
      this.rules.keep(filter);
      return this;
    },
    /**
     * Remove a node that matches the filter
     * @public
     * @param {String|Array|Function} filter The unique key of the rule
     * @returns The Turndown instance for chaining
     * @type Object
     */

    remove: function (filter) {
      this.rules.remove(filter);
      return this;
    },
    /**
     * Escapes Markdown syntax
     * @public
     * @param {String} string The string to escape
     * @returns A string with Markdown syntax escaped
     * @type String
     */

    escape: function (string) {
      return escapeMarkdown(string);
    }
  };

  /**
   * Reduces a DOM node down to its Markdown string equivalent
   * @private
   * @param {HTMLElement} parentNode The node to convert
   * @returns A Markdown representation of the node
   * @type String
   */

  function process(parentNode) {
    var self = this;
    return reduce.call(parentNode.childNodes, function (output, node) {
      node = new Node(node, self.options);
      var replacement = '';
      if (node.nodeType === 3) {
        replacement = node.isCode ? node.nodeValue : self.escape(node.nodeValue);
      } else if (node.nodeType === 1) {
        replacement = replacementForNode.call(self, node);
      }
      return join(output, replacement);
    }, '');
  }

  /**
   * Appends strings as each rule requires and trims the output
   * @private
   * @param {String} output The conversion output
   * @returns A trimmed version of the ouput
   * @type String
   */

  function postProcess(output) {
    var self = this;
    this.rules.forEach(function (rule) {
      if (typeof rule.append === 'function') {
        output = join(output, rule.append(self.options));
      }
    });
    return output.replace(/^[\t\r\n]+/, '').replace(/[\t\r\n\s]+$/, '');
  }

  /**
   * Converts an element node to its Markdown equivalent
   * @private
   * @param {HTMLElement} node The node to convert
   * @returns A Markdown representation of the node
   * @type String
   */

  function replacementForNode(node) {
    var rule = this.rules.forNode(node);
    var content = process.call(this, node);
    var whitespace = node.flankingWhitespace;
    if (whitespace.leading || whitespace.trailing) content = content.trim();
    return whitespace.leading + rule.replacement(content, node, this.options) + whitespace.trailing;
  }

  /**
   * Joins replacement to the current output with appropriate number of new lines
   * @private
   * @param {String} output The current conversion output
   * @param {String} replacement The string to append to the output
   * @returns Joined output
   * @type String
   */

  function join(output, replacement) {
    var s1 = trimTrailingNewlines(output);
    var s2 = trimLeadingNewlines(replacement);
    var nls = Math.max(output.length - s1.length, replacement.length - s2.length);
    var separator = '\n\n'.substring(0, nls);
    return s1 + separator + s2;
  }

  /**
   * Determines whether an input can be converted
   * @private
   * @param {String|HTMLElement} input Describe this parameter
   * @returns Describe what it returns
   * @type String|Object|Array|Boolean|Number
   */

  function canConvert(input) {
    return input != null && (typeof input === 'string' || input.nodeType && (input.nodeType === 1 || input.nodeType === 9 || input.nodeType === 11));
  }

  return TurndownService;

})();
// --- END VENDORED turndown@7.2.4 ---
        return typeof TurndownService !== 'undefined' ? TurndownService : undefined;
    }

    /* @guyplusplus/turndown-plugin-gfm 1.0.7
       MIT -- Copyright (c) 2017 Dom Christie
       source: https://unpkg.com/@guyplusplus/turndown-plugin-gfm@1.0.7/dist/turndown-plugin-gfm.js
       sha256: ad5f83cbb02a3e684d67acf9e8279615c3d7aada1c4c1695a4ac85be6616c99a
       Verbatim between the markers below; only the wrapper is ours. */
    function __h2mVendorTurndownGfm(window, document, globalThis, self, module, exports, define) {
// --- BEGIN VENDORED @guyplusplus/turndown-plugin-gfm@1.0.7 ---
var TurndownPluginGfmService = (function (exports) {
  'use strict';

  var highlightRegExp = /highlight-(?:text|source)-([a-z0-9]+)/;

  function highlightedCodeBlock (turndownService) {
    turndownService.addRule('highlightedCodeBlock', {
      filter: function (node) {
        var firstChild = node.firstChild;
        return (
          node.nodeName === 'DIV' &&
          highlightRegExp.test(node.className) &&
          firstChild &&
          firstChild.nodeName === 'PRE'
        )
      },
      replacement: function (content, node, options) {
        var className = node.className || '';
        var language = (className.match(highlightRegExp) || [null, ''])[1];

        return (
          '\n\n' + options.fence + language + '\n' +
          node.firstChild.textContent +
          '\n' + options.fence + '\n\n'
        )
      }
    });
  }

  function strikethrough (turndownService) {
    turndownService.addRule('strikethrough', {
      filter: ['del', 's', 'strike'],
      replacement: function (content) {
        return '~' + content + '~'
      }
    });
  }

  var indexOf = Array.prototype.indexOf;
  var rules = {};

  rules.tableCell = {
    filter: ['th', 'td'],
    replacement: function (content, node) {
      return cell(content, node) + spannedCells(node, '')
    }
  };

  rules.tableRow = {
    filter: 'tr',
    replacement: function (content, node) {
      var borderCells = '';
      var alignMap = { left: ':--', right: '--:', center: ':-:' };

      if (isHeadingRow(node)) {
        for (var i = 0; i < node.childNodes.length; i++) {
          var border = '---';
          var align = (
            node.childNodes[i].getAttribute('align') || ''
          ).toLowerCase();

          if (align) border = alignMap[align] || border;

          borderCells += cell(border, node.childNodes[i]) + spannedCells(node.childNodes[i], border);
        }
      }
      return '\n' + content + (borderCells ? '\n' + borderCells : '')
    }
  };

  rules.table = {
    // Only convert tables that are not nested in another table, they are kept using `keep` (see below).
    // TODO: nested tables should be converted to plain text in a strict (non HTML) gfm
    filter: function (node) {
      return node.nodeName === 'TABLE' && !isNestedTable(node)
    },

    replacement: function (content) {
      // Ensure there are no blank lines
      content = content.replace('\n\n', '\n');
      return '\n\n' + content + '\n\n'
    }
  };

  rules.tableSection = {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: function (content) {
      return content
    }
  };

  rules.captionSection = {
    // only return content if caption if the first node immediately after TABLE
    filter: 'caption',
    replacement: function (content, node) {
      if (node.parentNode.nodeName === 'TABLE' && node.parentNode.childNodes[0] === node) return content
      return ''
    }
  };

  function isHeadingRow (tr) {
    var parentNode = tr.parentNode;
    var tableNode = parentNode;
    if (parentNode.nodeName === 'THEAD' ||
       parentNode.nodeName === 'TFOOT' ||
       parentNode.nodeName === 'TBODY') {
      tableNode = parentNode.parentNode;
    }
    return (tableNode.nodeName === 'TABLE' && tableNode.rows[0] === tr)
  }

  function cell (content, node) {
    var index = indexOf.call(node.parentNode.childNodes, node);
    var prefix = ' ';
    if (index === 0) prefix = '| ';
    // Ensure single line per cell (both windows and unix EoL)
    // TODO: allow gfm non-strict mode to replace new lines by `<br/>`
    content = content.replace(/\r\n/g, '\n').replace(/\n/g, ' ');
    // | must be escaped as \|
    content = content.replace(/\|/g, '\\|');
    return prefix + content + ' |'
  }

  function spannedCells (node, spannedCellContent) {
    var colspan = node.getAttribute('colspan') || 1;
    if (colspan <= 1) return ''
    return (' ' + spannedCellContent + ' |').repeat(colspan - 1)
  }

  function isNestedTable (tableNode) {
    var currentNode = tableNode.parentNode;
    while (currentNode) {
      if (currentNode.nodeName === 'TABLE') return true
      currentNode = currentNode.parentNode;
    }
    return false
  }

  function tables (turndownService) {
    turndownService.keep(function (node) {
      return node.nodeName === 'TABLE' && isNestedTable(node)
    });
    for (var key in rules) turndownService.addRule(key, rules[key]);
  }

  function taskListItems (turndownService) {
    turndownService.addRule('taskListItems', {
      filter: function (node) {
        return node.type === 'checkbox' && node.parentNode.nodeName === 'LI'
      },
      replacement: function (content, node) {
        return (node.checked ? '[x]' : '[ ]') + ' '
      }
    });
  }

  function gfm (turndownService) {
    turndownService.use([
      highlightedCodeBlock,
      strikethrough,
      tables,
      taskListItems
    ]);
  }

  exports.gfm = gfm;
  exports.highlightedCodeBlock = highlightedCodeBlock;
  exports.strikethrough = strikethrough;
  exports.tables = tables;
  exports.taskListItems = taskListItems;

  Object.defineProperty(exports, '__esModule', { value: true });

  return exports;

}({}));
// --- END VENDORED @guyplusplus/turndown-plugin-gfm@1.0.7 ---
        return typeof TurndownPluginGfmService !== 'undefined' ? TurndownPluginGfmService : undefined;
    }

    /* marked 12.0.0
       MIT -- Copyright (c) 2011-2024 Christopher Jeffrey
       source: https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js
       sha256: eb1f6b19880bc80a5fe34c6a61885173b60edda455ba7a33c98714db17d39f99
       Verbatim between the markers below; only the wrapper is ours. */
    function __h2mVendorMarked(window, document, globalThis, self, module, exports, define) {
// --- BEGIN VENDORED marked@12.0.0 ---
/**
 * marked v12.0.0 - a markdown parser
 * Copyright (c) 2011-2024, Christopher Jeffrey. (MIT Licensed)
 * https://github.com/markedjs/marked
 */
!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?t(exports):"function"==typeof define&&define.amd?define(["exports"],t):t((e="undefined"!=typeof globalThis?globalThis:e||self).marked={})}(this,(function(e){"use strict";function t(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}function n(t){e.defaults=t}e.defaults={async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null};const s=/[&<>"']/,r=new RegExp(s.source,"g"),i=/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,l=new RegExp(i.source,"g"),o={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"},a=e=>o[e];function c(e,t){if(t){if(s.test(e))return e.replace(r,a)}else if(i.test(e))return e.replace(l,a);return e}const h=/&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/gi;function p(e){return e.replace(h,((e,t)=>"colon"===(t=t.toLowerCase())?":":"#"===t.charAt(0)?"x"===t.charAt(1)?String.fromCharCode(parseInt(t.substring(2),16)):String.fromCharCode(+t.substring(1)):""))}const u=/(^|[^\[])\^/g;function k(e,t){let n="string"==typeof e?e:e.source;t=t||"";const s={replace:(e,t)=>{let r="string"==typeof t?t:t.source;return r=r.replace(u,"$1"),n=n.replace(e,r),s},getRegex:()=>new RegExp(n,t)};return s}function g(e){try{e=encodeURI(e).replace(/%25/g,"%")}catch(e){return null}return e}const f={exec:()=>null};function d(e,t){const n=e.replace(/\|/g,((e,t,n)=>{let s=!1,r=t;for(;--r>=0&&"\\"===n[r];)s=!s;return s?"|":" |"})).split(/ \|/);let s=0;if(n[0].trim()||n.shift(),n.length>0&&!n[n.length-1].trim()&&n.pop(),t)if(n.length>t)n.splice(t);else for(;n.length<t;)n.push("");for(;s<n.length;s++)n[s]=n[s].trim().replace(/\\\|/g,"|");return n}function x(e,t,n){const s=e.length;if(0===s)return"";let r=0;for(;r<s;){const i=e.charAt(s-r-1);if(i!==t||n){if(i===t||!n)break;r++}else r++}return e.slice(0,s-r)}function b(e,t,n,s){const r=t.href,i=t.title?c(t.title):null,l=e[1].replace(/\\([\[\]])/g,"$1");if("!"!==e[0].charAt(0)){s.state.inLink=!0;const e={type:"link",raw:n,href:r,title:i,text:l,tokens:s.inlineTokens(l)};return s.state.inLink=!1,e}return{type:"image",raw:n,href:r,title:i,text:c(l)}}class w{options;rules;lexer;constructor(t){this.options=t||e.defaults}space(e){const t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:"space",raw:t[0]}}code(e){const t=this.rules.block.code.exec(e);if(t){const e=t[0].replace(/^ {1,4}/gm,"");return{type:"code",raw:t[0],codeBlockStyle:"indented",text:this.options.pedantic?e:x(e,"\n")}}}fences(e){const t=this.rules.block.fences.exec(e);if(t){const e=t[0],n=function(e,t){const n=e.match(/^(\s+)(?:```)/);if(null===n)return t;const s=n[1];return t.split("\n").map((e=>{const t=e.match(/^\s+/);if(null===t)return e;const[n]=t;return n.length>=s.length?e.slice(s.length):e})).join("\n")}(e,t[3]||"");return{type:"code",raw:e,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,"$1"):t[2],text:n}}}heading(e){const t=this.rules.block.heading.exec(e);if(t){let e=t[2].trim();if(/#$/.test(e)){const t=x(e,"#");this.options.pedantic?e=t.trim():t&&!/ $/.test(t)||(e=t.trim())}return{type:"heading",raw:t[0],depth:t[1].length,text:e,tokens:this.lexer.inline(e)}}}hr(e){const t=this.rules.block.hr.exec(e);if(t)return{type:"hr",raw:t[0]}}blockquote(e){const t=this.rules.block.blockquote.exec(e);if(t){const e=x(t[0].replace(/^ *>[ \t]?/gm,""),"\n"),n=this.lexer.state.top;this.lexer.state.top=!0;const s=this.lexer.blockTokens(e);return this.lexer.state.top=n,{type:"blockquote",raw:t[0],tokens:s,text:e}}}list(e){let t=this.rules.block.list.exec(e);if(t){let n=t[1].trim();const s=n.length>1,r={type:"list",raw:"",ordered:s,start:s?+n.slice(0,-1):"",loose:!1,items:[]};n=s?`\\d{1,9}\\${n.slice(-1)}`:`\\${n}`,this.options.pedantic&&(n=s?n:"[*+-]");const i=new RegExp(`^( {0,3}${n})((?:[\t ][^\\n]*)?(?:\\n|$))`);let l="",o="",a=!1;for(;e;){let n=!1;if(!(t=i.exec(e)))break;if(this.rules.block.hr.test(e))break;l=t[0],e=e.substring(l.length);let s=t[2].split("\n",1)[0].replace(/^\t+/,(e=>" ".repeat(3*e.length))),c=e.split("\n",1)[0],h=0;this.options.pedantic?(h=2,o=s.trimStart()):(h=t[2].search(/[^ ]/),h=h>4?1:h,o=s.slice(h),h+=t[1].length);let p=!1;if(!s&&/^ *$/.test(c)&&(l+=c+"\n",e=e.substring(c.length+1),n=!0),!n){const t=new RegExp(`^ {0,${Math.min(3,h-1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),n=new RegExp(`^ {0,${Math.min(3,h-1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`),r=new RegExp(`^ {0,${Math.min(3,h-1)}}(?:\`\`\`|~~~)`),i=new RegExp(`^ {0,${Math.min(3,h-1)}}#`);for(;e;){const a=e.split("\n",1)[0];if(c=a,this.options.pedantic&&(c=c.replace(/^ {1,4}(?=( {4})*[^ ])/g,"  ")),r.test(c))break;if(i.test(c))break;if(t.test(c))break;if(n.test(e))break;if(c.search(/[^ ]/)>=h||!c.trim())o+="\n"+c.slice(h);else{if(p)break;if(s.search(/[^ ]/)>=4)break;if(r.test(s))break;if(i.test(s))break;if(n.test(s))break;o+="\n"+c}p||c.trim()||(p=!0),l+=a+"\n",e=e.substring(a.length+1),s=c.slice(h)}}r.loose||(a?r.loose=!0:/\n *\n *$/.test(l)&&(a=!0));let u,k=null;this.options.gfm&&(k=/^\[[ xX]\] /.exec(o),k&&(u="[ ] "!==k[0],o=o.replace(/^\[[ xX]\] +/,""))),r.items.push({type:"list_item",raw:l,task:!!k,checked:u,loose:!1,text:o,tokens:[]}),r.raw+=l}r.items[r.items.length-1].raw=l.trimEnd(),r.items[r.items.length-1].text=o.trimEnd(),r.raw=r.raw.trimEnd();for(let e=0;e<r.items.length;e++)if(this.lexer.state.top=!1,r.items[e].tokens=this.lexer.blockTokens(r.items[e].text,[]),!r.loose){const t=r.items[e].tokens.filter((e=>"space"===e.type)),n=t.length>0&&t.some((e=>/\n.*\n/.test(e.raw)));r.loose=n}if(r.loose)for(let e=0;e<r.items.length;e++)r.items[e].loose=!0;return r}}html(e){const t=this.rules.block.html.exec(e);if(t){return{type:"html",block:!0,raw:t[0],pre:"pre"===t[1]||"script"===t[1]||"style"===t[1],text:t[0]}}}def(e){const t=this.rules.block.def.exec(e);if(t){const e=t[1].toLowerCase().replace(/\s+/g," "),n=t[2]?t[2].replace(/^<(.*)>$/,"$1").replace(this.rules.inline.anyPunctuation,"$1"):"",s=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,"$1"):t[3];return{type:"def",tag:e,raw:t[0],href:n,title:s}}}table(e){const t=this.rules.block.table.exec(e);if(!t)return;if(!/[:|]/.test(t[2]))return;const n=d(t[1]),s=t[2].replace(/^\||\| *$/g,"").split("|"),r=t[3]&&t[3].trim()?t[3].replace(/\n[ \t]*$/,"").split("\n"):[],i={type:"table",raw:t[0],header:[],align:[],rows:[]};if(n.length===s.length){for(const e of s)/^ *-+: *$/.test(e)?i.align.push("right"):/^ *:-+: *$/.test(e)?i.align.push("center"):/^ *:-+ *$/.test(e)?i.align.push("left"):i.align.push(null);for(const e of n)i.header.push({text:e,tokens:this.lexer.inline(e)});for(const e of r)i.rows.push(d(e,i.header.length).map((e=>({text:e,tokens:this.lexer.inline(e)}))));return i}}lheading(e){const t=this.rules.block.lheading.exec(e);if(t)return{type:"heading",raw:t[0],depth:"="===t[2].charAt(0)?1:2,text:t[1],tokens:this.lexer.inline(t[1])}}paragraph(e){const t=this.rules.block.paragraph.exec(e);if(t){const e="\n"===t[1].charAt(t[1].length-1)?t[1].slice(0,-1):t[1];return{type:"paragraph",raw:t[0],text:e,tokens:this.lexer.inline(e)}}}text(e){const t=this.rules.block.text.exec(e);if(t)return{type:"text",raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){const t=this.rules.inline.escape.exec(e);if(t)return{type:"escape",raw:t[0],text:c(t[1])}}tag(e){const t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&/^<a /i.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&/^<\/a>/i.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&/^<(pre|code|kbd|script)(\s|>)/i.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&/^<\/(pre|code|kbd|script)(\s|>)/i.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:"html",raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){const t=this.rules.inline.link.exec(e);if(t){const e=t[2].trim();if(!this.options.pedantic&&/^</.test(e)){if(!/>$/.test(e))return;const t=x(e.slice(0,-1),"\\");if((e.length-t.length)%2==0)return}else{const e=function(e,t){if(-1===e.indexOf(t[1]))return-1;let n=0;for(let s=0;s<e.length;s++)if("\\"===e[s])s++;else if(e[s]===t[0])n++;else if(e[s]===t[1]&&(n--,n<0))return s;return-1}(t[2],"()");if(e>-1){const n=(0===t[0].indexOf("!")?5:4)+t[1].length+e;t[2]=t[2].substring(0,e),t[0]=t[0].substring(0,n).trim(),t[3]=""}}let n=t[2],s="";if(this.options.pedantic){const e=/^([^'"]*[^\s])\s+(['"])(.*)\2/.exec(n);e&&(n=e[1],s=e[3])}else s=t[3]?t[3].slice(1,-1):"";return n=n.trim(),/^</.test(n)&&(n=this.options.pedantic&&!/>$/.test(e)?n.slice(1):n.slice(1,-1)),b(t,{href:n?n.replace(this.rules.inline.anyPunctuation,"$1"):n,title:s?s.replace(this.rules.inline.anyPunctuation,"$1"):s},t[0],this.lexer)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){const e=t[(n[2]||n[1]).replace(/\s+/g," ").toLowerCase()];if(!e){const e=n[0].charAt(0);return{type:"text",raw:e,text:e}}return b(n,e,n[0],this.lexer)}}emStrong(e,t,n=""){let s=this.rules.inline.emStrongLDelim.exec(e);if(!s)return;if(s[3]&&n.match(/[\p{L}\p{N}]/u))return;if(!(s[1]||s[2]||"")||!n||this.rules.inline.punctuation.exec(n)){const n=[...s[0]].length-1;let r,i,l=n,o=0;const a="*"===s[0][0]?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(a.lastIndex=0,t=t.slice(-1*e.length+n);null!=(s=a.exec(t));){if(r=s[1]||s[2]||s[3]||s[4]||s[5]||s[6],!r)continue;if(i=[...r].length,s[3]||s[4]){l+=i;continue}if((s[5]||s[6])&&n%3&&!((n+i)%3)){o+=i;continue}if(l-=i,l>0)continue;i=Math.min(i,i+l+o);const t=[...s[0]][0].length,a=e.slice(0,n+s.index+t+i);if(Math.min(n,i)%2){const e=a.slice(1,-1);return{type:"em",raw:a,text:e,tokens:this.lexer.inlineTokens(e)}}const c=a.slice(2,-2);return{type:"strong",raw:a,text:c,tokens:this.lexer.inlineTokens(c)}}}}codespan(e){const t=this.rules.inline.code.exec(e);if(t){let e=t[2].replace(/\n/g," ");const n=/[^ ]/.test(e),s=/^ /.test(e)&&/ $/.test(e);return n&&s&&(e=e.substring(1,e.length-1)),e=c(e,!0),{type:"codespan",raw:t[0],text:e}}}br(e){const t=this.rules.inline.br.exec(e);if(t)return{type:"br",raw:t[0]}}del(e){const t=this.rules.inline.del.exec(e);if(t)return{type:"del",raw:t[0],text:t[2],tokens:this.lexer.inlineTokens(t[2])}}autolink(e){const t=this.rules.inline.autolink.exec(e);if(t){let e,n;return"@"===t[2]?(e=c(t[1]),n="mailto:"+e):(e=c(t[1]),n=e),{type:"link",raw:t[0],text:e,href:n,tokens:[{type:"text",raw:e,text:e}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let e,n;if("@"===t[2])e=c(t[0]),n="mailto:"+e;else{let s;do{s=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??""}while(s!==t[0]);e=c(t[0]),n="www."===t[1]?"http://"+t[0]:t[0]}return{type:"link",raw:t[0],text:e,href:n,tokens:[{type:"text",raw:e,text:e}]}}}inlineText(e){const t=this.rules.inline.text.exec(e);if(t){let e;return e=this.lexer.state.inRawBlock?t[0]:c(t[0]),{type:"text",raw:t[0],text:e}}}}const m=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,y=/(?:[*+-]|\d{1,9}[.)])/,$=k(/^(?!bull )((?:.|\n(?!\s*?\n|bull ))+?)\n {0,3}(=+|-+) *(?:\n+|$)/).replace(/bull/g,y).getRegex(),z=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/,T=/(?!\s*\])(?:\\.|[^\[\]\\])+/,R=k(/^ {0,3}\[(label)\]: *(?:\n *)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n *)?| *\n *)(title))? *(?:\n+|$)/).replace("label",T).replace("title",/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),_=k(/^( {0,3}bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g,y).getRegex(),A="address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul",S=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,I=k("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n *)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n *)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n *)+\\n|$))","i").replace("comment",S).replace("tag",A).replace("attribute",/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),E=k(z).replace("hr",m).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("|table","").replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",A).getRegex(),Z={blockquote:k(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph",E).getRegex(),code:/^( {4}[^\n]+(?:\n(?: *(?:\n|$))*)?)+/,def:R,fences:/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,heading:/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,hr:m,html:I,lheading:$,list:_,newline:/^(?: *(?:\n|$))+/,paragraph:E,table:f,text:/^[^\n]+/},q=k("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr",m).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("blockquote"," {0,3}>").replace("code"," {4}[^\\n]").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",A).getRegex(),L={...Z,table:q,paragraph:k(z).replace("hr",m).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("table",q).replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",A).getRegex()},P={...Z,html:k("^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:\"[^\"]*\"|'[^']*'|\\s[^'\"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))").replace("comment",S).replace(/tag/g,"(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:f,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:k(z).replace("hr",m).replace("heading"," *#{1,6} *[^\n]").replace("lheading",$).replace("|table","").replace("blockquote"," {0,3}>").replace("|fences","").replace("|list","").replace("|html","").replace("|tag","").getRegex()},Q=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,v=/^( {2,}|\\)\n(?!\s*$)/,B="\\p{P}\\p{S}",M=k(/^((?![*_])[\spunctuation])/,"u").replace(/punctuation/g,B).getRegex(),O=k(/^(?:\*+(?:((?!\*)[punct])|[^\s*]))|^_+(?:((?!_)[punct])|([^\s_]))/,"u").replace(/punct/g,B).getRegex(),C=k("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)[punct](\\*+)(?=[\\s]|$)|[^punct\\s](\\*+)(?!\\*)(?=[punct\\s]|$)|(?!\\*)[punct\\s](\\*+)(?=[^punct\\s])|[\\s](\\*+)(?!\\*)(?=[punct])|(?!\\*)[punct](\\*+)(?!\\*)(?=[punct])|[^punct\\s](\\*+)(?=[^punct\\s])","gu").replace(/punct/g,B).getRegex(),D=k("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[punct](_+)(?=[\\s]|$)|[^punct\\s](_+)(?!_)(?=[punct\\s]|$)|(?!_)[punct\\s](_+)(?=[^punct\\s])|[\\s](_+)(?!_)(?=[punct])|(?!_)[punct](_+)(?!_)(?=[punct])","gu").replace(/punct/g,B).getRegex(),j=k(/\\([punct])/,"gu").replace(/punct/g,B).getRegex(),H=k(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme",/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email",/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),U=k(S).replace("(?:--\x3e|$)","--\x3e").getRegex(),X=k("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment",U).replace("attribute",/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),F=/(?:\[(?:\\.|[^\[\]\\])*\]|\\.|`[^`]*`|[^\[\]\\`])*?/,N=k(/^!?\[(label)\]\(\s*(href)(?:\s+(title))?\s*\)/).replace("label",F).replace("href",/<(?:\\.|[^\n<>\\])+>|[^\s\x00-\x1f]*/).replace("title",/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),G=k(/^!?\[(label)\]\[(ref)\]/).replace("label",F).replace("ref",T).getRegex(),J=k(/^!?\[(ref)\](?:\[\])?/).replace("ref",T).getRegex(),K={_backpedal:f,anyPunctuation:j,autolink:H,blockSkip:/\[[^[\]]*?\]\([^\(\)]*?\)|`[^`]*?`|<[^<>]*?>/g,br:v,code:/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,del:f,emStrongLDelim:O,emStrongRDelimAst:C,emStrongRDelimUnd:D,escape:Q,link:N,nolink:J,punctuation:M,reflink:G,reflinkSearch:k("reflink|nolink(?!\\()","g").replace("reflink",G).replace("nolink",J).getRegex(),tag:X,text:/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,url:f},V={...K,link:k(/^!?\[(label)\]\((.*?)\)/).replace("label",F).getRegex(),reflink:k(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label",F).getRegex()},W={...K,escape:k(Q).replace("])","~|])").getRegex(),url:k(/^((?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,"i").replace("email",/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/,text:/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|https?:\/\/|ftp:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/},Y={...W,br:k(v).replace("{2,}","*").getRegex(),text:k(W.text).replace("\\b_","\\b_| {2,}\\n").replace(/\{2,\}/g,"*").getRegex()},ee={normal:Z,gfm:L,pedantic:P},te={normal:K,gfm:W,breaks:Y,pedantic:V};class ne{tokens;options;state;tokenizer;inlineQueue;constructor(t){this.tokens=[],this.tokens.links=Object.create(null),this.options=t||e.defaults,this.options.tokenizer=this.options.tokenizer||new w,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,top:!0};const n={block:ee.normal,inline:te.normal};this.options.pedantic?(n.block=ee.pedantic,n.inline=te.pedantic):this.options.gfm&&(n.block=ee.gfm,this.options.breaks?n.inline=te.breaks:n.inline=te.gfm),this.tokenizer.rules=n}static get rules(){return{block:ee,inline:te}}static lex(e,t){return new ne(t).lex(e)}static lexInline(e,t){return new ne(t).inlineTokens(e)}lex(e){e=e.replace(/\r\n|\r/g,"\n"),this.blockTokens(e,this.tokens);for(let e=0;e<this.inlineQueue.length;e++){const t=this.inlineQueue[e];this.inlineTokens(t.src,t.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(e,t=[]){let n,s,r,i;for(e=this.options.pedantic?e.replace(/\t/g,"    ").replace(/^ +$/gm,""):e.replace(/^( *)(\t+)/gm,((e,t,n)=>t+"    ".repeat(n.length)));e;)if(!(this.options.extensions&&this.options.extensions.block&&this.options.extensions.block.some((s=>!!(n=s.call({lexer:this},e,t))&&(e=e.substring(n.raw.length),t.push(n),!0)))))if(n=this.tokenizer.space(e))e=e.substring(n.raw.length),1===n.raw.length&&t.length>0?t[t.length-1].raw+="\n":t.push(n);else if(n=this.tokenizer.code(e))e=e.substring(n.raw.length),s=t[t.length-1],!s||"paragraph"!==s.type&&"text"!==s.type?t.push(n):(s.raw+="\n"+n.raw,s.text+="\n"+n.text,this.inlineQueue[this.inlineQueue.length-1].src=s.text);else if(n=this.tokenizer.fences(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.heading(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.hr(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.blockquote(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.list(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.html(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.def(e))e=e.substring(n.raw.length),s=t[t.length-1],!s||"paragraph"!==s.type&&"text"!==s.type?this.tokens.links[n.tag]||(this.tokens.links[n.tag]={href:n.href,title:n.title}):(s.raw+="\n"+n.raw,s.text+="\n"+n.raw,this.inlineQueue[this.inlineQueue.length-1].src=s.text);else if(n=this.tokenizer.table(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.lheading(e))e=e.substring(n.raw.length),t.push(n);else{if(r=e,this.options.extensions&&this.options.extensions.startBlock){let t=1/0;const n=e.slice(1);let s;this.options.extensions.startBlock.forEach((e=>{s=e.call({lexer:this},n),"number"==typeof s&&s>=0&&(t=Math.min(t,s))})),t<1/0&&t>=0&&(r=e.substring(0,t+1))}if(this.state.top&&(n=this.tokenizer.paragraph(r)))s=t[t.length-1],i&&"paragraph"===s.type?(s.raw+="\n"+n.raw,s.text+="\n"+n.text,this.inlineQueue.pop(),this.inlineQueue[this.inlineQueue.length-1].src=s.text):t.push(n),i=r.length!==e.length,e=e.substring(n.raw.length);else if(n=this.tokenizer.text(e))e=e.substring(n.raw.length),s=t[t.length-1],s&&"text"===s.type?(s.raw+="\n"+n.raw,s.text+="\n"+n.text,this.inlineQueue.pop(),this.inlineQueue[this.inlineQueue.length-1].src=s.text):t.push(n);else if(e){const t="Infinite loop on byte: "+e.charCodeAt(0);if(this.options.silent){console.error(t);break}throw new Error(t)}}return this.state.top=!0,t}inline(e,t=[]){return this.inlineQueue.push({src:e,tokens:t}),t}inlineTokens(e,t=[]){let n,s,r,i,l,o,a=e;if(this.tokens.links){const e=Object.keys(this.tokens.links);if(e.length>0)for(;null!=(i=this.tokenizer.rules.inline.reflinkSearch.exec(a));)e.includes(i[0].slice(i[0].lastIndexOf("[")+1,-1))&&(a=a.slice(0,i.index)+"["+"a".repeat(i[0].length-2)+"]"+a.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex))}for(;null!=(i=this.tokenizer.rules.inline.blockSkip.exec(a));)a=a.slice(0,i.index)+"["+"a".repeat(i[0].length-2)+"]"+a.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);for(;null!=(i=this.tokenizer.rules.inline.anyPunctuation.exec(a));)a=a.slice(0,i.index)+"++"+a.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);for(;e;)if(l||(o=""),l=!1,!(this.options.extensions&&this.options.extensions.inline&&this.options.extensions.inline.some((s=>!!(n=s.call({lexer:this},e,t))&&(e=e.substring(n.raw.length),t.push(n),!0)))))if(n=this.tokenizer.escape(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.tag(e))e=e.substring(n.raw.length),s=t[t.length-1],s&&"text"===n.type&&"text"===s.type?(s.raw+=n.raw,s.text+=n.text):t.push(n);else if(n=this.tokenizer.link(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.reflink(e,this.tokens.links))e=e.substring(n.raw.length),s=t[t.length-1],s&&"text"===n.type&&"text"===s.type?(s.raw+=n.raw,s.text+=n.text):t.push(n);else if(n=this.tokenizer.emStrong(e,a,o))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.codespan(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.br(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.del(e))e=e.substring(n.raw.length),t.push(n);else if(n=this.tokenizer.autolink(e))e=e.substring(n.raw.length),t.push(n);else if(this.state.inLink||!(n=this.tokenizer.url(e))){if(r=e,this.options.extensions&&this.options.extensions.startInline){let t=1/0;const n=e.slice(1);let s;this.options.extensions.startInline.forEach((e=>{s=e.call({lexer:this},n),"number"==typeof s&&s>=0&&(t=Math.min(t,s))})),t<1/0&&t>=0&&(r=e.substring(0,t+1))}if(n=this.tokenizer.inlineText(r))e=e.substring(n.raw.length),"_"!==n.raw.slice(-1)&&(o=n.raw.slice(-1)),l=!0,s=t[t.length-1],s&&"text"===s.type?(s.raw+=n.raw,s.text+=n.text):t.push(n);else if(e){const t="Infinite loop on byte: "+e.charCodeAt(0);if(this.options.silent){console.error(t);break}throw new Error(t)}}else e=e.substring(n.raw.length),t.push(n);return t}}class se{options;constructor(t){this.options=t||e.defaults}code(e,t,n){const s=(t||"").match(/^\S*/)?.[0];return e=e.replace(/\n$/,"")+"\n",s?'<pre><code class="language-'+c(s)+'">'+(n?e:c(e,!0))+"</code></pre>\n":"<pre><code>"+(n?e:c(e,!0))+"</code></pre>\n"}blockquote(e){return`<blockquote>\n${e}</blockquote>\n`}html(e,t){return e}heading(e,t,n){return`<h${t}>${e}</h${t}>\n`}hr(){return"<hr>\n"}list(e,t,n){const s=t?"ol":"ul";return"<"+s+(t&&1!==n?' start="'+n+'"':"")+">\n"+e+"</"+s+">\n"}listitem(e,t,n){return`<li>${e}</li>\n`}checkbox(e){return"<input "+(e?'checked="" ':"")+'disabled="" type="checkbox">'}paragraph(e){return`<p>${e}</p>\n`}table(e,t){return t&&(t=`<tbody>${t}</tbody>`),"<table>\n<thead>\n"+e+"</thead>\n"+t+"</table>\n"}tablerow(e){return`<tr>\n${e}</tr>\n`}tablecell(e,t){const n=t.header?"th":"td";return(t.align?`<${n} align="${t.align}">`:`<${n}>`)+e+`</${n}>\n`}strong(e){return`<strong>${e}</strong>`}em(e){return`<em>${e}</em>`}codespan(e){return`<code>${e}</code>`}br(){return"<br>"}del(e){return`<del>${e}</del>`}link(e,t,n){const s=g(e);if(null===s)return n;let r='<a href="'+(e=s)+'"';return t&&(r+=' title="'+t+'"'),r+=">"+n+"</a>",r}image(e,t,n){const s=g(e);if(null===s)return n;let r=`<img src="${e=s}" alt="${n}"`;return t&&(r+=` title="${t}"`),r+=">",r}text(e){return e}}class re{strong(e){return e}em(e){return e}codespan(e){return e}del(e){return e}html(e){return e}text(e){return e}link(e,t,n){return""+n}image(e,t,n){return""+n}br(){return""}}class ie{options;renderer;textRenderer;constructor(t){this.options=t||e.defaults,this.options.renderer=this.options.renderer||new se,this.renderer=this.options.renderer,this.renderer.options=this.options,this.textRenderer=new re}static parse(e,t){return new ie(t).parse(e)}static parseInline(e,t){return new ie(t).parseInline(e)}parse(e,t=!0){let n="";for(let s=0;s<e.length;s++){const r=e[s];if(this.options.extensions&&this.options.extensions.renderers&&this.options.extensions.renderers[r.type]){const e=r,t=this.options.extensions.renderers[e.type].call({parser:this},e);if(!1!==t||!["space","hr","heading","code","table","blockquote","list","html","paragraph","text"].includes(e.type)){n+=t||"";continue}}switch(r.type){case"space":continue;case"hr":n+=this.renderer.hr();continue;case"heading":{const e=r;n+=this.renderer.heading(this.parseInline(e.tokens),e.depth,p(this.parseInline(e.tokens,this.textRenderer)));continue}case"code":{const e=r;n+=this.renderer.code(e.text,e.lang,!!e.escaped);continue}case"table":{const e=r;let t="",s="";for(let t=0;t<e.header.length;t++)s+=this.renderer.tablecell(this.parseInline(e.header[t].tokens),{header:!0,align:e.align[t]});t+=this.renderer.tablerow(s);let i="";for(let t=0;t<e.rows.length;t++){const n=e.rows[t];s="";for(let t=0;t<n.length;t++)s+=this.renderer.tablecell(this.parseInline(n[t].tokens),{header:!1,align:e.align[t]});i+=this.renderer.tablerow(s)}n+=this.renderer.table(t,i);continue}case"blockquote":{const e=r,t=this.parse(e.tokens);n+=this.renderer.blockquote(t);continue}case"list":{const e=r,t=e.ordered,s=e.start,i=e.loose;let l="";for(let t=0;t<e.items.length;t++){const n=e.items[t],s=n.checked,r=n.task;let o="";if(n.task){const e=this.renderer.checkbox(!!s);i?n.tokens.length>0&&"paragraph"===n.tokens[0].type?(n.tokens[0].text=e+" "+n.tokens[0].text,n.tokens[0].tokens&&n.tokens[0].tokens.length>0&&"text"===n.tokens[0].tokens[0].type&&(n.tokens[0].tokens[0].text=e+" "+n.tokens[0].tokens[0].text)):n.tokens.unshift({type:"text",text:e+" "}):o+=e+" "}o+=this.parse(n.tokens,i),l+=this.renderer.listitem(o,r,!!s)}n+=this.renderer.list(l,t,s);continue}case"html":{const e=r;n+=this.renderer.html(e.text,e.block);continue}case"paragraph":{const e=r;n+=this.renderer.paragraph(this.parseInline(e.tokens));continue}case"text":{let i=r,l=i.tokens?this.parseInline(i.tokens):i.text;for(;s+1<e.length&&"text"===e[s+1].type;)i=e[++s],l+="\n"+(i.tokens?this.parseInline(i.tokens):i.text);n+=t?this.renderer.paragraph(l):l;continue}default:{const e='Token with "'+r.type+'" type was not found.';if(this.options.silent)return console.error(e),"";throw new Error(e)}}}return n}parseInline(e,t){t=t||this.renderer;let n="";for(let s=0;s<e.length;s++){const r=e[s];if(this.options.extensions&&this.options.extensions.renderers&&this.options.extensions.renderers[r.type]){const e=this.options.extensions.renderers[r.type].call({parser:this},r);if(!1!==e||!["escape","html","link","image","strong","em","codespan","br","del","text"].includes(r.type)){n+=e||"";continue}}switch(r.type){case"escape":{const e=r;n+=t.text(e.text);break}case"html":{const e=r;n+=t.html(e.text);break}case"link":{const e=r;n+=t.link(e.href,e.title,this.parseInline(e.tokens,t));break}case"image":{const e=r;n+=t.image(e.href,e.title,e.text);break}case"strong":{const e=r;n+=t.strong(this.parseInline(e.tokens,t));break}case"em":{const e=r;n+=t.em(this.parseInline(e.tokens,t));break}case"codespan":{const e=r;n+=t.codespan(e.text);break}case"br":n+=t.br();break;case"del":{const e=r;n+=t.del(this.parseInline(e.tokens,t));break}case"text":{const e=r;n+=t.text(e.text);break}default:{const e='Token with "'+r.type+'" type was not found.';if(this.options.silent)return console.error(e),"";throw new Error(e)}}}return n}}class le{options;constructor(t){this.options=t||e.defaults}static passThroughHooks=new Set(["preprocess","postprocess","processAllTokens"]);preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}}class oe{defaults={async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null};options=this.setOptions;parse=this.#e(ne.lex,ie.parse);parseInline=this.#e(ne.lexInline,ie.parseInline);Parser=ie;Renderer=se;TextRenderer=re;Lexer=ne;Tokenizer=w;Hooks=le;constructor(...e){this.use(...e)}walkTokens(e,t){let n=[];for(const s of e)switch(n=n.concat(t.call(this,s)),s.type){case"table":{const e=s;for(const s of e.header)n=n.concat(this.walkTokens(s.tokens,t));for(const s of e.rows)for(const e of s)n=n.concat(this.walkTokens(e.tokens,t));break}case"list":{const e=s;n=n.concat(this.walkTokens(e.items,t));break}default:{const e=s;this.defaults.extensions?.childTokens?.[e.type]?this.defaults.extensions.childTokens[e.type].forEach((s=>{const r=e[s].flat(1/0);n=n.concat(this.walkTokens(r,t))})):e.tokens&&(n=n.concat(this.walkTokens(e.tokens,t)))}}return n}use(...e){const t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach((e=>{const n={...e};if(n.async=this.defaults.async||n.async||!1,e.extensions&&(e.extensions.forEach((e=>{if(!e.name)throw new Error("extension name required");if("renderer"in e){const n=t.renderers[e.name];t.renderers[e.name]=n?function(...t){let s=e.renderer.apply(this,t);return!1===s&&(s=n.apply(this,t)),s}:e.renderer}if("tokenizer"in e){if(!e.level||"block"!==e.level&&"inline"!==e.level)throw new Error("extension level must be 'block' or 'inline'");const n=t[e.level];n?n.unshift(e.tokenizer):t[e.level]=[e.tokenizer],e.start&&("block"===e.level?t.startBlock?t.startBlock.push(e.start):t.startBlock=[e.start]:"inline"===e.level&&(t.startInline?t.startInline.push(e.start):t.startInline=[e.start]))}"childTokens"in e&&e.childTokens&&(t.childTokens[e.name]=e.childTokens)})),n.extensions=t),e.renderer){const t=this.defaults.renderer||new se(this.defaults);for(const n in e.renderer){if(!(n in t))throw new Error(`renderer '${n}' does not exist`);if("options"===n)continue;const s=n,r=e.renderer[s],i=t[s];t[s]=(...e)=>{let n=r.apply(t,e);return!1===n&&(n=i.apply(t,e)),n||""}}n.renderer=t}if(e.tokenizer){const t=this.defaults.tokenizer||new w(this.defaults);for(const n in e.tokenizer){if(!(n in t))throw new Error(`tokenizer '${n}' does not exist`);if(["options","rules","lexer"].includes(n))continue;const s=n,r=e.tokenizer[s],i=t[s];t[s]=(...e)=>{let n=r.apply(t,e);return!1===n&&(n=i.apply(t,e)),n}}n.tokenizer=t}if(e.hooks){const t=this.defaults.hooks||new le;for(const n in e.hooks){if(!(n in t))throw new Error(`hook '${n}' does not exist`);if("options"===n)continue;const s=n,r=e.hooks[s],i=t[s];le.passThroughHooks.has(n)?t[s]=e=>{if(this.defaults.async)return Promise.resolve(r.call(t,e)).then((e=>i.call(t,e)));const n=r.call(t,e);return i.call(t,n)}:t[s]=(...e)=>{let n=r.apply(t,e);return!1===n&&(n=i.apply(t,e)),n}}n.hooks=t}if(e.walkTokens){const t=this.defaults.walkTokens,s=e.walkTokens;n.walkTokens=function(e){let n=[];return n.push(s.call(this,e)),t&&(n=n.concat(t.call(this,e))),n}}this.defaults={...this.defaults,...n}})),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return ne.lex(e,t??this.defaults)}parser(e,t){return ie.parse(e,t??this.defaults)}#e(e,t){return(n,s)=>{const r={...s},i={...this.defaults,...r};!0===this.defaults.async&&!1===r.async&&(i.silent||console.warn("marked(): The async option was set to true by an extension. The async: false option sent to parse will be ignored."),i.async=!0);const l=this.#t(!!i.silent,!!i.async);if(null==n)return l(new Error("marked(): input parameter is undefined or null"));if("string"!=typeof n)return l(new Error("marked(): input parameter is of type "+Object.prototype.toString.call(n)+", string expected"));if(i.hooks&&(i.hooks.options=i),i.async)return Promise.resolve(i.hooks?i.hooks.preprocess(n):n).then((t=>e(t,i))).then((e=>i.hooks?i.hooks.processAllTokens(e):e)).then((e=>i.walkTokens?Promise.all(this.walkTokens(e,i.walkTokens)).then((()=>e)):e)).then((e=>t(e,i))).then((e=>i.hooks?i.hooks.postprocess(e):e)).catch(l);try{i.hooks&&(n=i.hooks.preprocess(n));let s=e(n,i);i.hooks&&(s=i.hooks.processAllTokens(s)),i.walkTokens&&this.walkTokens(s,i.walkTokens);let r=t(s,i);return i.hooks&&(r=i.hooks.postprocess(r)),r}catch(e){return l(e)}}}#t(e,t){return n=>{if(n.message+="\nPlease report this to https://github.com/markedjs/marked.",e){const e="<p>An error occurred:</p><pre>"+c(n.message+"",!0)+"</pre>";return t?Promise.resolve(e):e}if(t)return Promise.reject(n);throw n}}}const ae=new oe;function ce(e,t){return ae.parse(e,t)}ce.options=ce.setOptions=function(e){return ae.setOptions(e),ce.defaults=ae.defaults,n(ce.defaults),ce},ce.getDefaults=t,ce.defaults=e.defaults,ce.use=function(...e){return ae.use(...e),ce.defaults=ae.defaults,n(ce.defaults),ce},ce.walkTokens=function(e,t){return ae.walkTokens(e,t)},ce.parseInline=ae.parseInline,ce.Parser=ie,ce.parser=ie.parse,ce.Renderer=se,ce.TextRenderer=re,ce.Lexer=ne,ce.lexer=ne.lex,ce.Tokenizer=w,ce.Hooks=le,ce.parse=ce;const he=ce.options,pe=ce.setOptions,ue=ce.use,ke=ce.walkTokens,ge=ce.parseInline,fe=ce,de=ie.parse,xe=ne.lex;e.Hooks=le,e.Lexer=ne,e.Marked=oe,e.Parser=ie,e.Renderer=se,e.TextRenderer=re,e.Tokenizer=w,e.getDefaults=t,e.lexer=xe,e.marked=ce,e.options=he,e.parse=fe,e.parseInline=ge,e.parser=de,e.setOptions=pe,e.use=ue,e.walkTokens=ke}));
// --- END VENDORED marked@12.0.0 ---
        return globalThis.marked;
    }

})();
