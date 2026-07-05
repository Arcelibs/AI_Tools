// ==UserScript==
// @name         BetterBaha Work Mode
// @namespace    https://forum.gamer.com.tw/
// @version      0.1.2
// @description  Collapse Bahamut NOW and hide forum images by default for a cleaner work-mode view.
// @match        https://forum.gamer.com.tw/B.php*
// @match        https://forum.gamer.com.tw/C.php*
// @match        https://forum.gamer.com.tw/Co.php*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '0.1.2';
  const NOW_MODE = 'collapse'; // Use 'hide' to remove the NOW block completely.
  const APPLY_DELAY_MS = 80;

  const selectors = {
    nowContainer: '.now_chatroom-container',
    imageTargets: [
      '#BH-master .b-list__main .b-list__img',
      '#BH-master .popular__card-img img',
      '#BH-master .popular__item .img img',
      '#BH-master .c-article__content img',
      '#BH-master .reply-content__article img',
    ].join(','),
    ignoredImages: [
      '.b-list__summary__mark',
      '.b-mark',
      '.card-label',
      '.master-icon',
      '.tag-category',
      '.tag-category_item',
    ].join(','),
  };

  let applyTimer = 0;

  document.documentElement.dataset.betterbahaWorkModeVersion = SCRIPT_VERSION;
  injectStyle();
  bindRevealEvents();
  observePageChanges();
  scheduleApply();

  document.addEventListener('DOMContentLoaded', scheduleApply, { once: true });
  window.addEventListener('load', scheduleApply, { once: true });

  function scheduleApply() {
    if (applyTimer) {
      return;
    }

    applyTimer = window.setTimeout(() => {
      applyTimer = 0;
      applyWorkMode();
    }, APPLY_DELAY_MS);
  }

  function applyWorkMode() {
    collapseNow();
    hideImages();
  }

  function collapseNow() {
    const container = document.querySelector(selectors.nowContainer);

    if (!container || container.dataset.betterbahaWorkModeNow === SCRIPT_VERSION) {
      return;
    }

    container.dataset.betterbahaWorkModeNow = SCRIPT_VERSION;

    if (NOW_MODE === 'hide') {
      container.style.display = 'none';
      return;
    }

    if (isNowCollapsed(container)) {
      return;
    }

    if (window.LiteTop && typeof window.LiteTop.chatroomCollapse === 'function') {
      window.LiteTop.chatroomCollapse(false);
      return;
    }

    const collapseButton = container.querySelector('#imSwitch, .chatroom-collapse-btn');
    if (collapseButton) {
      collapseButton.click();
      return;
    }

    forceCollapseNow(container);
  }

  function isNowCollapsed(container) {
    const iconText = container.querySelector('#imSwitch i')?.textContent?.trim();
    return container.classList.contains('is-bpageclose') || iconText === 'add_box';
  }

  function forceCollapseNow(container) {
    container.classList.add('is-bpageclose');
    container.classList.remove('is-bpage');

    for (const item of container.querySelectorAll('.chatroom-hide')) {
      item.style.display = 'none';
    }

    const opener = container.querySelector('.chatroom-openbtn-area');
    if (opener) {
      opener.style.display = '';
    }

    const icon = container.querySelector('#imSwitch i');
    if (icon) {
      icon.textContent = 'add_box';
    }
  }

  function hideImages() {
    for (const target of document.querySelectorAll(selectors.imageTargets)) {
      if (target.matches('.b-list__img')) {
        prepareThumbnail(target);
      } else if (target.tagName === 'IMG') {
        prepareImage(target);
      }
    }
  }

  function prepareThumbnail(thumbnail) {
    if (thumbnail.dataset.betterbahaWorkModeImage === SCRIPT_VERSION) {
      return;
    }

    thumbnail.dataset.betterbahaWorkModeImage = SCRIPT_VERSION;
    thumbnail.dataset.betterbahaLabel = '圖片已隱藏';
    thumbnail.classList.add('betterbaha-work-hidden-box');
    thumbnail.setAttribute('role', 'button');
    thumbnail.setAttribute('tabindex', '0');
    thumbnail.setAttribute('aria-label', '圖片已隱藏，點一下顯示');
  }

  function prepareImage(image) {
    if (image.dataset.betterbahaWorkModeImage === SCRIPT_VERSION) {
      return;
    }

    if (image.closest(selectors.ignoredImages)) {
      return;
    }

    const existingShell = image.closest('.betterbaha-work-image-shell');
    if (existingShell) {
      markShell(existingShell, image);
      return;
    }

    const linkShell = getReusableImageLink(image);
    if (linkShell) {
      markShell(linkShell, image);
      return;
    }

    const shell = document.createElement('span');
    image.before(shell);
    shell.append(image);
    markShell(shell, image);
  }

  function getReusableImageLink(image) {
    const parent = image.parentElement;

    if (!parent || parent.classList.contains('betterbaha-work-image-shell')) {
      return null;
    }

    if (!parent.matches('a.photoswipe-image, a[href]')) {
      return null;
    }

    return parent.children.length === 1 ? parent : null;
  }

  function markShell(shell, image) {
    shell.dataset.betterbahaWorkModeImage = SCRIPT_VERSION;
    shell.dataset.betterbahaLabel = '圖片已隱藏，點一下顯示';
    shell.classList.add('betterbaha-work-image-shell');
    shell.setAttribute('role', 'button');
    shell.setAttribute('tabindex', '0');
    shell.setAttribute('aria-label', '圖片已隱藏，點一下顯示');
    image.dataset.betterbahaWorkModeImage = SCRIPT_VERSION;
  }

  function bindRevealEvents() {
    document.addEventListener('click', (event) => {
      const target = getRevealTarget(event.target);
      if (!target || target.classList.contains('betterbaha-work-revealed')) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      revealImage(target);
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      const target = getRevealTarget(event.target);
      if (!target || target.classList.contains('betterbaha-work-revealed')) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      revealImage(target);
    }, true);
  }

  function getRevealTarget(rawTarget) {
    const target = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement;

    if (!target) {
      return null;
    }

    return target.closest('.betterbaha-work-hidden-box, .betterbaha-work-image-shell');
  }

  function revealImage(target) {
    target.classList.add('betterbaha-work-revealed');
    target.removeAttribute('role');
    target.removeAttribute('tabindex');
    target.removeAttribute('aria-label');
  }

  function observePageChanges() {
    const root = document.documentElement || document.body;
    if (!root) {
      return;
    }

    const observer = new MutationObserver(scheduleApply);
    observer.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = 'betterbaha-work-mode-style';
    style.textContent = `
      .betterbaha-work-hidden-box {
        position: relative !important;
        overflow: hidden !important;
      }

      .betterbaha-work-hidden-box:not(.betterbaha-work-revealed) {
        background-image: none !important;
        background-color: #edf3f5 !important;
        cursor: pointer !important;
      }

      .betterbaha-work-hidden-box::before,
      .betterbaha-work-image-shell::before {
        content: attr(data-betterbaha-label);
        position: absolute;
        inset: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        padding: 6px 10px;
        border: 1px dashed rgba(17, 126, 150, 0.45);
        background:
          repeating-linear-gradient(
            -45deg,
            rgba(17, 126, 150, 0.08) 0,
            rgba(17, 126, 150, 0.08) 8px,
            rgba(255, 255, 255, 0.68) 8px,
            rgba(255, 255, 255, 0.68) 16px
          );
        color: #39606a;
        font-family: Arial, "Microsoft JhengHei", sans-serif;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.35;
        text-align: center;
        white-space: normal;
        pointer-events: none;
      }

      .betterbaha-work-hidden-box.betterbaha-work-revealed {
        background-color: transparent !important;
        cursor: inherit !important;
      }

      .betterbaha-work-hidden-box.betterbaha-work-revealed::before,
      .betterbaha-work-image-shell.betterbaha-work-revealed::before {
        display: none !important;
      }

      .betterbaha-work-image-shell {
        position: relative !important;
        display: inline-flex !important;
        width: min(260px, 100%) !important;
        min-width: 148px !important;
        height: 46px !important;
        max-width: 100% !important;
        margin: 2px 0 !important;
        vertical-align: middle !important;
        overflow: hidden !important;
        border-radius: 4px !important;
        background-color: #edf3f5 !important;
        cursor: pointer !important;
        text-decoration: none !important;
      }

      .betterbaha-work-image-shell > img {
        width: 100% !important;
        height: 46px !important;
        max-width: 100% !important;
        object-fit: cover !important;
        opacity: 0 !important;
        visibility: hidden !important;
      }

      .betterbaha-work-image-shell.betterbaha-work-revealed {
        display: inline-block !important;
        width: auto !important;
        min-width: 0 !important;
        height: auto !important;
        margin: 0 !important;
        overflow: visible !important;
        border-radius: 0 !important;
        background-color: transparent !important;
        cursor: inherit !important;
      }

      .betterbaha-work-image-shell.betterbaha-work-revealed > img {
        width: auto !important;
        height: auto !important;
        object-fit: initial !important;
        opacity: 1 !important;
        visibility: visible !important;
      }

      html[data-theme="dark"] .betterbaha-work-hidden-box:not(.betterbaha-work-revealed),
      html[data-theme="dark"] .betterbaha-work-image-shell:not(.betterbaha-work-revealed) {
        background-color: #243136 !important;
      }

      html[data-theme="dark"] .betterbaha-work-hidden-box::before,
      html[data-theme="dark"] .betterbaha-work-image-shell::before {
        border-color: rgba(0, 176, 182, 0.5);
        background:
          repeating-linear-gradient(
            -45deg,
            rgba(0, 176, 182, 0.16) 0,
            rgba(0, 176, 182, 0.16) 8px,
            rgba(18, 24, 27, 0.78) 8px,
            rgba(18, 24, 27, 0.78) 16px
          );
        color: #b8e8e8;
      }
    `;

    document.getElementById(style.id)?.remove();
    (document.head || document.documentElement).append(style);
  }
})();
