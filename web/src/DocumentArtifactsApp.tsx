import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "@daypicker/react/style.css";

import excelLogo from "./assets/document-logos/excel.png";
import feishuLogo from "./assets/document-logos/feishu.png";
import powerpointLogo from "./assets/document-logos/powerpoint.png";
import wecomLogo from "./assets/document-logos/wecom.png";
import wordLogo from "./assets/document-logos/word.png";
import { DateFilterPicker } from "./components/DateFilterPicker";
import { CustomDocumentLibraryDialog } from "./components/CustomDocumentLibraryDialog";
import {
  createDocumentLibrary,
  deleteDocumentLibrary,
  getLongTermMarkdownDocument,
  getMarkdownArtifactDocument,
  listDocumentLibraries,
  listDocumentArtifacts,
  openDocumentArtifact,
  openLongTermDocument,
  reorderDocumentLibraries,
  rescanDocumentArtifacts,
  updateDocumentLibrary,
  type CreateDocumentLibraryInput,
  type DocumentArtifact,
  type DocumentArtifactFilters,
  type DocumentCategory,
  type DocumentLibrary,
  type DocumentVersion,
  type LongTermMarkdownDocument,
} from "./documentArtifactsApi";
import "./document-artifacts.css";

type Theme = "light" | "dark";
type CategoryFilter = "all" | string;
type TimeField = "created" | "updated";
type RecentDays = 7 | 30 | 90;
type TimeRange =
  | { kind: "all" }
  | { kind: "recent"; days: RecentDays }
  | { kind: "custom"; startDate: string; endDate: string };

interface HostContext {
  theme?: Theme;
  sidebarCollapsed?: boolean;
  titlebarLeftInset?: number;
}

const DEFAULT_DOCUMENT_LIBRARIES: DocumentLibrary[] = [
  { id: "feishu", name: "飞书文档", kind: "builtin" },
  { id: "wecom", name: "企业微信文档", kind: "builtin" },
  { id: "office", name: "Office 文档", kind: "builtin" },
  { id: "markdown", name: "MD 文档", kind: "builtin" },
];

const BUILTIN_CATEGORY_IDS = new Set(["feishu", "wecom", "office", "markdown", "long_term"]);

const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  feishu: "飞书",
  wecom: "企业微信",
  office: "Office",
  markdown: "Markdown",
  file: "文件",
  memory: "Markdown",
};

const RECENT_TIME_RANGES: Array<{ days: RecentDays; label: string }> = [
  { days: 7, label: "最近 7 天" },
  { days: 30, label: "最近 30 天" },
  { days: 90, label: "最近 90 天" },
];

function initialTheme(): Theme {
  const queryTheme = new URLSearchParams(window.location.search).get("theme");
  if (queryTheme === "light" || queryTheme === "dark") return queryTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace("/", "-");
}

