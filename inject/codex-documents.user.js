(() => {
  "use strict";

  const VERSION = "1.0.0";
  const SOURCE_HASH = window.__CODEX_DOCUMENTS_SOURCE_HASH__ || VERSION;
  const SENTINEL_KEY = "__codexDocumentsInjection__";
  const DEFAULT_DOCUMENTS_URL = "http://127.0.0.1:47824/?host=codex";
  const ENTRY_ID = "codex-documents-entry";
  const PAGE_ID = "codex-documents-page";
  const FRAME_ID = "codex-documents-frame";
  const STATUS_ID = "codex-documents-status";
  const DRAG_REGION_ID = "codex-documents-drag-region";
  const STYLE_ID = "codex-documents-inject-style";
  const OWNED_ATTRIBUTE = "data-codex-documents-owned";
  const HIDDEN_ATTRIBUTE = "data-codex-documents-native-hidden";
  const HOST_ATTRIBUTE = "data-codex-documents-page-host";
  const NATIVE_SELECTED_ATTRIBUTE = "data-codex-documents-native-selected";
  const PLUGIN_LABELS = ["插件", "plugins"];
  const NATIVE_PAGE_LABELS = [
    "新建任务",
    "new task",
    "新对话",
    "new chat",
    "拉取请求",
    "pull requests",
    "站点",
    "sites",
    "已安排",
    "scheduled",
    "插件",
    "plugins",
  ];
  const MACOS_TITLEBAR_SAFE_LEFT = 80;
  const REATTACH_DELAY_MS = 120;
  const READY_TIMEOUT_MS = 15_000;
  const CONTEXT_SYNC_INTERVAL_MS = 2_000;

  const previous = window[SENTINEL_KEY];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let entry = null;
  let page = null;
  let frame = null;
  let status = null;
  let dragRegion = null;
  let frameOrigin = "";
  let frameReady = false;
  let active = false;
  let destroyed = false;
  let observer = null;
  let refreshTimer = null;
  let contextTimer = null;
  let readyTimer = null;
  let lastLocation = window.location.href;
  let lastFocusedElement = null;
  const mutedNativeSelections = new Map();

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeThreadId(value) {
    return String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  }

  function canonicalThreadId(row) {
    if (!row) return "";
    const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      const id = normalizeThreadId(props?.conversationId || props?.entry?.conversationId);
      if (id && !id.startsWith("client-new-thread:")) return id;
    }
    return normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id"));
  }

  function resolveDocumentsUrl() {
    const configured = typeof window.__CODEX_DOCUMENTS_URL__ === "string"
      ? window.__CODEX_DOCUMENTS_URL__.trim()
      : "";
    try {
      const url = new URL(configured || DEFAULT_DOCUMENTS_URL);
      if (
        url.protocol !== "http:"
        || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      ) throw new Error("The document service must use loopback HTTP");
      url.searchParams.set("host", "codex");
      return url;
    } catch (_) {
      return new URL(DEFAULT_DOCUMENTS_URL);
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_ATTRIBUTE, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      [${HOST_ATTRIBUTE}="true"] {
        position: relative !important;
        z-index: 31 !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] {
        background-color: transparent !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] [class*="text-token-list-active-selection"] {
        color: var(--color-token-foreground, inherit) !important;
      }
      #${PAGE_ID} {
        position: absolute;
        inset: 0;
        z-index: 1;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden],
      #${FRAME_ID}[hidden],
      #${STATUS_ID}[hidden],
      #${DRAG_REGION_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${DRAG_REGION_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: drag;
      }
      #${STATUS_ID} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
      }
      #${STATUS_ID} button {
        display: block;
        margin: 10px auto 0;
        border: 1px solid var(--color-token-border, color-mix(in srgb, CanvasText 16%, transparent));
        border-radius: 7px;
        padding: 5px 10px;
        background: var(--color-token-main-surface-secondary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    const label = normalizedLabel(button.textContent || button.getAttribute("aria-label"));
    return labels.includes(label);
  }

  function findReferenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin?.parentElement) return plugin;

    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    return Array.from(group?.children || []).filter((child) => child.tagName === "BUTTON").at(-1) || null;
  }

  function setEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = `
      <path d="M6 3.5h8.5L19 8v12.5H6z"></path>
      <path d="M14.5 3.5V8H19M9 12h7M9 15.5h7"></path>
    `;
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute("aria-label", "打开文档产物");
    button.setAttribute("title", "文档产物");
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    const label = button.querySelector(".text-fade-truncate")
      || Array.from(button.querySelectorAll("span")).find((node) => buttonMatches(node, PLUGIN_LABELS));
    if (label) label.textContent = "文档产物";
    else button.textContent = "文档产物";
    setEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDocuments();
    });
    return button;
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    if (active && entry.getAttribute("aria-current") !== "page") {
      entry.setAttribute("aria-current", "page");
    } else if (!active && entry.hasAttribute("aria-current")) {
      entry.removeAttribute("aria-current");
    }
  }

  function findPageMount() {
    const direct = document.querySelector(".app-shell-main-content-frame");
    const frameHost = direct?.closest?.("[data-app-shell-main-content-layout]") ? direct : null;
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]")
      || document.querySelector("[data-app-shell-main-content-layout]");
    const resolvedFrameHost = frameHost || Array.from(viewport?.children || []).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8 && rect.height >= viewportRect.height * 0.7;
    });
    const surface = viewport?.parentElement;
    if (!resolvedFrameHost || !viewport || !surface || !surface.closest("main")) return null;
    return { surface };
  }

  function muteNativeSelection() {
    if (!active) return;
    document.querySelectorAll('aside nav[role="navigation"] [aria-current]')
      .forEach((node) => {
        if (node === entry || node.closest(`#${ENTRY_ID}`)) return;
        if (!mutedNativeSelections.has(node)) {
          mutedNativeSelections.set(node, node.getAttribute("aria-current"));
        }
        node.removeAttribute("aria-current");
        node.setAttribute(NATIVE_SELECTED_ATTRIBUTE, "true");
      });
  }

  function restoreNativeSelection() {
    mutedNativeSelections.forEach((ariaCurrent, node) => {
      if (!node.isConnected) return;
      if (ariaCurrent !== null) node.setAttribute("aria-current", ariaCurrent);
      node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE);
    });
    mutedNativeSelections.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE));
  }

  function hideNativeHeader() {
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]')
      .forEach((surface) => {
        Array.from(surface.children).forEach((child) => {
          if (child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
            child.setAttribute(HIDDEN_ATTRIBUTE, "true");
          }
        });
      });
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN_ATTRIBUTE));
    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HOST_ATTRIBUTE));
  }

  function currentTheme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    try {
      return getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function nativeSidebarTrigger() {
    const triggers = Array.from(document.querySelectorAll('[data-app-shell-sidebar-trigger="true"]'));
    return triggers.find((trigger) => getComputedStyle(trigger).visibility !== "hidden")
      || triggers[0]
      || null;
  }

  function nativeSidebarCollapsed() {
    const label = normalizedLabel(nativeSidebarTrigger()?.getAttribute("aria-label"));
    return label.startsWith("显示") || label.startsWith("show ");
  }

  function titlebarLeftInset() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return 0;
    if (nativeSidebarCollapsed()) return MACOS_TITLEBAR_SAFE_LEFT;
    const surfaceLeft = findPageMount()?.surface.getBoundingClientRect().left;
    if (!Number.isFinite(surfaceLeft)) return 0;
    return Math.max(0, Math.ceil(MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft));
  }

  function postToFrame(message) {
    if (!frame?.contentWindow || !frameOrigin) return;
    frame.contentWindow.postMessage(message, frameOrigin);
  }

  function postHostContext() {
    if (!frame) return;
    const payload = {
      theme: currentTheme(),
      sidebarCollapsed: nativeSidebarCollapsed(),
      titlebarLeftInset: titlebarLeftInset(),
    };
    postToFrame({ type: "documents:host-context", payload });
    postToFrame({ type: "documents:theme", theme: payload.theme });
  }

  function expandNativeSidebar() {
    const trigger = nativeSidebarTrigger();
    if (trigger && nativeSidebarCollapsed()) trigger.click();
    window.setTimeout(postHostContext, REATTACH_DELAY_MS);
  }

  function updateDragRegion(payload) {
    if (!dragRegion) return;
    const values = [payload?.x, payload?.y, payload?.width, payload?.height];
    if (!values.every(Number.isFinite) || payload.width <= 0 || payload.height <= 0) {
      dragRegion.hidden = true;
      return;
    }
    dragRegion.style.left = `${Math.max(0, payload.x)}px`;
    dragRegion.style.top = `${Math.max(0, payload.y)}px`;
    dragRegion.style.width = `${payload.width}px`;
    dragRegion.style.height = `${payload.height}px`;
    dragRegion.hidden = false;
  }

  function findThreadRow(threadId) {
    const expected = normalizeThreadId(threadId);
    if (!expected) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => canonicalThreadId(row) === expected) || null;
  }

  function openNativeThread(threadId) {
    const row = findThreadRow(threadId);
    if (!row) return;
    closeDocuments(false);
    row.click();
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "documents:ready") {
      frameReady = true;
      if (readyTimer !== null) window.clearTimeout(readyTimer);
      readyTimer = null;
      if (active) showFrame();
      postHostContext();
      return;
    }
    if (message.type === "documents:drag-region") {
      updateDragRegion(message.payload);
      return;
    }
    if (message.type === "documents:open-thread") {
      openNativeThread(message.payload?.threadId);
      return;
    }
    if (message.type === "documents:expand-sidebar") expandNativeSidebar();
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "文档产物");

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_REGION_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED_ATTRIBUTE, "true");
    dragRegion.setAttribute("aria-hidden", "true");
    section.appendChild(dragRegion);
    return section;
  }

  function showLoading() {
    if (!status) return;
    status.replaceChildren(document.createTextNode("正在启动文档产物…"));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function showFrame() {
    if (status) status.hidden = true;
    if (frame) frame.hidden = false;
  }

  function showLoadError() {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = "文档服务暂时无法打开，请确认启动器仍在运行。";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新加载";
    retry.addEventListener("click", loadFrame, { once: true });
    content.append(text, retry);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function loadFrame() {
    if (readyTimer !== null) window.clearTimeout(readyTimer);
    readyTimer = null;
    frame?.remove();
    frame = null;
    frameReady = false;
    if (dragRegion) dragRegion.hidden = true;

    const url = resolveDocumentsUrl();
    frameOrigin = url.origin;
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.hidden = true;
    nextFrame.src = url.href;
    nextFrame.title = "文档产物";
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute("allow", "clipboard-write");
    nextFrame.addEventListener("load", postHostContext);
    frame = nextFrame;
    page.appendChild(nextFrame);
    showLoading();
    readyTimer = window.setTimeout(showLoadError, READY_TIMEOUT_MS);
  }

  function mountActivePage() {
    if (!active) return;
    if (!page) page = createPage();
    const mount = findPageMount();
    if (!mount) return;
    const { surface } = mount;
    if (page.parentElement !== surface) {
      restoreNativeContent();
      surface.appendChild(page);
    }
    surface.setAttribute(HOST_ATTRIBUTE, "true");
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
        child.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    });
    hideNativeHeader();
    muteNativeSelection();
    page.hidden = false;
    document.documentElement.setAttribute("data-codex-documents-open", "true");
  }

  function openDocuments() {
    if (destroyed) return;
    if (!active) lastFocusedElement = document.activeElement;
    active = true;
    ensureEntry();
    mountActivePage();
    entry?.setAttribute("aria-current", "page");
    if (!frame) loadFrame();
    else if (frameReady) showFrame();
    else showLoading();
    postHostContext();
  }

  function closeDocuments(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    active = false;
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeSelection();
    entry?.removeAttribute("aria-current");
    document.documentElement.removeAttribute("data-codex-documents-open");
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
  }

  function isNativePageNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!clickable || clickable === entry || clickable.closest(`#${ENTRY_ID}`)) return false;
    if (!clickable.closest("aside nav[role='navigation']")) return false;
    if (clickable.hasAttribute("data-app-action-sidebar-section-toggle")) return false;
    if (buttonMatches(clickable, NATIVE_PAGE_LABELS)) return true;
    return Boolean(clickable.closest(
      "[data-app-action-sidebar-thread-id],"
      + "[data-app-action-sidebar-project-row],"
      + "[data-app-action-sidebar-project-id]",
    ));
  }

  function onDocumentClick(event) {
    if (active && isNativePageNavigation(event.target)) closeDocuments(false);
  }

  function scheduleRefresh() {
    if (destroyed || refreshTimer !== null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      if (window.location.href !== lastLocation) {
        lastLocation = window.location.href;
        if (active) closeDocuments(false);
      }
      ensureEntry();
      mountActivePage();
      postHostContext();
    }, REATTACH_DELAY_MS);
  }

  function refresh() {
    ensureEntry();
    mountActivePage();
    postHostContext();
  }

  function reloadFrame() {
    if (!page) return false;
    loadFrame();
    return true;
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-color-theme", "aria-label", "aria-current"],
    });
    contextTimer = window.setInterval(() => {
      if (active) postHostContext();
    }, CONTEXT_SYNC_INTERVAL_MS);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    if (contextTimer !== null) window.clearInterval(contextTimer);
    if (readyTimer !== null) window.clearTimeout(readyTimer);
    refreshTimer = null;
    contextTimer = null;
    readyTimer = null;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("popstate", onNativeRouteChange);
    window.removeEventListener("hashchange", onNativeRouteChange);
    window.removeEventListener("resize", scheduleRefresh);
    closeDocuments(false);
    document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    entry = null;
    page = null;
    frame = null;
    status = null;
    dragRegion = null;
    frameOrigin = "";
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  function onNativeRouteChange() {
    lastLocation = window.location.href;
    if (active) closeDocuments(false);
  }

  const api = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    refresh,
    reloadFrame,
    open: openDocuments,
    close: closeDocuments,
    destroy,
  };
  window[SENTINEL_KEY] = api;

  window.addEventListener("message", onFrameMessage);
  window.addEventListener("popstate", onNativeRouteChange);
  window.addEventListener("hashchange", onNativeRouteChange);
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("click", onDocumentClick, true);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
