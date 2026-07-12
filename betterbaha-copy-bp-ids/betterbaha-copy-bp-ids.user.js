// ==UserScript==
// @name         BetterBaha 一鍵複製 BP ID
// @namespace    https://forum.gamer.com.tw/
// @version      1.1.0
// @description  在巴哈文章的 BP 數字旁加入按鈕，一鍵把 BP 勇者 ID 與板號組成查詢句。
// @match        https://forum.gamer.com.tw/C.php*
// @match        https://forum.gamer.com.tw/Co.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_CLASS = 'betterbaha-copy-bp-ids';
  const MAX_PAGES = 100;

  injectStyle();
  installButtons();

  const observer = new MutationObserver(installButtons);
  observer.observe(document.body, { childList: true, subtree: true });

  function installButtons() {
    const bpCounts = document.querySelectorAll(
      '.c-post .bp > .count.tippy-gpbp-list[data-tippy]'
    );

    for (const count of bpCounts) {
      if (count.parentElement?.querySelector(`:scope > .${BUTTON_CLASS}`)) {
        continue;
      }

      const info = readBpInfo(count);
      if (!info) {
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = BUTTON_CLASS;
      button.innerHTML = '<span aria-hidden="true">⧉</span><span>複製 ID</span>';
      button.title = '複製所有給這篇文章 BP 的勇者 ID';
      button.setAttribute('aria-label', '複製所有 BP ID');
      button.addEventListener('click', (event) => copyBpIds(event, button, info));
      count.insertAdjacentElement('afterend', button);
    }
  }

  function readBpInfo(count) {
    try {
      const raw = count.getAttribute('data-tippy');
      const data = JSON.parse(raw || '{}');
      if (Number(data.type) !== 2 || !data.bsn || !data.sn) {
        return null;
      }

      return {
        bsn: String(data.bsn),
        sn: String(data.sn),
      };
    } catch {
      return null;
    }
  }

  async function copyBpIds(event, button, info) {
    event.preventDefault();
    event.stopPropagation();

    if (button.disabled) {
      return;
    }

    button.disabled = true;
    setButtonState(button, 'loading', '讀取中…');

    try {
      const ids = await fetchAllBpIds(info);
      if (ids.length === 0) {
        setButtonState(button, 'empty', '沒有 BP');
        resetButton(button);
        return;
      }

      const prompt = buildSearchPrompt(ids, info.bsn);
      await copyText(prompt);
      setButtonState(button, 'success', `已複製 ${ids.length} 個`);
      resetButton(button);
    } catch (error) {
      console.error('[BetterBaha Copy BP IDs]', error);
      setButtonState(button, 'error', '複製失敗');
      button.title = '讀取 BP 名單失敗，請稍後再試';
      resetButton(button);
    }
  }

  async function fetchAllBpIds(info) {
    const ids = new Set();
    const visitedPages = new Set();
    let page = 1;

    while (page && !visitedPages.has(page) && visitedPages.size < MAX_PAGES) {
      visitedPages.add(page);
      const url = new URL('/ajax/GPBPlist.php', location.origin);
      url.search = new URLSearchParams({
        t: '2',
        bsn: info.bsn,
        snB: info.sn,
        p: String(page),
      }).toString();

      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });

      if (!response.ok) {
        throw new Error(`BP list request failed: ${response.status}`);
      }

      const data = await response.json();
      if (data.status !== 'S') {
        throw new Error(data.msg || 'BP list unavailable');
      }

      const users = typeof data.u === 'string' ? JSON.parse(data.u) : (data.u || {});
      Object.keys(users).forEach((id) => ids.add(id));
      page = Number(data.page?.n) || 0;
    }

    return Array.from(ids);
  }

  function buildSearchPrompt(ids, bsn) {
    return `來幫我查查看巴哈id的 ${ids.join(' ')} 跟巴哈的 ${bsn} 討論區 有沒有什麼關係?`;
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();

    if (!copied) {
      throw new Error('Clipboard API unavailable');
    }
  }

  function setButtonState(button, state, label) {
    button.dataset.state = state;
    button.lastElementChild.textContent = label;
  }

  function resetButton(button) {
    window.setTimeout(() => {
      button.disabled = false;
      button.dataset.state = '';
      button.lastElementChild.textContent = '複製 ID';
      button.title = '複製所有給這篇文章 BP 的勇者 ID';
    }, 1800);
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = 'betterbaha-copy-bp-ids-style';
    style.textContent = `
      .c-post .bp > .${BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 26px;
        margin-left: 8px;
        padding: 3px 9px;
        border: 1px solid #b7bcc3;
        border-radius: 999px;
        background: #fff;
        color: #60656d;
        font: 600 12px/1.2 Arial, "Microsoft JhengHei", sans-serif;
        white-space: nowrap;
        vertical-align: middle;
        cursor: pointer;
        transition: border-color .15s ease, color .15s ease, background .15s ease,
          transform .15s ease;
      }

      .c-post .bp > .${BUTTON_CLASS}:hover:not(:disabled) {
        border-color: #8b929b;
        background: #f5f6f7;
        color: #34383d;
        transform: translateY(-1px);
      }

      .c-post .bp > .${BUTTON_CLASS}:focus-visible {
        outline: 2px solid #11aac1;
        outline-offset: 2px;
      }

      .c-post .bp > .${BUTTON_CLASS}:disabled {
        cursor: wait;
        opacity: .78;
      }

      .c-post .bp > .${BUTTON_CLASS}[data-state="success"] {
        border-color: #41a36f;
        background: #edf9f2;
        color: #26794e;
      }

      .c-post .bp > .${BUTTON_CLASS}[data-state="error"] {
        border-color: #d96c6c;
        background: #fff2f2;
        color: #ad3f3f;
      }

      html[data-theme="dark"] .c-post .bp > .${BUTTON_CLASS} {
        border-color: #555d66;
        background: #30343a;
        color: #d5d8dc;
      }

      @media (max-width: 640px) {
        .c-post .bp > .${BUTTON_CLASS} span:last-child {
          display: none;
        }

        .c-post .bp > .${BUTTON_CLASS} {
          min-width: 26px;
          margin-left: 5px;
          padding: 3px 7px;
        }
      }
    `;
    document.getElementById(style.id)?.remove();
    document.head.append(style);
  }
})();
