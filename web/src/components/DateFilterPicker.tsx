import { useEffect, useRef, useState } from "react";
import { DayPicker, type Matcher } from "@daypicker/react";
import { zhCN } from "@daypicker/react/locale";

interface DateFilterPickerProps {
  align: "start" | "end";
  label: string;
  max?: string;
  min?: string;
  onChange: (value: string) => void;
  value: string;
}

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function parseDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1])
    || date.getMonth() !== Number(match[2]) - 1
    || date.getDate() !== Number(match[3])
  ) return undefined;
  return date;
}

function serializeDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateLabel(date: Date): string {
  const parts = DATE_LABEL_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}/${values.month}/${values.day}`;
}

function clampDate(date: Date, min?: Date, max?: Date): Date {
  if (min && date < min) return min;
  if (max && date > max) return max;
  return date;
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 1.5v2M12 1.5v2M2.5 6h11M4 3h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 12 14H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 3Z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DateFilterPicker({ align, label, max, min, onChange, value }: DateFilterPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = parseDate(value);
  const minDate = parseDate(min ?? "");
  const maxDate = parseDate(max ?? "");
  const today = new Date();
  const todayBlocked = Boolean((minDate && today < minDate) || (maxDate && today > maxDate));
  const disabled: Matcher[] = [];
  if (minDate) disabled.push({ before: minDate });
  if (maxDate) disabled.push({ after: maxDate });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  function closeAndReturnFocus() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function chooseDate(date: Date | undefined) {
    if (!date) return;
    onChange(serializeDate(date));
    closeAndReturnFocus();
  }

  return (
    <div className="documents-date-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        className="documents-date-trigger"
        type="button"
        aria-label={`${label}，${selected ? formatDateLabel(selected) : "未选择"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-empty={!selected || undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected ? formatDateLabel(selected) : "年/月/日"}</span>
        <CalendarIcon />
      </button>
      {open && (
        <div
          className="documents-date-popover"
          data-align={align}
          role="dialog"
          aria-label={`${label}日期选择器`}
        >
          <DayPicker
            autoFocus
            mode="single"
            locale={zhCN}
            weekStartsOn={0}
            selected={selected}
            defaultMonth={selected ?? clampDate(today, minDate, maxDate)}
            disabled={disabled}
            showOutsideDays
            onSelect={chooseDate}
            labels={{
              labelPrevious: () => "上个月",
              labelNext: () => "下个月",
            }}
          />
          <footer className="documents-date-actions">
            <button type="button" disabled={!selected} onClick={() => { onChange(""); closeAndReturnFocus(); }}>清除</button>
            <button type="button" disabled={todayBlocked} onClick={() => chooseDate(today)}>今天</button>
          </footer>
        </div>
      )}
    </div>
  );
}
