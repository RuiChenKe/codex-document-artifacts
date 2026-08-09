import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  CreateDocumentLibraryInput,
  DocumentLibrary,
  DocumentLibraryRule,
  DocumentLibraryRuleField,
  DocumentLibraryRuleOperator,
} from "../documentArtifactsApi";

interface DraftRule extends DocumentLibraryRule {
  id: string;
}

interface CustomDocumentLibraryDialogProps {
  open: boolean;
  library?: DocumentLibrary | null;
  onClose: () => void;
  onCreate: (input: CreateDocumentLibraryInput) => Promise<void>;
  onUpdate: (id: string, input: CreateDocumentLibraryInput) => Promise<void>;
}

const FIELD_OPTIONS: Array<{ value: DocumentLibraryRuleField; label: string }> = [
  { value: "title", label: "文档标题" },
  { value: "body", label: "文档正文" },
  { value: "updatedAt", label: "最新编辑时间" },
  { value: "createdAt", label: "创建时间" },
  { value: "fileSize", label: "文件大小" },
];

const TEXT_OPERATORS: Array<{ value: DocumentLibraryRuleOperator; label: string }> = [
  { value: "contains", label: "包含" },
  { value: "not_contains", label: "不包含" },
  { value: "equals", label: "等于" },
];

function operatorsFor(field: DocumentLibraryRuleField) {
  if (field === "createdAt" || field === "updatedAt") {
    return [
      { value: "after" as const, label: "晚于或等于" },
      { value: "before" as const, label: "早于" },
    ];
  }
  if (field === "fileSize") {
    return [
      { value: "greater_than" as const, label: "大于" },
      { value: "less_than" as const, label: "小于" },
    ];
  }
  return TEXT_OPERATORS;
}

function initialRule(): DraftRule {
  return { id: crypto.randomUUID(), field: "title", operator: "contains", value: "" };
}

