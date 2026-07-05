// ==UserScript==
// @name         BetterBaha GP/BP on board list
// @namespace    https://forum.gamer.com.tw/
// @version      0.1.7
// @description  Show GP/BP counts in the left summary column for selected Bahamut forum subboards.
// @match        https://forum.gamer.com.tw/B.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '0.1.7';
  // Use null for all subboards, or set this to new Set(['9', '10']) to limit it.
  const TARGET_SUBBOARDS = null;
  const CACHE_PREFIX = 'betterbaha:gpbp:v1:';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const MAX_PARALLEL_FETCHES = 3;
  const RETRY_DELAY_MS = 800;

  const state = {
    queue: [],
    active: 0,
  };

  document.documentElement.dataset.betterbahaGpbpVersion = SCRIPT_VERSION;
  injectStyle();
  processRows();
  observeListChanges();

  function processRows() {
    const rows = Array.from(document.querySelectorAll('tr.b-list__row.b-list-item'));

    for (const row of rows) {
      if (row.dataset.betterbahaGpbpVersion === SCRIPT_VERSION) {
        continue;
      }

      const info = getRowInfo(row);
      if (!info) {
        continue;
      }

      row.dataset.betterbahaGpbp = '1';
      row.dataset.betterbahaGpbpVersion = SCRIPT_VERSION;
      renderWidget(row, {
        gp: info.listGp || '-',
        bp: '...',
        status: 'loading',
      });

      const cached = readCache(info.cacheKey);
      if (cached) {
        renderWidget(row, {
          gp: cached.gp || info.listGp || '-',
          bp: cached.bp || '-',
          status: 'ready',
        });
        continue;
      }

      state.queue.push({ row, info });
      drainQueue();
    }
  }

  function getRowInfo(row) {
    const sortLink = row.querySelector('.b-list__summary__sort a');
    const subboard = sortLink?.dataset.subbsn || readQuery(sortLink?.href, 'subbsn');

    if (!isTargetSubboard(subboard)) {
      return null;
    }

    const titleLink =
      row.querySelector('.b-list__main a[href*="C.php"][href*="snA="]') ||
      row.querySelector('.b-list__main__title[href*="C.php"][href*="snA="]') ||
      row.querySelector('a[href*="C.php"][href*="snA="]');
    const snA = readQuery(titleLink?.href, 'snA');
    const bsn = readQuery(titleLink?.href, 'bsn') || readQuery(location.href, 'bsn');

    if (!titleLink || !snA || !bsn) {
      return null;
    }

    const articleUrl = new URL('/C.php', location.origin);
    articleUrl.searchParams.set('bsn', bsn);
    articleUrl.searchParams.set('snA', snA);

    return {
      articleUrl: articleUrl.toString(),
      cacheKey: `${CACHE_PREFIX}${bsn}:${snA}`,
      listGp: normalizeScore(getOwnText(row.querySelector('.b-list__summary__gp'))),
    };
  }

  function isTargetSubboard(subboard) {
    return TARGET_SUBBOARDS === null || TARGET_SUBBOARDS.has(subboard);
  }

  function renderWidget(row, scores) {
    const summary = row.querySelector('.b-list__summary');
    const sort = summary?.querySelector('.b-list__summary__sort');
    let gpElement = summary?.querySelector('.b-list__summary__gp');

    if (!summary) {
      return null;
    }

    row.classList.add('betterbaha-gpbp-row');

    for (const widget of summary.querySelectorAll('.betterbaha-bp')) {
      widget.remove();
    }

    if (!gpElement) {
      gpElement = document.createElement('span');
      gpElement.className = 'b-list__summary__gp b-gp b-gp--normal betterbaha-gpbp-created';
      if (sort) {
        sort.insertAdjacentElement('afterend', gpElement);
      } else {
        summary.append(gpElement);
      }
    }

    const currentGp = getOwnText(gpElement);
    const isCreatedGp = gpElement.classList.contains('betterbaha-gpbp-created');
    const visibleGp = isCreatedGp ? (scores.gp || currentGp || '-') : (currentGp || scores.gp || '-');
    const visibleBp = formatBpScore(scores.bp);

    if (isCreatedGp || !currentGp) {
      setOwnText(gpElement, visibleGp);
    }

    gpElement.classList.add('betterbaha-gpbp-anchor');
    gpElement.dataset.betterbahaGp = `GP ${visibleGp}`;
    gpElement.dataset.betterbahaBp = `BP ${visibleBp}`;
    gpElement.dataset.betterbahaBpStatus = scores.status || 'ready';
    gpElement.title = `GP ${visibleGp} / BP ${visibleBp}`;
    return gpElement;
  }

  function getOwnText(element) {
    if (!element) {
      return '';
    }

    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join('')
      .trim();
  }

  function setOwnText(element, value) {
    const textNode = Array.from(element.childNodes).find((node) => node.nodeType === 3);
    if (textNode) {
      textNode.textContent = value;
      return;
    }

    element.prepend(document.createTextNode(value));
  }

  function drainQueue() {
    while (state.active < MAX_PARALLEL_FETCHES && state.queue.length > 0) {
      const job = state.queue.shift();
      state.active += 1;

      fetchArticleScores(job.info)
        .then((scores) => {
          const finalScores = {
            gp: scores.gp || job.info.listGp || '-',
            bp: scores.bp || '-',
          };

          writeCache(job.info.cacheKey, finalScores);
          renderWidget(job.row, { ...finalScores, status: 'ready' });
        })
        .catch(() => {
          renderWidget(job.row, {
            gp: job.info.listGp || '-',
            bp: '?',
            status: 'error',
          });
        })
        .finally(() => {
          state.active -= 1;
          setTimeout(drainQueue, RETRY_DELAY_MS);
        });
    }
  }

  async function fetchArticleScores(info) {
    const response = await fetch(info.articleUrl, {
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    return {
      gp: normalizeScore(doc.querySelector('.postgp span')?.textContent),
      bp: normalizeScore(doc.querySelector('.postbp span')?.textContent),
    };
  }

  function readQuery(rawUrl, key) {
    if (!rawUrl) {
      return '';
    }

    try {
      return new URL(rawUrl, location.origin).searchParams.get(key) || '';
    } catch {
      return '';
    }
  }

  function normalizeScore(value) {
    const text = String(value || '').trim();
    return text || '-';
  }

  function formatBpScore(value) {
    const text = normalizeScore(value);

    if (text === '-') {
      return '0';
    }

    return text;
  }

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return null;
      }

      const data = JSON.parse(raw);
      if (!data || Date.now() - data.savedAt > CACHE_TTL_MS) {
        localStorage.removeItem(key);
        return null;
      }

      return data.scores || null;
    } catch {
      return null;
    }
  }

  function writeCache(key, scores) {
    try {
      localStorage.setItem(key, JSON.stringify({
        savedAt: Date.now(),
        scores,
      }));
    } catch {
      // Browsers can deny storage in private mode; the script still works without cache.
    }
  }

  function observeListChanges() {
    const list = document.querySelector('.b-list') || document.querySelector('#BH-master') || document.body;
    const observer = new MutationObserver(() => processRows());
    observer.observe(list, {
      childList: true,
      subtree: true,
    });
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = 'betterbaha-gpbp-style';
    style.textContent = `
      .betterbaha-gpbp-row .betterbaha-gpbp-anchor {
        position: relative !important;
        overflow: visible !important;
        height: 30px !important;
        margin-top: 8px !important;
        margin-bottom: -8px !important;
        color: transparent !important;
      }

      .betterbaha-gpbp-row .betterbaha-gpbp-anchor::before {
        content: attr(data-betterbaha-gp);
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        display: block;
        color: #f3a36f !important;
        font-family: Arial, "Microsoft JhengHei", sans-serif;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
        pointer-events: none;
      }

      .betterbaha-gpbp-row .betterbaha-gpbp-created {
        display: block;
        width: 70px;
        margin: 8px 0 -8px;
        font-family: "Teko", "Microsoft JhengHei", sans-serif;
        font-size: 20px;
        line-height: 22px;
      }

      .betterbaha-gpbp-row .betterbaha-gpbp-anchor[data-betterbaha-bp]::after {
        content: attr(data-betterbaha-bp);
        position: absolute;
        left: 0;
        right: 0;
        top: 15px;
        display: block;
        width: auto;
        margin: 0;
        color: #8a8f98 !important;
        font-family: Arial, "Microsoft JhengHei", sans-serif;
        font-size: 10px;
        font-weight: 600;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
        pointer-events: none;
        z-index: 1;
      }

      .betterbaha-gpbp-row .betterbaha-gpbp-anchor[data-betterbaha-bp-status="loading"]::after,
      .betterbaha-gpbp-row .betterbaha-gpbp-anchor[data-betterbaha-bp-status="error"]::after {
        color: #a8adb4 !important;
      }

      html[data-theme="dark"] .betterbaha-gpbp-row .betterbaha-gpbp-anchor[data-betterbaha-bp]::after {
        color: #a7adb7 !important;
      }
    `;
    document.getElementById(style.id)?.remove();
    document.head.append(style);
  }
})();
