// ==UserScript==
// @name         Easy Web Page to Markdown
// @namespace    http://tampermonkey.net/
// @version      0.4.0
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
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      unpkg.com
// @connect      cdnjs.cloudflare.com
// @resource     turndown     https://unpkg.com/turndown/dist/turndown.js
// @resource     turndownGfm  https://unpkg.com/@guyplusplus/turndown-plugin-gfm/dist/turndown-plugin-gfm.js
// @resource     marked       https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js
// @license      AGPL-3.0
// ==/UserScript==

// NOTE ON LOADING (v0.4.0):
// The conversion libraries are NOT loaded with @require. @require executes on
// every page and every frame at document start, which is how v0.3.x broke
// Cloudflare Turnstile: jQuery's load-time feature detection assumes
// `innerHTML` parses normally, that assumption does not hold inside a hardened
// challenge frame, jQuery threw, and Turnstile treats any uncaught error in its
// frame as tampering (error 300010). Nothing here runs until you actually
// invoke the tool. jQuery and jQuery UI are gone entirely.

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
    // LAZY LIBRARY LOADING
    // ========================================================================

    const LIB_URLS = {
        turndown: 'https://unpkg.com/turndown/dist/turndown.js',
        turndownGfm: 'https://unpkg.com/@guyplusplus/turndown-plugin-gfm/dist/turndown-plugin-gfm.js',
        marked: 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js'
    };
    const LIB_ORDER = ['turndown', 'turndownGfm', 'marked'];

    let libs = null;
    let libsPromise = null;
    let turndownService = null;

    function readLib(name) {
        try {
            if (typeof GM_getResourceText === 'function') {
                const text = GM_getResourceText(name);
                if (text && text.length > 100) return Promise.resolve(text);
            }
        } catch (e) { /* resource missing or manager without sync support */ }
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('cannot load ' + name + ': no resource and no GM_xmlhttpRequest'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: LIB_URLS[name],
                onload: function (res) {
                    if (res.status >= 200 && res.status < 300 && res.responseText) resolve(res.responseText);
                    else reject(new Error(name + ': HTTP ' + res.status));
                },
                onerror: function () { reject(new Error(name + ': request failed')); }
            });
        });
    }

    // Evaluate the libraries in one private scope instead of on the page.
    // `module`/`exports`/`define` are shadowed to undefined so UMD bundles take
    // the browser branch even on RequireJS pages, and `globalThis`/`window`/
    // `self`/`this` all point at our own window so nothing leaks to the page.
    function evalLibs(sources) {
        const body = sources.join('\n;\n') + `
;return {
    TurndownService: typeof TurndownService !== 'undefined' ? TurndownService : (globalThis || {}).TurndownService,
    TurndownPluginGfmService: typeof TurndownPluginGfmService !== 'undefined' ? TurndownPluginGfmService : (globalThis || {}).TurndownPluginGfmService,
    marked: typeof marked !== 'undefined' ? marked : (globalThis || {}).marked
};`;
        const factory = new Function('window', 'document', 'globalThis', 'self', 'module', 'exports', 'define', body);
        const out = factory.call(window, window, document, window, window, undefined, undefined, undefined);
        if (!out || !out.TurndownService || !out.marked) throw new Error('libraries failed to initialize');
        return out;
    }

    function ensureLibs() {
        if (libs) return Promise.resolve(libs);
        if (!libsPromise) {
            libsPromise = Promise.all(LIB_ORDER.map(readLib))
                .then(function (sources) {
                    libs = evalLibs(sources);
                    turndownService = buildTurndownService(libs);
                    return libs;
                })
                .catch(function (err) {
                    libsPromise = null; // allow a retry on the next activation
                    throw err;
                });
        }
        return libsPromise;
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
            const a = h('a', {
                href: url,
                download: `${document.title.replace(/ /g, '_')}-${new Date().toISOString().replace(/:/g, '-')}.md`
            });
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
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
})();
