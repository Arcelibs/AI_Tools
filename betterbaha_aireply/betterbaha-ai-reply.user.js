// ==UserScript==
// @name         BetterBaha AI Reply Draft
// @namespace    https://forum.gamer.com.tw/
// @version      0.1.5
// @description  Add an AI reply draft button to Bahamut forum article pages.
// @match        https://forum.gamer.com.tw/C.php*
// @match        https://forum.gamer.com.tw/Co.php*
// @match        https://forum.gamer.com.tw/post1.php*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '0.1.5';
  const SETTINGS_KEY = 'betterbaha:ai-reply:settings:v1';
  const PENDING_DRAFT_KEY = 'betterbaha:ai-reply:pending-draft:v1';
  const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_ARTICLE_CHARS = 12000;
  const INSTALL_DELAY_MS = 120;

  const DEFAULT_SETTINGS = {
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
    model: 'deepseek-v4-flash-free',
    apiKey: '',
    temperature: 0.7,
    maxTokens: 900,
    systemPrompt: [
      '你是協助撰寫巴哈姆特討論區回覆草稿的助理。',
      '你的目標是協助使用者整理原本就想表達的重點，而不是替使用者硬生生找話講。',
      '請使用繁體中文，語氣自然、禮貌、像一般真人回覆。',
      '如果文章內容不足以形成有意義的回覆，或只能產生空泛附和，請直接建議先不要回覆，並簡短說明原因。',
      '不要假裝有未曾發生的親身經驗；不確定的地方要用「可能」、「建議」、「我會先確認」等保留語氣。',
      '不要人身攻擊、不要煽動爭吵，也不要編造來源。',
      '只輸出可直接貼到回覆框的內容，不要輸出分析標題或 Markdown 格式。'
    ].join('\n')
  };

  const state = {
    installTimer: 0,
    replyDraftChecked: false,
    generating: false,
  };

  document.documentElement.dataset.betterbahaAiReplyVersion = SCRIPT_VERSION;
  injectStyle();
  registerMenuCommand();
  scheduleInstall();
  observePageChanges();

  document.addEventListener('DOMContentLoaded', scheduleInstall, { once: true });
  window.addEventListener('load', scheduleInstall, { once: true });

  function scheduleInstall() {
    if (state.installTimer) {
      return;
    }

    state.installTimer = window.setTimeout(() => {
      state.installTimer = 0;
      installArticleButtons();
      installPendingDraftOnReplyPage();
    }, INSTALL_DELAY_MS);
  }

  function registerMenuCommand() {
    if (typeof GM_registerMenuCommand !== 'function') {
      return;
    }

    GM_registerMenuCommand('BetterBaha AI 回覆設定', () => {
      openSettingsModal();
    });
  }

  function installArticleButtons() {
    if (!isArticlePage()) {
      return;
    }

    for (const target of findToolbarTargets()) {
      if (!target.anchor || !target.container) {
        continue;
      }

      if (hasDirectAiButton(target.container)) {
        continue;
      }

      const button = createAiButton();
      target.anchor.insertAdjacentElement('beforebegin', button);
    }
  }

  function findToolbarTargets() {
    const targets = [];
    const seen = new Set();

    for (const anchor of Array.from(document.querySelectorAll('a'))) {
      if (!isToolbarFollowAnchor(anchor) || anchor.closest('dl')) {
        continue;
      }

      addToolbarTarget(anchor);
    }

    if (targets.length === 0) {
      for (const anchor of Array.from(document.querySelectorAll('a[href*="post1.php"]'))) {
        if (!isReplyAnchor(anchor) || anchor.closest('dl')) {
          continue;
        }

        addToolbarTarget(anchor);
      }
    }

    return targets;

    function addToolbarTarget(anchor) {
      const container = anchor.closest('.toolbar, .BH-menu-forumA-right, .BH-menu, .c-menu__scrolldown') || anchor.parentElement;
      if (!container || container.closest('.betterbaha-ai-modal')) {
        return;
      }

      const key = getElementKey(container);
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      targets.push({ anchor, container });
    }
  }

  function isToolbarFollowAnchor(anchor) {
    const text = normalizeInlineText(anchor.textContent);
    const dataGtm = anchor.getAttribute('data-gtm') || '';
    const href = anchor.getAttribute('href') || '';
    const onclick = anchor.getAttribute('onclick') || '';

    return (
      /已追蹤|追蹤|卡回文/.test(text) ||
      /追蹤/.test(dataGtm) ||
      /toggleThreadFollow/.test(href) ||
      /toggleThreadFollow/.test(onclick)
    );
  }

  function isReplyAnchor(anchor) {
    const text = normalizeInlineText(anchor.textContent);
    const href = anchor.getAttribute('href') || '';
    return /回覆文章/.test(text) || /post1\.php/.test(href);
  }

  function hasDirectAiButton(container) {
    return Array.from(container.children).some((child) => child.classList?.contains('betterbaha-ai-reply-button'));
  }

  function createAiButton() {
    const button = document.createElement('a');
    button.href = 'javascript:void(0)';
    button.className = 'betterbaha-ai-reply-button';
    button.setAttribute('role', 'button');
    button.setAttribute('data-gtm', 'BetterBaha-AI分析回覆');
    button.innerHTML = '<i class="fa fa-magic" aria-hidden="true"></i><span>AI分析回覆</span>';
    button.addEventListener('click', handleAiButtonClick);
    return button;
  }

  async function handleAiButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (state.generating) {
      showToast('AI 草稿正在產生中，請稍等一下。');
      return;
    }

    const article = collectArticle();
    if (!article.content) {
      showToast('找不到文章內文，可能是頁面尚未載入完成。');
      return;
    }

    const settings = loadSettings();
    if (!settings.apiKey || !settings.endpoint || !settings.model) {
      openSettingsModal({
        afterSave: () => runDraftGeneration(article),
        primaryText: '儲存並開始產生',
      });
      return;
    }

    await runDraftGeneration(article);
  }

  async function runDraftGeneration(article) {
    const modal = openDraftModal(article);
    state.generating = true;

    try {
      modal.setBusy(true);
      modal.setStatus('正在把文章交給你設定的 LLM 分析...');
      const draft = await generateDraft(article);
      writePendingDraft(article, draft);
      modal.setDraft(draft);
      modal.setStatus('草稿已完成。發文前請再檢查內容與板規。', 'ready');
      showToast('AI 回覆草稿已完成。');
    } catch (error) {
      modal.setStatus(`產生失敗：${error.message || error}`, 'error');
    } finally {
      modal.setBusy(false);
      state.generating = false;
    }
  }

  function collectArticle() {
    const title = getArticleTitle();
    const contentElement =
      document.querySelector('.c-section__main.c-post .c-article__content') ||
      document.querySelector('.c-article__content') ||
      document.querySelector('.reply-content__article');

    const content = contentElement ? normalizeArticleText(contentElement) : '';
    const params = new URLSearchParams(location.search);

    return {
      title,
      content: content.slice(0, MAX_ARTICLE_CHARS),
      url: location.href,
      bsn: params.get('bsn') || '',
      snA: params.get('snA') || '',
      subbsn: params.get('subbsn') || getThreadSubbsn(),
      key: getArticleKey(),
      replyUrl: getReplyUrl(),
    };
  }

  function getArticleTitle() {
    const candidates = [
      document.querySelector('.c-post__header__title')?.textContent,
      document.querySelector('.c-fixed--header .title')?.textContent,
      document.querySelector('meta[property="og:title"]')?.content,
      document.querySelector('script[type="application/ld+json"]')?.textContent,
    ];

    for (const candidate of candidates) {
      const title = readTitleCandidate(candidate);
      if (title) {
        return title;
      }
    }

    return normalizeInlineText(document.title.replace(/\s*@.+$/, ''));
  }

  function readTitleCandidate(candidate) {
    if (!candidate) {
      return '';
    }

    const text = String(candidate).trim();
    if (!text) {
      return '';
    }

    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const data = JSON.parse(text);
        const article = Array.isArray(data) ? data.find((item) => item && item['@type'] === 'Article') : data;
        return normalizeInlineText(article?.headline || '');
      } catch {
        return '';
      }
    }

    return normalizeInlineText(text.replace(/\s*@.+$/, ''));
  }

  function normalizeArticleText(element) {
    const clone = element.cloneNode(true);

    for (const hidden of clone.querySelectorAll('script, style, noscript, iframe, .betterbaha-ai-reply-button')) {
      hidden.remove();
    }

    for (const image of clone.querySelectorAll('img')) {
      const src = image.getAttribute('data-src') || image.getAttribute('src') || '';
      const alt = normalizeInlineText(image.getAttribute('alt') || '');
      image.replaceWith(document.createTextNode(alt ? `[圖片：${alt}]` : src ? `[圖片：${src}]` : '[圖片]'));
    }

    for (const anchor of clone.querySelectorAll('a[href]')) {
      const text = normalizeInlineText(anchor.textContent);
      const href = anchor.href || anchor.getAttribute('href') || '';
      if (href && !text.includes(href)) {
        anchor.append(document.createTextNode(` (${href})`));
      }
    }

    for (const br of clone.querySelectorAll('br')) {
      br.replaceWith(document.createTextNode('\n'));
    }

    for (const block of clone.querySelectorAll('div, p, li, blockquote, article')) {
      block.append(document.createTextNode('\n'));
    }

    return clone.textContent
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function generateDraft(article) {
    const settings = loadSettings();
    const messages = [
      {
        role: 'system',
        content: settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt,
      },
      {
        role: 'user',
        content: buildUserPrompt(article),
      },
    ];

    const response = await requestChatCompletion(settings, messages);
    const draft = extractAssistantText(response);
    if (!draft) {
      throw new Error('LLM 沒有回傳可用內容。');
    }

    return draft.trim();
  }

  function buildUserPrompt(article) {
    return [
      '請根據以下巴哈姆特討論區文章，判斷是否值得回覆，再協助整理一段可直接貼到回覆框的內容。',
      '需求：',
      '1. 先理解原文問題或分享重點，只在有具體資訊、建議、釐清問題或善意補充時才生成回覆。',
      '2. 如果只能空泛附和、硬湊話題、或沒有明確可補充內容，請輸出：「我覺得這篇先不要回覆比較好，因為目前沒有明確想補充的重點。」',
      '3. 如果是提問，請給出可行方向；資訊不足時，請提出真正有助釐清的問題。',
      '4. 回覆不要太長，約 100 到 300 字，除非原文需要條列。',
      '5. 不要自稱 AI，不要加入「以下是草稿」這類前言。',
      '',
      `文章標題：${article.title || '(無標題)'}`,
      `文章網址：${article.url}`,
      '',
      '文章內文：',
      article.content || '(無內文)',
    ].join('\n');
  }

  function requestChatCompletion(settings, messages) {
    const payload = {
      model: settings.model,
      messages,
      temperature: toNumber(settings.temperature, DEFAULT_SETTINGS.temperature),
      max_tokens: Math.max(1, Math.floor(toNumber(settings.maxTokens, DEFAULT_SETTINGS.maxTokens))),
    };

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    };

    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('目前的 userscript 管理器不支援跨網域 API 呼叫。'));
        return;
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: settings.endpoint,
        headers,
        data: JSON.stringify(payload),
        timeout: 60000,
        onload(response) {
          let data;

          try {
            data = JSON.parse(response.responseText || '{}');
          } catch {
            reject(new Error(`API 回應不是 JSON，HTTP ${response.status}`));
            return;
          }

          if (response.status < 200 || response.status >= 300) {
            const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
            reject(new Error(message));
            return;
          }

          resolve(data);
        },
        onerror() {
          reject(new Error('API 連線失敗。'));
        },
        ontimeout() {
          reject(new Error('API 等待逾時。'));
        },
      });
    });
  }

  function extractAssistantText(data) {
    return (
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.text ||
      data?.output_text ||
      ''
    );
  }

  function openDraftModal(article) {
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'betterbaha-ai-modal';
    overlay.innerHTML = `
      <div class="betterbaha-ai-dialog" role="dialog" aria-modal="true" aria-label="AI分析回覆">
        <div class="betterbaha-ai-dialog__header">
          <div>
            <h2>AI分析回覆</h2>
            <p>${escapeHtml(article.title || '目前文章')}</p>
          </div>
          <button type="button" class="betterbaha-ai-icon-button" data-action="close" title="關閉">
            <i class="fa fa-times" aria-hidden="true"></i>
          </button>
        </div>
        <div class="betterbaha-ai-status" data-role="status">準備產生草稿...</div>
        <textarea class="betterbaha-ai-draft" data-role="draft" placeholder="AI 回覆草稿會出現在這裡"></textarea>
        <div class="betterbaha-ai-dialog__footer">
          <button type="button" class="betterbaha-ai-secondary" data-action="settings">
            <i class="fa fa-cog" aria-hidden="true"></i><span>設定</span>
          </button>
          <button type="button" class="betterbaha-ai-secondary" data-action="copy" disabled>
            <i class="fa fa-copy" aria-hidden="true"></i><span>複製</span>
          </button>
          <button type="button" class="betterbaha-ai-primary" data-action="reply" disabled>
            <i class="fa fa-reply" aria-hidden="true"></i><span>前往回覆頁</span>
          </button>
        </div>
        <p class="betterbaha-ai-note">按下產生後，文章標題與內文會送到你設定的 API endpoint。API Key 會存在 userscript 管理器的本機儲存空間。</p>
      </div>
    `;

    document.body.append(overlay);

    const draftField = overlay.querySelector('[data-role="draft"]');
    const status = overlay.querySelector('[data-role="status"]');
    const copyButton = overlay.querySelector('[data-action="copy"]');
    const replyButton = overlay.querySelector('[data-action="reply"]');

    overlay.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        closeModal();
      }
    });

    overlay.querySelector('[data-action="settings"]').addEventListener('click', () => {
      openSettingsModal();
    });

    copyButton.addEventListener('click', async () => {
      await copyText(draftField.value);
      showToast('已複製 AI 草稿。');
    });

    replyButton.addEventListener('click', () => {
      writePendingDraft(article, draftField.value);
      location.href = article.replyUrl;
    });

    return {
      setBusy(isBusy) {
        for (const button of overlay.querySelectorAll('button')) {
          if (button.dataset.action !== 'close' && button.dataset.action !== 'settings') {
            button.disabled = isBusy || !draftField.value.trim();
          }
        }
      },
      setStatus(message, type = '') {
        status.textContent = message;
        status.dataset.type = type;
      },
      setDraft(value) {
        draftField.value = value || '';
        copyButton.disabled = !draftField.value.trim();
        replyButton.disabled = !draftField.value.trim();
      },
    };
  }

  function openSettingsModal(options = {}) {
    closeModal();

    const settings = loadSettings();
    const primaryText = options.primaryText || '儲存設定';
    const overlay = document.createElement('div');
    overlay.className = 'betterbaha-ai-modal';
    overlay.innerHTML = `
      <div class="betterbaha-ai-dialog betterbaha-ai-dialog--settings" role="dialog" aria-modal="true" aria-label="BetterBaha AI 設定">
        <div class="betterbaha-ai-dialog__header">
          <div>
            <h2>AI 回覆設定</h2>
            <p>預設使用 OpenCode Zen 的 deepseek-v4-flash-free。</p>
          </div>
          <button type="button" class="betterbaha-ai-icon-button" data-action="close" title="關閉">
            <i class="fa fa-times" aria-hidden="true"></i>
          </button>
        </div>
        <label class="betterbaha-ai-field">
          <span>API Endpoint</span>
          <input type="url" data-field="endpoint" value="${escapeHtml(settings.endpoint)}" spellcheck="false">
        </label>
        <label class="betterbaha-ai-field">
          <span>Model</span>
          <input type="text" data-field="model" value="${escapeHtml(settings.model)}" spellcheck="false">
        </label>
        <label class="betterbaha-ai-field">
          <span>API Key</span>
          <input type="password" data-field="apiKey" value="${escapeHtml(settings.apiKey)}" spellcheck="false" autocomplete="off">
        </label>
        <div class="betterbaha-ai-field-row">
          <label class="betterbaha-ai-field">
            <span>Temperature</span>
            <input type="number" data-field="temperature" min="0" max="2" step="0.1" value="${escapeHtml(settings.temperature)}">
          </label>
          <label class="betterbaha-ai-field">
            <span>Max Tokens</span>
            <input type="number" data-field="maxTokens" min="1" step="1" value="${escapeHtml(settings.maxTokens)}">
          </label>
        </div>
        <label class="betterbaha-ai-field">
          <span>系統提示詞</span>
          <textarea data-field="systemPrompt" spellcheck="false">${escapeHtml(settings.systemPrompt)}</textarea>
        </label>
        <div class="betterbaha-ai-dialog__footer">
          <button type="button" class="betterbaha-ai-secondary" data-action="reset">
            <i class="fa fa-undo" aria-hidden="true"></i><span>還原預設</span>
          </button>
          <button type="button" class="betterbaha-ai-primary" data-action="save">
            <i class="fa fa-save" aria-hidden="true"></i><span>${escapeHtml(primaryText)}</span>
          </button>
        </div>
        <p class="betterbaha-ai-note">API Key 只會儲存在本機，但不會加密。共用電腦請自行斟酌。</p>
      </div>
    `;

    document.body.append(overlay);

    overlay.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        closeModal();
      }
    });

    overlay.querySelector('[data-action="reset"]').addEventListener('click', () => {
      fillSettingsForm(overlay, DEFAULT_SETTINGS);
    });

    overlay.querySelector('[data-action="save"]').addEventListener('click', () => {
      try {
        const nextSettings = readSettingsForm(overlay);
        saveSettings(nextSettings);
        closeModal();
        showToast('AI 回覆設定已儲存。');

        if (typeof options.afterSave === 'function') {
          options.afterSave(nextSettings);
        }
      } catch (error) {
        showToast(error.message || String(error));
      }
    });
  }

  function fillSettingsForm(root, settings) {
    for (const [key, value] of Object.entries(settings)) {
      const field = root.querySelector(`[data-field="${key}"]`);
      if (field) {
        field.value = value;
      }
    }
  }

  function readSettingsForm(root) {
    return {
      endpoint: root.querySelector('[data-field="endpoint"]').value.trim(),
      model: root.querySelector('[data-field="model"]').value.trim(),
      apiKey: root.querySelector('[data-field="apiKey"]').value.trim(),
      temperature: toNumber(root.querySelector('[data-field="temperature"]').value, DEFAULT_SETTINGS.temperature),
      maxTokens: Math.max(1, Math.floor(toNumber(root.querySelector('[data-field="maxTokens"]').value, DEFAULT_SETTINGS.maxTokens))),
      systemPrompt: root.querySelector('[data-field="systemPrompt"]').value.trim() || DEFAULT_SETTINGS.systemPrompt,
    };
  }

  function installPendingDraftOnReplyPage() {
    if (!isReplyPage() || state.replyDraftChecked) {
      return;
    }

    state.replyDraftChecked = true;
    const pending = readPendingDraft();
    if (!pending) {
      return;
    }

    const currentKey = getArticleKey();
    if (currentKey && pending.key && currentKey !== pending.key) {
      return;
    }

    const banner = showReplyBanner('偵測到 AI 回覆草稿，正在嘗試填入編輯器...');
    let attempts = 0;
    banner.showFill(pending.draft, () => {
      if (completeReplyDraftFill(pending, banner)) {
        return true;
      }

      banner.setMessage('還是沒有填入。請先點一下文章區空白處，再按「啟用並填入」。', 'error');
      return false;
    });

    const timer = window.setInterval(() => {
      attempts += 1;

      if (completeReplyDraftFill(pending, banner)) {
        clearInterval(timer);
        return;
      }

      if (attempts === 4) {
        banner.setMessage('編輯器尚未啟用。可點「啟用並填入」，或點文章區空白處後再等一下。');
      }

      if (attempts >= 45) {
        clearInterval(timer);
        banner.setMessage('找不到可自動填入的編輯器。草稿已保留，可改用手動複製。', 'error');
        banner.showCopy(pending.draft);
      }
    }, 400);
  }

  function completeReplyDraftFill(pending, banner) {
    if (!fillReplyEditor(pending.draft)) {
      return false;
    }

    markAiCreatedCheckbox();
    removePendingDraft();
    banner.setMessage('已填入 AI 回覆草稿。請確認內容後再發布。', 'ready');
    banner.hideFill();
    return true;
  }

  function fillReplyEditor(text) {
    const html = textToEditorHtml(text);
    const plainText = String(text || '').trim();

    activateReplyEditor();

    if (window.CKEDITOR?.instances) {
      const instances = Object.values(window.CKEDITOR.instances);
      for (const instance of instances) {
        if (typeof instance.setData === 'function') {
          if (typeof instance.focus === 'function') {
            instance.focus();
          }
          instance.setData(html);
          if (typeof instance.updateElement === 'function') {
            instance.updateElement();
          }

          if (editorHasDraft(instance.getData?.() || '', plainText)) {
            syncEditorFields(html, plainText);
            return true;
          }
        }
      }
    }

    const boardNoticeTarget = findBoardNoticeTarget();
    if (boardNoticeTarget) {
      boardNoticeTarget.focus?.();
      boardNoticeTarget.click?.();
      boardNoticeTarget.innerHTML = html;
      dispatchEditorEvents(boardNoticeTarget, text);
      syncEditorFields(html, plainText);
      return editorHasDraft(boardNoticeTarget.textContent || boardNoticeTarget.innerText || '', plainText);
    }

    const iframe = document.querySelector('.cke_wysiwyg_frame');
    if (iframe?.contentDocument?.body) {
      const body = iframe.contentDocument.body;
      iframe.contentWindow?.focus();
      body.focus();
      body.click();
      body.innerHTML = html;
      dispatchEditorEvents(body, text);
      syncEditorFields(html, plainText);
      return editorHasDraft(body.textContent || body.innerText || '', plainText);
    }

    for (const iframeBody of getEditableIframeBodies()) {
      iframeBody.ownerDocument.defaultView?.focus();
      iframeBody.focus();
      iframeBody.click();
      iframeBody.innerHTML = html;
      dispatchEditorEvents(iframeBody, text);
      syncEditorFields(html, plainText);
      if (editorHasDraft(iframeBody.textContent || iframeBody.innerText || '', plainText)) {
        return true;
      }
    }

    const editable = document.querySelector(
      '.cke_wysiwyg_div[contenteditable="true"], .editor__input[contenteditable="true"], .ql-editor, .ProseMirror, [role="textbox"][contenteditable="true"], [contenteditable="true"]'
    );
    if (editable) {
      editable.focus();
      editable.click();
      editable.innerHTML = html;
      dispatchEditorEvents(editable, text);
      syncEditorFields(html, plainText);
      return editorHasDraft(editable.textContent || editable.innerText || '', plainText);
    }

    const textarea = document.querySelector(
      'form[name="frm"] textarea[name="content"], form[name="frm"] textarea[name="rtecontent"], textarea[name="content"], textarea[name="rtecontent"]'
    );

    if (textarea) {
      textarea.value = text;
      dispatchEditorEvents(textarea, text);
      return textarea.offsetParent !== null && editorHasDraft(textarea.value, plainText);
    }

    return false;
  }

  function activateReplyEditor() {
    const targets = [
      document.querySelector('.cke_wysiwyg_frame'),
      ...Array.from(document.querySelectorAll('iframe')),
      document.querySelector('.cke_contents'),
      document.querySelector('.cke_wysiwyg_div[contenteditable="true"]'),
      document.querySelector('.editor__input[contenteditable="true"]'),
      document.querySelector('.ql-editor'),
      document.querySelector('.ProseMirror'),
      findBoardNoticeTarget(),
      document.querySelector('[role="textbox"][contenteditable="true"]'),
      document.querySelector('[contenteditable="true"]'),
    ].filter(Boolean);

    for (const target of targets) {
      try {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        target.click();
        target.focus?.();
      } catch {
        // Keep trying other editor surfaces.
      }
    }
  }

  function findBoardNoticeTarget() {
    const noticePattern = /發文前請先閱讀板規|維護您自身在板上發文的權益|請尊重他人喜歡品牌的權利/;

    for (const iframeBody of getEditableIframeBodies()) {
      if (noticePattern.test(iframeBody.textContent || '')) {
        return iframeBody;
      }
    }

    const candidates = Array.from(document.querySelectorAll(
      '.cke_wysiwyg_div, .editor__input, .ql-editor, .ProseMirror, [role="textbox"], [contenteditable], article, section, div'
    ));

    return candidates
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          rect,
          area: rect.width * rect.height,
          score: getEditorCandidateScore(element),
        };
      })
      .filter((item) => {
        const { element, rect } = item;
      if (!noticePattern.test(element.textContent || '')) {
        return false;
      }

        return (
          rect.width >= 320 &&
          rect.width <= 1300 &&
          rect.height >= 180 &&
          rect.height <= 1000 &&
          rect.top < window.innerHeight &&
          rect.bottom > 0
        );
      })
      .sort((a, b) => b.score - a.score || a.area - b.area)[0]?.element || null;
  }

  function getEditorCandidateScore(element) {
    const name = `${element.id} ${element.className} ${element.getAttribute('role') || ''}`;
    let score = 0;

    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
      score += 6;
    }

    if (/cke|editor|wysiwyg|textbox|ql-editor|ProseMirror/i.test(name)) {
      score += 4;
    }

    if (/c-post|BH-master|wrapper|quicktool|side|menu|toolbar/i.test(name)) {
      score -= 4;
    }

    return score;
  }

  function getEditableIframeBodies() {
    const bodies = [];

    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument;
        if (!doc?.body) {
          continue;
        }

        const body = doc.body;
        const text = body.textContent || '';
        const isLikelyEditor =
          iframe.classList.contains('cke_wysiwyg_frame') ||
          /editor|wysiwyg|compose|content|iframe/i.test(`${iframe.id} ${iframe.name} ${iframe.className} ${iframe.title}`) ||
          body.isContentEditable ||
          doc.designMode === 'on' ||
          /發文前請先閱讀板規|維護您自身在板上發文的權益/.test(text);

        if (isLikelyEditor) {
          bodies.push(body);
        }
      } catch {
        // Cross-origin iframes cannot be inspected.
      }
    }

    return bodies;
  }

  function syncEditorFields(html, plainText) {
    const form = document.forms.frm || document.querySelector('form[action*="post2.php"]');
    const rteField = form?.querySelector('[name="rtecontent"]') || document.querySelector('[name="rtecontent"]');
    const contentField = form?.querySelector('[name="content"]') || document.querySelector('[name="content"]');

    if (rteField) {
      rteField.value = html;
      dispatchEditorEvents(rteField, plainText);
    }

    if (contentField && contentField !== rteField) {
      contentField.value = plainText;
      dispatchEditorEvents(contentField, plainText);
    }
  }

  function dispatchEditorEvents(element, text) {
    const events = [
      ['input', { inputType: 'insertText', data: text }],
      ['change', {}],
      ['keyup', {}],
      ['blur', {}],
    ];

    for (const [type, init] of events) {
      try {
        const event = type === 'input' && typeof InputEvent === 'function'
          ? new InputEvent(type, { bubbles: true, cancelable: true, ...init })
          : new Event(type, { bubbles: true, cancelable: true });
        element.dispatchEvent(event);
      } catch {
        element.dispatchEvent(new Event(type, { bubbles: true }));
      }
    }
  }

  function editorHasDraft(currentValue, draftText) {
    const current = normalizeInlineText(stripHtml(currentValue));
    const draft = normalizeInlineText(draftText);
    if (!current || !draft) {
      return false;
    }

    return current.includes(draft.slice(0, Math.min(24, draft.length)));
  }

  function stripHtml(value) {
    return String(value || '').replace(/<[^>]*>/g, ' ');
  }

  function markAiCreatedCheckbox() {
    for (const checkbox of document.querySelectorAll('input[type="checkbox"]')) {
      const scope = checkbox.closest('label, li, .check-group, .form-group, .item') || checkbox.parentElement;
      if (!scope || !/AI\s*\u5275\u4f5c|AI/.test(scope.textContent || '')) {
        continue;
      }

      if (!checkbox.checked) {
        checkbox.click();
      }

      return;
    }
  }

  function showReplyBanner(message) {
    const banner = document.createElement('div');
    banner.className = 'betterbaha-ai-reply-banner';
    banner.innerHTML = `
      <span data-role="message"></span>
      <button type="button" data-action="fill" hidden><i class="fa fa-pencil" aria-hidden="true"></i><span>啟用並填入</span></button>
      <button type="button" data-action="copy" hidden><i class="fa fa-copy" aria-hidden="true"></i><span>複製草稿</span></button>
    `;
    document.body.append(banner);

    const messageElement = banner.querySelector('[data-role="message"]');
    const fillButton = banner.querySelector('[data-action="fill"]');
    const copyButton = banner.querySelector('[data-action="copy"]');
    messageElement.textContent = message;

    return {
      setMessage(nextMessage, type = '') {
        messageElement.textContent = nextMessage;
        banner.dataset.type = type;
      },
      showFill(text, onFill) {
        fillButton.hidden = false;
        fillButton.onclick = async () => {
          const filled = typeof onFill === 'function' ? onFill() : false;
          if (!filled) {
            await copyText(text);
            showToast('已複製草稿。請點文章區空白處後貼上。');
          }
        };
      },
      hideFill() {
        fillButton.hidden = true;
      },
      showCopy(text) {
        copyButton.hidden = false;
        copyButton.addEventListener('click', async () => {
          await copyText(text);
          showToast('已複製 AI 草稿。');
        }, { once: true });
      },
    };
  }

  function writePendingDraft(article, draft) {
    if (!draft || !draft.trim()) {
      return;
    }

    try {
      sessionStorage.setItem(PENDING_DRAFT_KEY, JSON.stringify({
        key: article.key,
        bsn: article.bsn,
        snA: article.snA,
        title: article.title,
        sourceUrl: article.url,
        draft,
        savedAt: Date.now(),
      }));
    } catch {
      // The copy button still gives the user access to the generated draft.
    }
  }

  function readPendingDraft() {
    try {
      const raw = sessionStorage.getItem(PENDING_DRAFT_KEY);
      if (!raw) {
        return null;
      }

      const data = JSON.parse(raw);
      if (!data?.draft || Date.now() - data.savedAt > PENDING_TTL_MS) {
        removePendingDraft();
        return null;
      }

      return data;
    } catch {
      return null;
    }
  }

  function removePendingDraft() {
    try {
      sessionStorage.removeItem(PENDING_DRAFT_KEY);
    } catch {
      // Ignore storage errors.
    }
  }

  function getReplyUrl() {
    const replyAnchor = Array.from(document.querySelectorAll('a[href*="post1.php"]')).find(isReplyAnchor);
    if (replyAnchor?.href) {
      return replyAnchor.href;
    }

    const params = new URLSearchParams(location.search);
    const url = new URL('/post1.php', location.origin);
    url.searchParams.set('bsn', params.get('bsn') || '');
    url.searchParams.set('type', '2');
    url.searchParams.set('snA', params.get('snA') || '');
    url.searchParams.set('subbsn', params.get('subbsn') || getThreadSubbsn() || '0');
    return url.toString();
  }

  function getThreadSubbsn() {
    return document.querySelector('input[name="threadSubbsn"]')?.value ||
      document.querySelector('a[href*="subbsn="]')?.href?.match(/[?&]subbsn=([^&]+)/)?.[1] ||
      '0';
  }

  function getArticleKey() {
    const params = new URLSearchParams(location.search);
    const bsn = params.get('bsn') || '';
    const snA = params.get('snA') || '';
    return bsn && snA ? `${bsn}:${snA}` : '';
  }

  function loadSettings() {
    const stored = gmGet(SETTINGS_KEY, {});
    return {
      ...DEFAULT_SETTINGS,
      ...(stored && typeof stored === 'object' ? stored : {}),
    };
  }

  function saveSettings(settings) {
    gmSet(SETTINGS_KEY, settings);
  }

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(key, fallback);
      }

      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }

      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      showToast('設定儲存失敗，可能是瀏覽器阻擋了本機儲存。');
    }
  }

  async function copyText(text) {
    if (!text) {
      return;
    }

    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text);
      return;
    }

    await navigator.clipboard.writeText(text);
  }

  function observePageChanges() {
    const root = document.documentElement || document.body;
    if (!root) {
      return;
    }

    const observer = new MutationObserver(scheduleInstall);
    observer.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function isArticlePage() {
    return /\/(?:C|Co)\.php$/i.test(location.pathname);
  }

  function isReplyPage() {
    return /\/post1\.php$/i.test(location.pathname);
  }

  function textToEditorHtml(text) {
    const lines = String(text || '').split(/\n/);
    const html = [];
    let paragraph = [];

    for (const line of lines) {
      if (line.trim()) {
        paragraph.push(escapeHtml(line));
        continue;
      }

      if (paragraph.length) {
        html.push(`<p>${paragraph.join('<br>')}</p>`);
        paragraph = [];
      }
    }

    if (paragraph.length) {
      html.push(`<p>${paragraph.join('<br>')}</p>`);
    }

    return html.join('') || '<p></p>';
  }

  function normalizeInlineText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function toNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getElementKey(element) {
    if (!element.dataset.betterbahaAiReplyTargetKey) {
      element.dataset.betterbahaAiReplyTargetKey = Math.random().toString(36).slice(2);
    }

    return element.dataset.betterbahaAiReplyTargetKey;
  }

  function closeModal() {
    document.querySelector('.betterbaha-ai-modal')?.remove();
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'betterbaha-ai-toast';
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.classList.add('is-visible'), 20);
    window.setTimeout(() => {
      toast.classList.remove('is-visible');
      window.setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = 'betterbaha-ai-reply-style';
    style.textContent = `
      .betterbaha-ai-reply-button {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        box-sizing: border-box !important;
        min-height: 34px !important;
        margin: 0 8px 0 0 !important;
        padding: 0 12px !important;
        border: 1px solid #0b8f9c !important;
        border-radius: 4px !important;
        background: #ffffff !important;
        color: #047986 !important;
        font-family: Arial, "Microsoft JhengHei", sans-serif !important;
        font-size: 14px !important;
        font-weight: 700 !important;
        line-height: 32px !important;
        text-decoration: none !important;
        vertical-align: middle !important;
        cursor: pointer !important;
      }

      .betterbaha-ai-reply-button:hover,
      .betterbaha-ai-reply-button:focus {
        background: #e9fbfd !important;
        color: #046a76 !important;
        text-decoration: none !important;
      }

      .toolbar .betterbaha-ai-reply-button,
      .c-menu__scrolldown .betterbaha-ai-reply-button {
        min-height: 30px !important;
        padding: 0 10px !important;
        line-height: 30px !important;
      }

      .betterbaha-ai-modal {
        position: fixed !important;
        inset: 0 !important;
        z-index: 99999 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        box-sizing: border-box !important;
        padding: 24px !important;
        background: rgba(16, 24, 28, 0.48) !important;
        font-family: Arial, "Microsoft JhengHei", sans-serif !important;
      }

      .betterbaha-ai-dialog {
        width: min(720px, 100%) !important;
        max-height: min(760px, calc(100vh - 48px)) !important;
        overflow: auto !important;
        box-sizing: border-box !important;
        border-radius: 8px !important;
        border: 1px solid rgba(30, 44, 50, 0.12) !important;
        background: #ffffff !important;
        color: #1f2d33 !important;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.24) !important;
      }

      .betterbaha-ai-dialog--settings {
        width: min(680px, 100%) !important;
      }

      .betterbaha-ai-dialog__header {
        display: flex !important;
        align-items: flex-start !important;
        justify-content: space-between !important;
        gap: 16px !important;
        padding: 20px 20px 12px !important;
        border-bottom: 1px solid #edf1f3 !important;
      }

      .betterbaha-ai-dialog h2 {
        margin: 0 0 6px !important;
        color: #0b5964 !important;
        font-size: 20px !important;
        line-height: 1.35 !important;
        letter-spacing: 0 !important;
      }

      .betterbaha-ai-dialog p {
        margin: 0 !important;
        color: #687982 !important;
        font-size: 13px !important;
        line-height: 1.5 !important;
      }

      .betterbaha-ai-icon-button {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 34px !important;
        height: 34px !important;
        border: 1px solid #d8e1e5 !important;
        border-radius: 4px !important;
        background: #ffffff !important;
        color: #5d6e76 !important;
        cursor: pointer !important;
      }

      .betterbaha-ai-status {
        margin: 16px 20px 12px !important;
        padding: 10px 12px !important;
        border-radius: 6px !important;
        background: #edf7f8 !important;
        color: #0b5964 !important;
        font-size: 14px !important;
        line-height: 1.45 !important;
      }

      .betterbaha-ai-status[data-type="error"] {
        background: #fff0f0 !important;
        color: #b42318 !important;
      }

      .betterbaha-ai-status[data-type="ready"] {
        background: #edf8f2 !important;
        color: #17663a !important;
      }

      .betterbaha-ai-draft {
        display: block !important;
        width: calc(100% - 40px) !important;
        min-height: 300px !important;
        box-sizing: border-box !important;
        margin: 0 20px !important;
        padding: 12px !important;
        border: 1px solid #cfd9dd !important;
        border-radius: 6px !important;
        color: #17262d !important;
        font-size: 15px !important;
        line-height: 1.65 !important;
        resize: vertical !important;
      }

      .betterbaha-ai-dialog__footer {
        display: flex !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: 10px !important;
        padding: 16px 20px !important;
      }

      .betterbaha-ai-primary,
      .betterbaha-ai-secondary,
      .betterbaha-ai-reply-banner button {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        min-height: 36px !important;
        box-sizing: border-box !important;
        padding: 0 14px !important;
        border-radius: 4px !important;
        font-size: 14px !important;
        font-weight: 700 !important;
        line-height: 1 !important;
        cursor: pointer !important;
      }

      .betterbaha-ai-primary {
        border: 1px solid #07899a !important;
        background: #07899a !important;
        color: #ffffff !important;
      }

      .betterbaha-ai-secondary,
      .betterbaha-ai-reply-banner button {
        border: 1px solid #cfd9dd !important;
        background: #ffffff !important;
        color: #27515b !important;
      }

      .betterbaha-ai-primary:disabled,
      .betterbaha-ai-secondary:disabled {
        opacity: 0.55 !important;
        cursor: default !important;
      }

      .betterbaha-ai-note {
        padding: 0 20px 18px !important;
      }

      .betterbaha-ai-field {
        display: grid !important;
        gap: 6px !important;
        margin: 14px 20px 0 !important;
        color: #30464f !important;
        font-size: 13px !important;
        font-weight: 700 !important;
      }

      .betterbaha-ai-field-row {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 12px !important;
      }

      .betterbaha-ai-field input,
      .betterbaha-ai-field textarea {
        width: 100% !important;
        box-sizing: border-box !important;
        border: 1px solid #cfd9dd !important;
        border-radius: 6px !important;
        padding: 9px 10px !important;
        color: #17262d !important;
        font-size: 14px !important;
        line-height: 1.5 !important;
      }

      .betterbaha-ai-field textarea {
        min-height: 86px !important;
        resize: vertical !important;
      }

      .betterbaha-ai-toast {
        position: fixed !important;
        right: 24px !important;
        bottom: 24px !important;
        z-index: 100000 !important;
        max-width: min(360px, calc(100vw - 48px)) !important;
        box-sizing: border-box !important;
        padding: 11px 14px !important;
        border-radius: 6px !important;
        background: #17262d !important;
        color: #ffffff !important;
        font-family: Arial, "Microsoft JhengHei", sans-serif !important;
        font-size: 14px !important;
        line-height: 1.45 !important;
        opacity: 0 !important;
        transform: translateY(8px) !important;
        transition: opacity 0.2s ease, transform 0.2s ease !important;
      }

      .betterbaha-ai-toast.is-visible {
        opacity: 1 !important;
        transform: translateY(0) !important;
      }

      .betterbaha-ai-reply-banner {
        position: fixed !important;
        left: 50% !important;
        top: 72px !important;
        z-index: 99998 !important;
        display: flex !important;
        align-items: center !important;
        gap: 12px !important;
        max-width: min(680px, calc(100vw - 40px)) !important;
        box-sizing: border-box !important;
        padding: 12px 14px !important;
        border: 1px solid #cbe7eb !important;
        border-radius: 6px !important;
        background: #f0fbfc !important;
        color: #0b5964 !important;
        font-family: Arial, "Microsoft JhengHei", sans-serif !important;
        font-size: 14px !important;
        font-weight: 700 !important;
        line-height: 1.45 !important;
        transform: translateX(-50%) !important;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14) !important;
      }

      .betterbaha-ai-reply-banner[data-type="error"] {
        border-color: #ffd3d0 !important;
        background: #fff6f5 !important;
        color: #b42318 !important;
      }

      .betterbaha-ai-reply-banner[data-type="ready"] {
        border-color: #ccebd8 !important;
        background: #f1fbf5 !important;
        color: #17663a !important;
      }

      @media (max-width: 640px) {
        .betterbaha-ai-modal {
          align-items: stretch !important;
          padding: 12px !important;
        }

        .betterbaha-ai-dialog {
          max-height: calc(100vh - 24px) !important;
        }

        .betterbaha-ai-dialog__footer,
        .betterbaha-ai-field-row {
          grid-template-columns: 1fr !important;
        }

        .betterbaha-ai-dialog__footer {
          display: grid !important;
        }

        .betterbaha-ai-primary,
        .betterbaha-ai-secondary {
          width: 100% !important;
        }
      }

      html[data-theme="dark"] .betterbaha-ai-reply-button {
        border-color: #1db4bd !important;
        background: #1d2b30 !important;
        color: #b9f5f4 !important;
      }
    `;

    document.getElementById(style.id)?.remove();
    (document.head || document.documentElement).append(style);
  }
})();