function formatShanghaiDate(date: Date): string {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function offsetDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function timeRangeDates(range: TimeRange): { startDate: string; endDate: string } {
  if (range.kind === "all") return { startDate: "", endDate: "" };
  if (range.kind === "custom") return range;
  const endDate = formatShanghaiDate(new Date());
  return { startDate: offsetDate(endDate, 1 - range.days), endDate };
}

function timeRangeLabel(range: TimeRange): string {
  if (range.kind === "all") return "全部时间";
  if (range.kind === "recent") return `最近 ${range.days} 天`;
  if (range.startDate && range.endDate) return `${range.startDate.slice(5).replace("-", "/")}–${range.endDate.slice(5).replace("-", "/")}`;
  if (range.startDate) return `${range.startDate.slice(5).replace("-", "/")} 之后`;
  if (range.endDate) return `${range.endDate.slice(5).replace("-", "/")} 之前`;
  return "自定义时间";
}

function officeLabel(artifact: DocumentArtifact): string | null {
  if (artifact.officeType === "word") return "Word";
  if (artifact.officeType === "excel") return "Excel";
  if (artifact.officeType === "powerpoint") return "PPT";
  return null;
}

function documentLogo(artifact: DocumentArtifact, library?: DocumentLibrary): string | null {
  if (library?.kind === "custom" && library.logoDataUrl) return library.logoDataUrl;
  if (artifact.category === "feishu") return feishuLogo;
  if (artifact.category === "wecom") return wecomLogo;
  if (artifact.officeType === "word") return wordLogo;
  if (artifact.officeType === "excel") return excelLogo;
  if (artifact.officeType === "powerpoint") return powerpointLogo;
  return null;
}

function documentGlyph(artifact: DocumentArtifact): string {
  if (artifact.officeType === "word") return "W";
  if (artifact.officeType === "excel") return "X";
  if (artifact.officeType === "powerpoint") return "P";
  if (artifact.category === "feishu") return "飞";
  if (artifact.category === "wecom") return "企";
  if (["memory", "markdown"].includes(artifact.category)) return "M↓";
  if (artifact.category === "file") return "▧";
  return "▤";
}

function versionStatus(version: DocumentVersion): string {
  if (version.snapshotStatus === "available") return "已保存只读快照";
  if (version.snapshotStatus === "unavailable_historical") {
    return version.isLatest
      ? "当前文件可打开；同路径反复修改时不留快照"
      : "同路径反复修改，未保留历史快照";
  }
  if (version.snapshotStatus === "missing") return "原文件当前不可用";
  return "旧内容请在平台版本历史中查看";
}

function hasHistoricalVersions(artifact: DocumentArtifact): boolean {
  return artifact.versions.some((version) => (
    !version.isLatest
    && version.snapshotStatus === "available"
    && version.openable
  ));
}

function deliveryStatus(artifact: DocumentArtifact, version: DocumentVersion): string {
  if (["feishu", "wecom"].includes(artifact.category)) {
    return "仅记录本次交付；打开后显示平台当前内容";
  }
  if (version.snapshotStatus === "missing") return "原文件当前不可用";
  return version.isLatest
    ? "当前文件可打开；此前交付内容未单独保存"
    : "仅记录本次交付；当时内容未单独保存";
}

export function DocumentArtifactsApp() {
  const embedded = new URLSearchParams(window.location.search).get("host") === "codex";
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [libraries, setLibraries] = useState<DocumentLibrary[]>(DEFAULT_DOCUMENT_LIBRARIES);
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [editingLibrary, setEditingLibrary] = useState<DocumentLibrary | null>(null);
  const [libraryMenu, setLibraryMenu] = useState<{ library: DocumentLibrary; x: number; y: number } | null>(null);
  const [draggedLibraryId, setDraggedLibraryId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [timeField, setTimeField] = useState<TimeField>("updated");
  const [timeRange, setTimeRange] = useState<TimeRange>({ kind: "all" });
  const [timeMenuOpen, setTimeMenuOpen] = useState(false);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [items, setItems] = useState<DocumentArtifact[]>([]);
  const [filters, setFilters] = useState<DocumentArtifactFilters>({ projects: [], tasks: [] });
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [reader, setReader] = useState<LongTermMarkdownDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const timeFilterRef = useRef<HTMLDivElement>(null);
  const timeFilterTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);
  const loadSequence = useRef(0);
  const { startDate, endDate } = timeRangeDates(timeRange);
  const activeLibrary = libraries.find((library) => library.id === category);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
  }, [embedded, theme]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== "documents:host-context") return;
      const payload = event.data.payload as HostContext;
      setHostContext(payload);
      if (payload.theme === "light" || payload.theme === "dark") setTheme(payload.theme);
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "documents:ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, [embedded]);

  useEffect(() => {
    if (!libraryMenu) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!libraryMenuRef.current?.contains(event.target as Node)) setLibraryMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLibraryMenu(null);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [libraryMenu]);

  useEffect(() => {
    if (!timeMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!timeFilterRef.current?.contains(event.target as Node)) {
        setTimeMenuOpen(false);
        setCustomRangeOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (customRangeOpen) setCustomRangeOpen(false);
      else setTimeMenuOpen(false);
      window.requestAnimationFrame(() => timeFilterTriggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", closeOnOutsideClick, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [customRangeOpen, timeMenuOpen]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      window.parent.postMessage({
        type: "documents:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }, "*");
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      window.parent.postMessage({ type: "documents:drag-region", payload: null }, "*");
    };
  }, [embedded]);

  const load = useCallback(async (cursor: string | null = null, append = false) => {
    const sequence = ++loadSequence.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const selectedLibrary = libraries.find((library) => library.id === category);
      const builtinCategory = BUILTIN_CATEGORY_IDS.has(category)
        ? category as "long_term" | Exclude<DocumentCategory, "memory">
        : "all";
      const page = await listDocumentArtifacts({
        category: builtinCategory,
        libraryId: selectedLibrary?.kind === "custom" ? selectedLibrary.id : undefined,
        projectId,
        search: debouncedSearch,
        timeField,
        startDate,
        endDate,
        cursor,
      });
      if (sequence !== loadSequence.current) return;
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setFilters(page.filters);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (sequence === loadSequence.current) {
        setError(loadError instanceof Error ? loadError.message : "文档产物加载失败");
      }
    } finally {
      if (sequence === loadSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [category, debouncedSearch, endDate, libraries, projectId, startDate, timeField]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    const loadLibraries = async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const nextLibraries = await listDocumentLibraries();
          if (!cancelled) setLibraries(nextLibraries);
          return;
        } catch {
          if (attempt < 2 && !cancelled) {
            await new Promise((resolve) => window.setTimeout(resolve, 150 * (attempt + 1)));
          }
        }
      }
    };
    void loadLibraries();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");
    let connectedOnce = false;
    const refresh = () => void load();
    const reloadAfterReconnect = () => {
      if (connectedOnce) refresh();
      connectedOnce = true;
    };
    source.addEventListener("open", reloadAfterReconnect);
    source.addEventListener("document.updated", refresh);
    return () => {
      source.removeEventListener("open", reloadAfterReconnect);
      source.removeEventListener("document.updated", refresh);
      source.close();
    };
  }, [load]);

  const hasFilters = category !== "all" || projectId || search || timeRange.kind !== "all";

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await rescanDocumentArtifacts();
      await load();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }

  async function openArtifact(artifact: DocumentArtifact, version?: DocumentVersion) {
    const key = version?.id ?? artifact.id;
    setOpeningId(key);
    setError(null);
    try {
      if (artifact.longTerm?.kind === "memory") {
        setReader(await getLongTermMarkdownDocument(artifact.longTerm.id));
      } else if (artifact.category === "markdown" && !version) {
        setReader(await getMarkdownArtifactDocument(artifact.id));
      } else if (artifact.longTerm?.kind === "automation" && !version) {
        await openLongTermDocument(artifact.longTerm.id);
      } else {
        await openDocumentArtifact(artifact.id, version?.id);
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "无法打开这个文档");
    } finally {
      setOpeningId(null);
    }
  }

  async function copyArtifactLink(artifact: DocumentArtifact) {
    setError(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(artifact.locator);
      } else {
        const input = document.createElement("textarea");
        input.value = artifact.locator;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("浏览器没有允许复制到剪贴板");
      }
      setCopiedId(artifact.id);
      window.setTimeout(() => {
        setCopiedId((current) => current === artifact.id ? null : current);
      }, 1_600);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制文档链接失败");
    }
  }

  function closeReader() {
    setReader(null);
    setError(null);
  }

  function openThread(threadId: string, anchorText = "") {
    if (!threadId) return;
    if (embedded && window.parent !== window) {
      window.parent.postMessage({
        type: "documents:open-thread",
        payload: { threadId, anchorText },
      }, "*");
      return;
    }
    window.location.assign(`codex://threads/${encodeURIComponent(threadId.trim())}`);
  }

  function clearFilters() {
    setCategory("all");
    setProjectId("");
    setSearch("");
    setTimeField("updated");
    setTimeRange({ kind: "all" });
    setCustomStartDate("");
    setCustomEndDate("");
    setTimeMenuOpen(false);
    setCustomRangeOpen(false);
  }

  function chooseTimeRange(range: TimeRange) {
    setTimeRange(range);
    setTimeMenuOpen(false);
    setCustomRangeOpen(false);
  }

  function openCustomRange() {
    if (!customRangeOpen) {
      const current = timeRange.kind === "custom" ? timeRange : { startDate: "", endDate: "" };
      setCustomStartDate(current.startDate);
      setCustomEndDate(current.endDate);
    }
    setCustomRangeOpen((current) => !current);
  }

  function applyCustomRange() {
    chooseTimeRange({ kind: "custom", startDate: customStartDate, endDate: customEndDate });
  }

  function toggleHistory(artifactId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(artifactId)) next.delete(artifactId);
      else next.add(artifactId);
      return next;
    });
  }

  async function createLibrary(input: CreateDocumentLibraryInput) {
    const created = await createDocumentLibrary(input);
    const nextLibraries = await listDocumentLibraries();
    setLibraries(nextLibraries);
    setCategory(created.id);
  }

  async function updateLibrary(id: string, input: CreateDocumentLibraryInput) {
    const updated = await updateDocumentLibrary(id, input);
    setLibraries(await listDocumentLibraries());
    setCategory(updated.id);
  }

  async function deleteLibrary(library: DocumentLibrary) {
    setLibraryMenu(null);
    if (!window.confirm(`确定删除“${library.name}”模块吗？文档本身不会被删除。`)) return;
    try {
      await deleteDocumentLibrary(library.id);
      setLibraries(await listDocumentLibraries());
      if (category === library.id) setCategory("all");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "文档库删除失败");
    }
  }

  function openLibraryEditor(library: DocumentLibrary) {
    setLibraryMenu(null);
    setEditingLibrary(library);
    setLibraryDialogOpen(true);
  }

  function closeLibraryDialog() {
    setLibraryDialogOpen(false);
    setEditingLibrary(null);
  }

  async function moveLibrary(targetId: string) {
    if (!draggedLibraryId || draggedLibraryId === targetId) return;
    const fromIndex = libraries.findIndex((library) => library.id === draggedLibraryId);
    const targetIndex = libraries.findIndex((library) => library.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;
    const previous = libraries;
    const next = [...libraries];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(targetIndex, 0, moved);
    setLibraries(next);
    setDraggedLibraryId(null);
    try {
      setLibraries(await reorderDocumentLibraries(next.map((library) => library.id)));
    } catch (reorderError) {
      setLibraries(previous);
      setError(reorderError instanceof Error ? reorderError.message : "文档库顺序保存失败");
    }
  }

  const shellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <div className={`documents-shell${embedded ? " embedded" : ""}${reader ? " reader-open" : ""}`} style={shellStyle}>
      <CustomDocumentLibraryDialog
        open={libraryDialogOpen}
        library={editingLibrary}
        onClose={closeLibraryDialog}
        onCreate={createLibrary}
        onUpdate={updateLibrary}
      />
      <header className="documents-header">
        <div className="documents-title-row">
          {embedded && hostContext?.sidebarCollapsed && (
            <button
              className="documents-icon-button"
              type="button"
              aria-label="展开 Codex 侧边栏"
              title="展开侧边栏"
              onClick={() => window.parent.postMessage({ type: "documents:expand-sidebar" }, "*")}
            >☰</button>
          )}
          <span className="documents-title-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M6 3.5h8.5L19 8v12.5H6z" />
              <path d="M14.5 3.5V8H19M9 12h7M9 15.5h7" />
            </svg>
          </span>
          <div>
            <h1>文档产物</h1>
            <p>{reader
              ? reader.filename
              : total > 0
                ? category === "long_term"
                  ? `共 ${total} 个长期文档`
                  : activeLibrary?.kind === "custom"
                    ? `${activeLibrary.name} · 共 ${total} 个产物`
                    : `共 ${total} 个产物，按 Codex 交付时间排序`
                : "汇总 Codex 交付的文档"}</p>
          </div>
        </div>
        <div ref={dragRegionRef} className="documents-drag-region" aria-hidden="true" />
        <button
          className="documents-refresh"
          type="button"
          disabled={refreshing}
          onClick={() => void refresh()}
        >{refreshing ? "正在刷新…" : "刷新"}</button>
      </header>

      {reader ? (
        <main className="documents-reader">
          <div className="documents-reader-bar">
            <button type="button" onClick={closeReader}>← 返回文档列表</button>
            <span>{reader.filename} · 更新于 {formatTime(reader.updatedAt)}</span>
          </div>
          {error && <div className="documents-error" role="alert">{error}</div>}
          <article className="documents-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noreferrer">{children}</a>
                ),
              }}
            >{reader.content}</ReactMarkdown>
          </article>
        </main>
      ) : (
        <>
      <section className="documents-toolbar" aria-label="文档筛选">
        <div className="documents-category-bar">
          <div className="documents-category-tabs" role="tablist" aria-label="文档类别">
            <button
              type="button"
              role="tab"
              aria-selected={category === "all"}
              className={category === "all" ? "active" : ""}
              onClick={() => setCategory("all")}
            >
              全部
            </button>
            {libraries.map((library) => (
              <button
                key={library.id}
                type="button"
                role="tab"
                draggable
                aria-selected={category === library.id}
                className={`${category === library.id ? "active" : ""}${draggedLibraryId === library.id ? " dragging" : ""}`}
                title={library.kind === "custom" ? "拖拽调整顺序；右击编辑或删除" : "拖拽调整文档库顺序"}
                onClick={() => setCategory(library.id)}
                onDragStart={(event) => {
                  setDraggedLibraryId(library.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", library.id);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  void moveLibrary(library.id);
                }}
                onDragEnd={() => setDraggedLibraryId(null)}
                onContextMenu={(event) => {
                  if (library.kind !== "custom") return;
                  event.preventDefault();
                  setDraggedLibraryId(null);
                  setLibraryMenu({
                    library,
                    x: Math.min(event.clientX, window.innerWidth - 176),
                    y: Math.min(event.clientY, window.innerHeight - 96),
                  });
                }}
              >
                {library.logoDataUrl && <img className="document-library-tab-logo" src={library.logoDataUrl} alt="" aria-hidden="true" />}
                {library.icon && <span className="long-term-star" aria-hidden="true">{library.icon}</span>}
                {library.name}
              </button>
            ))}
          </div>
          <button className="documents-add-library" type="button" onClick={() => setLibraryDialogOpen(true)}>
            <span aria-hidden="true">＋</span> 增加自定义文档库
          </button>
        </div>
        <div className="documents-filter-row">
          <label>
            <span>项目</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">全部项目</option>
              {filters.projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label className="documents-title-search">
            <span>搜索</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索任务名或文件名…"
            />
          </label>
          <div className="documents-time-filter" ref={timeFilterRef}>
            <span>筛选时间</span>
            <button
              ref={timeFilterTriggerRef}
              className="documents-time-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={timeMenuOpen}
              onClick={() => {
                setTimeMenuOpen((current) => !current);
                setCustomRangeOpen(false);
              }}
            >
              <span>{timeRangeLabel(timeRange)}</span>
              <span aria-hidden="true">⌄</span>
            </button>
            {timeMenuOpen && (
              <div className="documents-time-menu" role="menu" aria-label="时间筛选选项">
                <div className="documents-time-menu-section">
                  <span>筛选依据</span>
                  <div className="documents-time-field-options" role="group" aria-label="筛选时间依据">
                    <button
                      className={timeField === "updated" ? "active" : ""}
                      type="button"
                      onClick={() => setTimeField("updated")}
                    >最新编辑</button>
                    <button
                      className={timeField === "created" ? "active" : ""}
                      type="button"
                      onClick={() => setTimeField("created")}
                    >创建时间</button>
                  </div>
                </div>
                <div className="documents-time-menu-divider" />
                <button
                  className={`documents-time-menu-item${timeRange.kind === "all" ? " active" : ""}`}
                  type="button"
                  role="menuitem"
                  onClick={() => chooseTimeRange({ kind: "all" })}
                >全部时间</button>
                {RECENT_TIME_RANGES.map((option) => (
                  <button
                    key={option.days}
                    className={`documents-time-menu-item${timeRange.kind === "recent" && timeRange.days === option.days ? " active" : ""}`}
                    type="button"
                    role="menuitem"
                    onClick={() => chooseTimeRange({ kind: "recent", days: option.days })}
                  >{option.label}</button>
                ))}
                <div className="documents-custom-range">
                  <button
                    className={`documents-time-menu-item documents-time-menu-submenu${timeRange.kind === "custom" ? " active" : ""}`}
                    type="button"
                    role="menuitem"
                    aria-expanded={customRangeOpen}
                    onClick={openCustomRange}
                  ><span>自定义时间</span><span aria-hidden="true">›</span></button>
                  {customRangeOpen && (
                    <section className="documents-custom-range-menu" aria-label="自定义时间范围">
                      <div className="documents-custom-range-heading">
                        <strong>自定义时间</strong>
                        <span>按{timeField === "updated" ? "最新编辑时间" : "创建时间"}筛选</span>
                      </div>
                      <div className="documents-custom-range-inputs">
                        <label>
                          <span>开始日期</span>
                          <DateFilterPicker
                            align="start"
                            label="开始日期"
                            value={customStartDate}
                            max={customEndDate || undefined}
                            onChange={setCustomStartDate}
                          />
                        </label>
                        <span className="documents-custom-range-separator" aria-hidden="true">至</span>
                        <label>
                          <span>结束日期</span>
                          <DateFilterPicker
                            align="end"
                            label="结束日期"
                            value={customEndDate}
                            min={customStartDate || undefined}
                            onChange={setCustomEndDate}
                          />
                        </label>
                      </div>
                      <div className="documents-custom-range-actions">
                        <button type="button" onClick={() => chooseTimeRange({ kind: "all" })}>清除</button>
                        <button type="button" className="primary" onClick={applyCustomRange}>应用</button>
                      </div>
                    </section>
                  )}
                </div>
              </div>
            )}
          </div>
          {hasFilters && <button className="documents-clear" type="button" onClick={clearFilters}>清除筛选</button>}
        </div>
      </section>

      {libraryMenu && (
        <div
          className="document-library-context-menu"
          ref={libraryMenuRef}
          role="menu"
          aria-label={`${libraryMenu.library.name} 操作`}
          style={{ left: libraryMenu.x, top: libraryMenu.y }}
        >
          <button type="button" role="menuitem" onClick={() => openLibraryEditor(libraryMenu.library)}>
            编辑模块与规则
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={() => void deleteLibrary(libraryMenu.library)}
          >
            删除模块
          </button>
        </div>
      )}

      {error && <div className="documents-error" role="alert">{error}</div>}

      <main className="documents-content">
        {loading && items.length === 0 ? (
          <div className="documents-loading" aria-busy="true"><i /><i /><i /></div>
        ) : items.length === 0 ? (
          <section className="documents-empty">
            <span aria-hidden="true">▤</span>
            <h2>{hasFilters ? "没有匹配的文档产物" : "暂未发现文档产物"}</h2>
            <p>{hasFilters ? "请调整项目或搜索关键词。" : "点击刷新，扫描本机保留的全部 Codex 历史最终交付。"}</p>
            {hasFilters && <button type="button" onClick={clearFilters}>清除筛选</button>}
          </section>
        ) : (
          <div className="documents-list">
            {items.map((artifact) => {
              const expanded = expandedIds.has(artifact.id);
              const hasVersionHistory = hasHistoricalVersions(artifact);
              const subtype = officeLabel(artifact);
              const logo = documentLogo(artifact, activeLibrary);
              return (
                <article className="document-card" key={artifact.id}>
                  <div className="document-card-main">
                    <button
                      className={`document-kind kind-${artifact.category}${logo ? " has-brand-logo" : ""}`}
                      type="button"
                      title={["memory", "markdown"].includes(artifact.category) ? "查看当前文档" : "打开当前文档"}
                      aria-label={`打开 ${artifact.title}`}
                      onClick={() => void openArtifact(artifact)}
                    >
                      {logo
                        ? <img src={logo} alt="" aria-hidden="true" draggable="false" />
                        : <span aria-hidden="true">{documentGlyph(artifact)}</span>}
                    </button>
                    <div className="document-card-copy">
                      <button className="document-title" type="button" onClick={() => void openArtifact(artifact)}>
                        {artifact.title}
                      </button>
                      <div className="document-meta">
                        <span>{activeLibrary?.kind === "custom" ? activeLibrary.name : CATEGORY_LABELS[artifact.category]}</span>
                        {subtype && <span className={`office-badge office-${artifact.officeType}`}>{subtype}</span>}
                        <span>更新于 {formatTime(artifact.updatedAt)}</span>
                      </div>
                      <div className="document-tags">
                        {artifact.tags.slice(0, 4).map((tag) => (
                          <span key={`${tag.projectId}:${tag.taskName}`} title={`${tag.projectName} · ${tag.taskName}`}>
                            <b>{tag.projectName}</b>
                            <button
                              type="button"
                              disabled={!tag.threadId}
                              onClick={() => openThread(tag.threadId, tag.deliveryContext)}
                            >{tag.taskName}</button>
                          </span>
                        ))}
                        {artifact.tags.length > 4 && <em>+{artifact.tags.length - 4}</em>}
                      </div>
                    </div>
                    <div className="document-card-actions">
                      <div className="document-primary-actions">
                        <button
                          className="document-copy-link"
                          type="button"
                          title={copiedId === artifact.id ? "已复制" : "复制文档链接"}
                          aria-label={copiedId === artifact.id ? `已复制 ${artifact.title} 的链接` : `复制 ${artifact.title} 的链接`}
                          onClick={() => void copyArtifactLink(artifact)}
                        >{copiedId === artifact.id ? "已复制 ✓" : "复制链接🔗"}</button>
                        <button
                          type="button"
                          disabled={openingId === artifact.id}
                          onClick={() => void openArtifact(artifact)}
                        >{openingId === artifact.id ? "正在打开…" : ["memory", "markdown"].includes(artifact.category) ? "查看" : "打开"}</button>
                      </div>
                      {artifact.versionCount > 1 && (
                        <button
                          className="document-history-toggle"
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => toggleHistory(artifact.id)}
                        >{artifact.versionCount} {hasVersionHistory ? "个版本" : "次交付"} <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span></button>
                      )}
                    </div>
                  </div>
                  {expanded && (
                    <div className="document-history">
                      {artifact.versions.map((version, index) => (
                        <div className="document-version" key={version.id}>
                          <div className="version-line" aria-hidden="true"><i />{index < artifact.versions.length - 1 && <span />}</div>
                          <div className="version-copy">
                            <div>
                              <strong>{version.isLatest ? (hasVersionHistory ? "最新版本" : "最近交付") : formatTime(version.deliveredAt)}</strong>
                              {version.isLatest && <time>{formatTime(version.deliveredAt)}</time>}
                            </div>
                            <button
                              className="version-context"
                              type="button"
                              onClick={() => openThread(version.threadId, version.deliveryContext)}
                            >
                              {version.deliveryContext || "Codex 在这次最终交付中登记了该产物。"}
                            </button>
                            <div className="version-source" title={`${version.projectName} · ${version.taskName}`}>
                              项目：{version.projectName}
                            </div>
                            <small className={`snapshot-${version.snapshotStatus}`}>
                              {hasVersionHistory ? versionStatus(version) : deliveryStatus(artifact, version)}
                            </small>
                          </div>
                          {hasVersionHistory && (
                            <button
                              type="button"
                              disabled={!version.openable || openingId === version.id}
                              onClick={() => void openArtifact(artifact, version)}
                            >{version.openable ? (openingId === version.id ? "正在打开…" : "打开此版本") : "不可打开"}</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
            {nextCursor && (
              <button
                className="documents-load-more"
                type="button"
                disabled={loadingMore}
                onClick={() => void load(nextCursor, true)}
              >{loadingMore ? "正在加载…" : `加载更多（已显示 ${items.length}/${total}）`}</button>
            )}
          </div>
        )}
      </main>
        </>
      )}
    </div>
  );
}