export function CustomDocumentLibraryDialog({
  open,
  library = null,
  onClose,
  onCreate,
  onUpdate,
}: CustomDocumentLibraryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [matchType, setMatchType] = useState<"domain" | "rules" | "extension">("domain");
  const [domainContains, setDomainContains] = useState("");
  const [extensionsText, setExtensionsText] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [matchMode, setMatchMode] = useState<"all" | "any">("all");
  const [rules, setRules] = useState<DraftRule[]>([initialRule()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setName(library?.name ?? "");
    setMatchType(library?.matchType ?? "domain");
    setDomainContains(library?.domainContains ?? "");
    setExtensionsText(library?.extensions?.join(", ") ?? "");
    setLogoDataUrl(library?.logoDataUrl ?? null);
    setMatchMode(library?.matchMode ?? "all");
    setRules(library?.rules?.length
      ? library.rules.map((rule) => ({ ...rule, id: crypto.randomUUID() }))
      : [initialRule()]);
    setError(null);
  }, [library, open]);

  function updateRule(id: string, patch: Partial<DraftRule>) {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...patch } : rule));
  }

  function changeRuleField(rule: DraftRule, field: DocumentLibraryRuleField) {
    const operator = operatorsFor(field)[0].value;
    updateRule(rule.id, { field, operator, value: "" });
  }

  async function chooseLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError("Logo 仅支持 PNG、JPEG 或 WebP 格式");
      return;
    }
    if (file.size > 256 * 1024) {
      setError("Logo 文件不能超过 256 KB");
      return;
    }
    const value = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    }).catch(() => "");
    if (!value) setError("Logo 读取失败，请重新选择");
    else setLogoDataUrl(value);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input = {
        name: name.trim(),
        logoDataUrl,
        matchType,
        domainContains: domainContains.trim(),
        extensions: matchType === "extension"
          ? extensionsText.split(/[，,\s]+/u).map((extension) => extension.replace(/^\./u, "").trim()).filter(Boolean)
          : [],
        matchMode,
        rules: matchType === "rules"
          ? rules.map(({ id: _id, ...rule }) => rule)
          : [],
      };
      if (library) await onUpdate(library.id, input);
      else await onCreate(input);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "文档库保存失败");
    } finally {
      setSaving(false);
    }
  }

  const valid = name.trim()
    && (matchType === "domain"
      ? domainContains.trim()
      : matchType === "extension"
        ? extensionsText.split(/[，,\s]+/u).some((extension) => extension.replace(/^\./u, "").trim())
        : rules.every((rule) => rule.value.trim()));

  return (
    <dialog
      ref={dialogRef}
      className="document-library-dialog"
      aria-labelledby="document-library-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && !saving) onClose();
      }}
    >
      <form method="dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <div>
            <h2 id="document-library-dialog-title">{library ? "编辑自定义文档库" : "增加自定义文档库"}</h2>
            <p>{library ? "修改名称、Logo 或归类规则后会立即重新汇总。" : "把符合条件的文档自动归入一个独立板块。"}</p>
          </div>
          <button type="button" aria-label="关闭" disabled={saving} onClick={onClose}>×</button>
        </header>

        <div className="document-library-basics">
          <label className="document-library-name">
            <span>文档库名称</span>
            <input
              autoFocus
              required
              maxLength={30}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：团队知识库"
            />
          </label>
          <label className="document-library-logo-picker">
            <span>文档库 Logo</span>
            <span className="document-library-logo-control">
              <span className="document-library-logo-preview" aria-hidden="true">
                {logoDataUrl ? <img src={logoDataUrl} alt="" /> : (name.trim().slice(0, 1) || "文")}
              </span>
              <span>{logoDataUrl ? "更换 Logo" : "上传 Logo"}<small>PNG / JPEG / WebP，最大 256 KB</small></span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => void chooseLogo(event.target.files?.[0])}
              />
            </span>
          </label>
        </div>

        <section className="document-library-match-section">
          <div className="document-library-section-heading">
            <strong>归类方式</strong>
            <span>选择一种规则，后续新增文档也会自动归类</span>
          </div>
          <div className="document-library-methods" role="radiogroup" aria-label="归类方式">
            <button
              type="button"
              role="radio"
              aria-checked={matchType === "domain"}
              className={matchType === "domain" ? "active" : ""}
              onClick={() => setMatchType("domain")}
            >
              <span aria-hidden="true">⌁</span>
              <strong>按文档域名</strong>
              <small>域名中包含指定文字时归入此板块</small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={matchType === "rules"}
              className={matchType === "rules" ? "active" : ""}
              onClick={() => setMatchType("rules")}
            >
              <span aria-hidden="true">⌘</span>
              <strong>按文档规则</strong>
              <small>组合标题、正文、时间和大小等条件</small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={matchType === "extension"}
              className={matchType === "extension" ? "active" : ""}
              onClick={() => setMatchType("extension")}
            >
              <span aria-hidden="true">▧</span>
              <strong>按文件格式</strong>
              <small>按本地交付文件的扩展名自动归类</small>
            </button>
          </div>

          {matchType === "domain" ? (
            <label className="document-library-domain">
              <span>域名包含</span>
              <div><span>https://</span><input required value={domainContains} onChange={(event) => setDomainContains(event.target.value)} placeholder="myteam.feishu.cn" /></div>
              <small>只匹配域名部分，不受链接路径和参数影响。</small>
            </label>
          ) : matchType === "extension" ? (
            <label className="document-library-domain">
              <span>文件格式</span>
              <input
                required
                value={extensionsText}
                onChange={(event) => setExtensionsText(event.target.value)}
                placeholder="例如：png, jpg, jpeg"
              />
              <small>用逗号或空格分隔，可带或不带“.”；例如 png、jpg、jpeg 可归入“图片”。</small>
            </label>
          ) : (
            <div className="document-library-rules">
              <div className="document-library-rule-mode">
                <span>满足</span>
                <select value={matchMode} onChange={(event) => setMatchMode(event.target.value as "all" | "any") }>
                  <option value="all">全部条件</option>
                  <option value="any">任一条件</option>
                </select>
                <span>时归入此文档库</span>
              </div>
              {rules.map((rule) => (
                <div className="document-library-rule" key={rule.id}>
                  <select value={rule.field} aria-label="规则字段" onChange={(event) => changeRuleField(rule, event.target.value as DocumentLibraryRuleField)}>
                    {FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <select value={rule.operator} aria-label="规则关系" onChange={(event) => updateRule(rule.id, { operator: event.target.value as DocumentLibraryRuleOperator })}>
                    {operatorsFor(rule.field).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <input
                    required
                    aria-label="规则值"
                    type={rule.field === "fileSize" ? "number" : rule.field === "createdAt" || rule.field === "updatedAt" ? "date" : "text"}
                    min={rule.field === "fileSize" ? "0" : undefined}
                    step={rule.field === "fileSize" ? "0.1" : undefined}
                    value={rule.value}
                    onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                    placeholder={rule.field === "fileSize" ? "大小（MB）" : "请输入匹配内容"}
                  />
                  <button type="button" aria-label="删除规则" disabled={rules.length === 1} onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}>×</button>
                </div>
              ))}
              <button className="document-library-add-rule" type="button" disabled={rules.length >= 12} onClick={() => setRules((current) => [...current, initialRule()])}>＋ 增加条件</button>
              <small>正文规则使用系统已索引的文档正文或交付摘要；文件大小仅适用于本地文件。</small>
            </div>
          )}
        </section>

        {error && <div className="document-library-form-error" role="alert">{error}</div>}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={!valid || saving}>{saving ? "正在保存…" : library ? "保存修改" : "创建文档库"}</button>
        </footer>
      </form>
    </dialog>
  );
}
