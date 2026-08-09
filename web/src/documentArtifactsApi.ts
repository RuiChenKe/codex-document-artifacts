export type DocumentCategory = "feishu" | "wecom" | "office" | "markdown" | "file" | "memory";
export type OfficeType = "word" | "excel" | "powerpoint" | null;
export type SnapshotStatus = "available" | "unavailable_historical" | "missing" | "platform_history";

export interface DocumentTag {
  projectId: string;
  projectName: string;
  taskName: string;
  threadId: string;
  deliveryContext: string;
  deliveredAt: string;
}

export interface DocumentVersion {
  id: string;
  threadId: string;
  projectId: string;
  projectName: string;
  taskName: string;
  title: string;
  locator: string;
  deliveryContext: string;
  deliveredAt: string;
  snapshotStatus: SnapshotStatus;
  openable: boolean;
  isLatest: boolean;
}

export interface DocumentArtifact {
  id: string;
  category: DocumentCategory;
  officeType: OfficeType;
  title: string;
  locator: string;
  fileSize: number | null;
  createdAt: string;
  updatedAt: string;
  tags: DocumentTag[];
  versions: DocumentVersion[];
  versionCount: number;
  longTerm?: {
    id: string;
    kind: "memory" | "automation";
    automationNames?: string[];
  };
}

export type DocumentLibraryRuleField = "title" | "body" | "updatedAt" | "createdAt" | "fileSize";
export type DocumentLibraryRuleOperator =
  | "contains" | "not_contains" | "equals"
  | "after" | "before"
  | "greater_than" | "less_than";

export interface DocumentLibraryRule {
  field: DocumentLibraryRuleField;
  operator: DocumentLibraryRuleOperator;
  value: string;
}

export interface DocumentLibrary {
  id: string;
  name: string;
  kind: "builtin" | "custom";
  icon?: string;
  logoDataUrl?: string | null;
  matchType?: "domain" | "rules" | "extension";
  domainContains?: string;
  extensions?: string[];
  matchMode?: "all" | "any";
  rules?: DocumentLibraryRule[];
}

export interface CreateDocumentLibraryInput {
  name: string;
  logoDataUrl: string | null;
  matchType: "domain" | "rules" | "extension";
  domainContains: string;
  extensions: string[];
  matchMode: "all" | "any";
  rules: DocumentLibraryRule[];
}

export interface LongTermMarkdownDocument {
  id: string;
  title: string;
  filename: string;
  updatedAt: string;
  content: string;
  language?: "zh-CN";
}

export interface DocumentArtifactFilters {
  projects: Array<{ id: string; name: string }>;
  tasks: string[];
}

export interface DocumentArtifactPage {
  items: DocumentArtifact[];
  nextCursor: string | null;
  total: number;
  filters: DocumentArtifactFilters;
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [200, 600, 1_200];
const TRANSIENT_HTTP_STATUS_CODES = new Set([500, 502, 503, 504]);

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const retryable = method === "GET" || method === "HEAD";
  let response: Response;
  let retryIndex = 0;
  while (true) {
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...init?.headers,
        },
      });
      if (
        retryable
        && TRANSIENT_HTTP_STATUS_CODES.has(response.status)
        && TRANSIENT_FETCH_RETRY_DELAYS_MS[retryIndex] !== undefined
      ) {
        const delayMs = TRANSIENT_FETCH_RETRY_DELAYS_MS[retryIndex];
        retryIndex += 1;
        await response.body?.cancel().catch(() => undefined);
        await waitForRetry(delayMs, init?.signal ?? undefined);
        continue;
      }
      break;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const delayMs = TRANSIENT_FETCH_RETRY_DELAYS_MS[retryIndex];
      if (!retryable || delayMs === undefined) {
        throw new Error("文档服务暂时不可用，请稍后重试");
      }
      retryIndex += 1;
      await waitForRetry(delayMs, init?.signal ?? undefined);
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listDocumentArtifacts(input: {
  category: "all" | "long_term" | Exclude<DocumentCategory, "memory">;
  libraryId?: string;
  projectId: string;
  search: string;
  timeField: "created" | "updated";
  startDate: string;
  endDate: string;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<DocumentArtifactPage> {
  const query = new URLSearchParams();
  if (input.category !== "all") query.set("category", input.category);
  if (input.libraryId) query.set("libraryId", input.libraryId);
  if (input.projectId) query.set("projectId", input.projectId);
  if (input.search) query.set("query", input.search);
  if (input.timeField !== "updated") query.set("timeField", input.timeField);
  if (input.startDate) query.set("startDate", input.startDate);
  if (input.endDate) query.set("endDate", input.endDate);
  if (input.cursor) query.set("cursor", input.cursor);
  query.set("limit", String(input.limit ?? 50));
  return request<DocumentArtifactPage>(`/api/local/document-artifacts?${query}`, {
    signal: input.signal,
  });
}

export async function listDocumentLibraries(): Promise<DocumentLibrary[]> {
  const payload = await request<{ libraries: DocumentLibrary[] }>("/api/local/document-libraries");
  return payload.libraries;
}

export async function createDocumentLibrary(input: CreateDocumentLibraryInput): Promise<DocumentLibrary> {
  const payload = await request<{ library: DocumentLibrary }>("/api/local/document-libraries", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.library;
}

export async function updateDocumentLibrary(
  id: string,
  input: CreateDocumentLibraryInput,
): Promise<DocumentLibrary> {
  const payload = await request<{ library: DocumentLibrary }>(
    `/api/local/document-libraries/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
  return payload.library;
}

export async function deleteDocumentLibrary(id: string): Promise<void> {
  await request(`/api/local/document-libraries/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: "{}",
  });
}

export async function reorderDocumentLibraries(ids: string[]): Promise<DocumentLibrary[]> {
  const payload = await request<{ libraries: DocumentLibrary[] }>("/api/local/document-libraries/order", {
    method: "PUT",
    body: JSON.stringify({ ids }),
  });
  return payload.libraries;
}

export async function rescanDocumentArtifacts(): Promise<{ created: number; scannedThreads: number }> {
  return request("/api/local/document-artifacts/rescan", {
    method: "POST",
    body: "{}",
  });
}

export async function openDocumentArtifact(artifactId: string, versionId?: string): Promise<void> {
  await request(`/api/local/document-artifacts/${encodeURIComponent(artifactId)}/open`, {
    method: "POST",
    body: JSON.stringify(versionId ? { versionId } : {}),
  });
}

export async function getLongTermMarkdownDocument(id: string): Promise<LongTermMarkdownDocument> {
  const payload = await request<{ document: LongTermMarkdownDocument }>(
    `/api/local/long-term-documents/${encodeURIComponent(id)}`,
  );
  return payload.document;
}

export async function getMarkdownArtifactDocument(id: string): Promise<LongTermMarkdownDocument> {
  const payload = await request<{ document: LongTermMarkdownDocument }>(
    `/api/local/document-artifacts/${encodeURIComponent(id)}/content`,
  );
  return payload.document;
}

export async function openLongTermDocument(id: string): Promise<void> {
  await request(`/api/local/long-term-documents/${encodeURIComponent(id)}/open`, {
    method: "POST",
    body: "{}",
  });
}
