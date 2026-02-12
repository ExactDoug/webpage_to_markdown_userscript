// ==UserScript==
// @name         Easy Web Page to Markdown
// @namespace    http://tampermonkey.net/
// @version      0.3.17
// @description  Convert selected HTML to Markdown
// @author       ExactDoug (forked from shiquda)
// @match        *://*/*
// @namespace    https://github.com/ExactDoug/webpage_to_markdown_userscript
// @supportURL   https://github.com/ExactDoug/webpage_to_markdown_userscript/issues
// @updateURL   https://raw.githubusercontent.com/ExactDoug/webpage_to_markdown_userscript/main/General/html2md.user.js
// @downloadURL https://raw.githubusercontent.com/ExactDoug/webpage_to_markdown_userscript/main/General/html2md.user.js
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.12.1/jquery-ui.min.js
// @require      https://unpkg.com/turndown/dist/turndown.js
// @require      https://unpkg.com/@guyplusplus/turndown-plugin-gfm/dist/turndown-plugin-gfm.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js
// @license      AGPL-3.0
// ==/UserScript==


(function () {
    'use strict';

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
- Use **Arrow Keys** to select elements
    - Up: Select parent element
    - Down: Select first child element
    - Left: Select previous sibling element
    - Right: Select next sibling element
- Use **Mouse Wheel** to zoom in/out
    - Up: Select parent element
    - Down: Select first child element
- Click to select element
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



    // HTML2Markdown
    // v0.3.17 FIX: Clone element and inject live form values into the clone
    // before Turndown processes it. DOM .value properties don't appear in
    // outerHTML, so without this Turndown sees empty form fields.
    function convertToMarkdown(element) {
        var clone = element.cloneNode(true);

        // Copy textarea values (.value doesn't appear between tags in outerHTML)
        var origTextareas = element.querySelectorAll('textarea');
        var cloneTextareas = clone.querySelectorAll('textarea');
        for (var i = 0; i < origTextareas.length; i++) {
            if (origTextareas[i].value) {
                cloneTextareas[i].textContent = origTextareas[i].value;
            }
        }

        // Copy input values into the value attribute so outerHTML includes them
        var origInputs = element.querySelectorAll('input');
        var cloneInputs = clone.querySelectorAll('input');
        for (var i = 0; i < origInputs.length; i++) {
            var inp = origInputs[i];
            var type = (inp.getAttribute('type') || 'text').toLowerCase();
            if (type === 'checkbox' || type === 'radio') {
                // Sync checked state into the attribute
                if (inp.checked) {
                    cloneInputs[i].setAttribute('checked', 'checked');
                } else {
                    cloneInputs[i].removeAttribute('checked');
                }
            } else if (inp.value) {
                cloneInputs[i].setAttribute('value', inp.value);
            }
        }

        // Copy selected option from <select> elements
        var origSelects = element.querySelectorAll('select');
        var cloneSelects = clone.querySelectorAll('select');
        for (var i = 0; i < origSelects.length; i++) {
            if (origSelects[i].selectedIndex >= 0) {
                var opts = cloneSelects[i].querySelectorAll('option');
                for (var j = 0; j < opts.length; j++) {
                    opts[j].removeAttribute('selected');
                }
                if (opts[origSelects[i].selectedIndex]) {
                    opts[origSelects[i].selectedIndex].setAttribute('selected', 'selected');
                }
            }
        }

        var html = clone.outerHTML;
        return turndownService.turndown(html);
    }


    // Preview
    function showMarkdownModal(markdown) {
        const obsidianButtonHtml = obsidianEnabled
            ? '<select class="h2m-obsidian-select">Send to Obsidian</select>'
            : '';

        var $modal = $(`
                    <div class="h2m-modal-overlay">
                        <div class="h2m-modal">
                            <textarea></textarea>
                            <div class="h2m-preview"></div>
                            <div class="h2m-buttons">
                                <button class="h2m-copy">Copy to clipboard</button>
                                <button class="h2m-download">Download as MD</button>
                                ${obsidianButtonHtml}
                            </div>
                            <button class="h2m-close">X</button>
                        </div>
                    </div>
                `);

        $modal.find('textarea').val(markdown);
        $modal.find('.h2m-preview').html(marked.parse(markdown));

        if (obsidianEnabled) {
            $modal.find('.h2m-obsidian-select').append($('<option>').val('').text('Send to Obsidian'));
            for (const vault in obsidianConfig) {
                for (const path of obsidianConfig[vault]) {
                    const $option = $('<option>')
                        .val(`obsidian://advanced-uri?vault=${vault}&filepath=${path}`)
                        .text(`${vault}: ${path}`);
                    $modal.find('.h2m-obsidian-select').append($option);
                }
            }
        }

        $modal.find('textarea').on('input', function () {
            var markdown = $(this).val();
            var html = marked.parse(markdown);
            $modal.find('.h2m-preview').html(html);
        });

        $modal.on('keydown', function (e) {
            if (e.key === 'Escape') {
                $modal.remove();
            }
        });


        $modal.find('.h2m-copy').on('click', function () { // Copy to clipboard
            GM_setClipboard($modal.find('textarea').val());
            $modal.find('.h2m-copy').text('Copied!');
            setTimeout(() => {
                $modal.find('.h2m-copy').text('Copy to clipboard');
            }, 1000);
        });

        $modal.find('.h2m-download').on('click', function () { // Download
            var markdown = $modal.find('textarea').val();
            var blob = new Blob([markdown], { type: 'text/markdown' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = `${document.title.replace(/ /g, '_')}-${new Date().toISOString().replace(/:/g, '-')}.md`;
            a.click();
        });

        if (obsidianEnabled) {
            $modal.find('.h2m-obsidian-select').on('change', function () { // Send to Obsidian
                const val = $(this).val();
                if (!val) return;
                const markdown = $modal.find('textarea').val();
                GM_setClipboard(markdown);
                const title = document.title.replaceAll(/[\\/:*?"<>|]/g, '_');
                const url = `${val}${title}.md&clipboard=true`;
                window.open(url);
            });
        }

        $modal.find('.h2m-close').on('click', function () { // Close button X
            $modal.remove();
        });

        // Sync scrolling
        var $textarea = $modal.find('textarea');
        var $preview = $modal.find('.h2m-preview');
        var isScrolling = false;

        $textarea.on('scroll', function () {
            if (isScrolling) { isScrolling = false; return; }
            var scrollPercentage = this.scrollTop / (this.scrollHeight - this.offsetHeight);
            $preview[0].scrollTop = scrollPercentage * ($preview[0].scrollHeight - $preview[0].offsetHeight);
            isScrolling = true;
        });

        $preview.on('scroll', function () {
            if (isScrolling) { isScrolling = false; return; }
            var scrollPercentage = this.scrollTop / (this.scrollHeight - this.offsetHeight);
            $textarea[0].scrollTop = scrollPercentage * ($textarea[0].scrollHeight - $textarea[0].offsetHeight);
            isScrolling = true;
        });

        $(document).on('keydown', function (e) {
            if (e.key === 'Escape' && $('.h2m-modal-overlay').length > 0) {
                $('.h2m-modal-overlay').remove();
            }
        });

        $('body').append($modal);
    }

    // Start selecting
    function startSelecting() {
        $('body').addClass('h2m-no-scroll');
        isSelecting = true;
        tip(marked.parse(guide));
    }

    // End selecting
    function endSelecting() {
        isSelecting = false;
        $('.h2m-selection-box').removeClass('h2m-selection-box');
        $('body').removeClass('h2m-no-scroll');
        $('.h2m-tip').remove();
    }

    function tip(message, timeout = null) {
        var $tipElement = $('<div>')
            .addClass('h2m-tip')
            .html(message)
            .appendTo('body')
            .hide()
            .fadeIn(200);
        if (timeout === null) { return; }
        setTimeout(function () {
            $tipElement.fadeOut(200, function () { $tipElement.remove(); });
        }, timeout);
    }

    // Turndown configuration
    var turndownPluginGfm = TurndownPluginGfmService;
    var turndownService = new TurndownService({ codeBlockStyle: 'fenced' });

    turndownPluginGfm.gfm(turndownService); // Import all plugins

    // Remove metadata/non-content elements that should not appear in markdown output
    turndownService.remove(['script', 'style', 'noscript']);

    // ========================================================================
    // FORM FIELD RULES - Capture input values, checkboxes, selects, textareas
    // ========================================================================

    // Helper: get field name/id for labeling
    function getFieldKey(node) {
        return node.getAttribute('name') || node.getAttribute('id') || '';
    }

    // Helper: get input value (property first for live DOM, then attribute)
    function getFieldValue(node) {
        const prop = typeof node.value === 'string' ? node.value : null;
        const attr = node.getAttribute('value');
        return (prop ?? attr ?? '').trim();
    }

    // Rule: Checkbox and radio inputs - show checked state
    turndownService.addRule('formCheckboxRadio', {
        filter: function (node) {
            if (node.nodeName !== 'INPUT') return false;
            const type = (node.getAttribute('type') || '').toLowerCase();
            return type === 'checkbox' || type === 'radio';
        },
        replacement: function (content, node) {
            const checked = node.checked || node.hasAttribute('checked');
            const mark = checked ? 'x' : ' ';
            return `[${mark}]`;
        }
    });

    // Rule: Text-like inputs - output value inline
    turndownService.addRule('formTextInputs', {
        filter: function (node) {
            if (node.nodeName !== 'INPUT') return false;
            const type = (node.getAttribute('type') || 'text').toLowerCase();
            const excludeTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'hidden', 'image'];
            return !excludeTypes.includes(type);
        },
        replacement: function (content, node) {
            const val = getFieldValue(node);
            return val ? val : '';
        }
    });

    // Rule: Select elements - show selected option text
    turndownService.addRule('formSelect', {
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
    turndownService.addRule('formTextarea', {
        filter: 'textarea',
        replacement: function (content, node) {
            const val = (node.value ?? node.textContent ?? '').trim();
            if (!val) return '';
            if (val.includes('\n')) {
                return '\n```\n' + val + '\n```\n';
            }
            return val;
        }
    });

    // Rule: Remove submit/reset/button inputs from output
    turndownService.addRule('formButtonsRemove', {
        filter: function (node) {
            if (node.nodeName === 'BUTTON') return true;
            if (node.nodeName !== 'INPUT') return false;
            const type = (node.getAttribute('type') || '').toLowerCase();
            return type === 'button' || type === 'submit' || type === 'reset' || type === 'image';
        },
        replacement: function () { return ''; }
    });

    // ========================================================================
    // END FORM FIELD RULES
    // ========================================================================

    // Custom rule to normalize whitespace in link text
    turndownService.addRule('normalizeLinkText', {
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

    // turndownService.addRule('strikethrough', {
    //     filter: ['del', 's', 'strike'],
    //     replacement: function (content) {
    //         return '~' + content + '~'
    //     }
    // });

    // turndownService.addRule('latex', {
    //     filter: ['mjx-container'],
    //     replacement: function (content, node) {
    //         const text = node.querySelector('img')?.title;
    //         const isInline = !node.getAttribute('display');
    //         if (text) {
    //             if (isInline) {
    //                 return '$' + text + '$'
    //             }
    //             else {
    //                 return '$$' + text + '$$'
    //             }
    //         }
    //         return '';
    //     }
    // });




    // Add CSS styles
    GM_addStyle(`
        .h2m-selection-box {
            border: 2px dashed #f00;
            background-color: rgba(255, 0, 0, 0.2);
        }
        .h2m-no-scroll {
            overflow: hidden;
            z-index: 9997;
        }
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
            z-index: 9998;
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
            background-color: white;
            border: 1px solid black;
            padding: 8px;
            z-index: 9999;
            border-radius: 10px;
            box-shadow: 5px 5px 10px rgba(0, 0, 0, 0.5);
            background-color: rgba(255, 255, 255, 0.7);
        }
    `);

    // Register trigger
    shortCutConfig = shortCutConfig ? shortCutConfig : {
        "Shift": false,
        "Ctrl": true,
        "Alt": false,
        "Key": "m"
    };
    $(document).on('keydown', function (e) {
        if (e.ctrlKey === shortCutConfig['Ctrl'] &&
            e.altKey === shortCutConfig['Alt'] &&
            e.shiftKey === shortCutConfig['Shift'] &&
            e.key.toUpperCase() === shortCutConfig['Key'].toUpperCase()) {
            e.preventDefault();
            startSelecting();
        }
    });

    GM_registerMenuCommand('Convert to Markdown', function () {
        startSelecting()
    });



    $(document).on('mouseover', function (e) {
        if (isSelecting) {
            $(selectedElement).removeClass('h2m-selection-box');
            selectedElement = e.target;
            $(selectedElement).addClass('h2m-selection-box');
        }
    }).on('wheel', function (e) {
        if (isSelecting) {
            e.preventDefault();
            if (e.originalEvent.deltaY < 0) {
                selectedElement = selectedElement.parentElement ? selectedElement.parentElement : selectedElement;
                if (selectedElement.tagName === 'HTML' || selectedElement.tagName === 'BODY') {
                    selectedElement = selectedElement.firstElementChild;
                }
            } else {
                selectedElement = selectedElement.firstElementChild ? selectedElement.firstElementChild : selectedElement;
            }
            $('.h2m-selection-box').removeClass('h2m-selection-box');
            $(selectedElement).addClass('h2m-selection-box');
        }
    }).on('keydown', function (e) {
        if (isSelecting) {
            e.preventDefault();
            if (e.key === 'Escape') { endSelecting(); return; }
            switch (e.key) {
                case 'ArrowUp':
                    selectedElement = selectedElement.parentElement ? selectedElement.parentElement : selectedElement;
                    if (selectedElement.tagName === 'HTML' || selectedElement.tagName === 'BODY') {
                        selectedElement = selectedElement.firstElementChild;
                    }
                    break;
                case 'ArrowDown':
                    selectedElement = selectedElement.firstElementChild ? selectedElement.firstElementChild : selectedElement;
                    break;
                case 'ArrowLeft':
                    var prev = selectedElement.previousElementSibling;
                    while (prev === null && selectedElement.parentElement !== null) {
                        selectedElement = selectedElement.parentElement;
                        prev = selectedElement.previousElementSibling ? selectedElement.previousElementSibling.lastChild : null;
                    }
                    if (prev !== null) {
                        if (selectedElement.tagName === 'HTML' || selectedElement.tagName === 'BODY') {
                            selectedElement = selectedElement.firstElementChild;
                        }
                        selectedElement = prev;
                    }
                    break;
                case 'ArrowRight':
                    var next = selectedElement.nextElementSibling;
                    while (next === null && selectedElement.parentElement !== null) {
                        selectedElement = selectedElement.parentElement;
                        next = selectedElement.nextElementSibling ? selectedElement.nextElementSibling.firstElementChild : null;
                    }
                    if (next !== null) {
                        if (selectedElement.tagName === 'HTML' || selectedElement.tagName === 'BODY') {
                            selectedElement = selectedElement.firstElementChild;
                        }
                        selectedElement = next;
                    }
                    break;
            }
            $('.h2m-selection-box').removeClass('h2m-selection-box');
            $(selectedElement).addClass('h2m-selection-box');
        }
    }).on('mousedown', function (e) {
        if (isSelecting) {
            e.preventDefault();
            var markdown = convertToMarkdown(selectedElement);
            showMarkdownModal(markdown);
            endSelecting();
        }
    });

})();
