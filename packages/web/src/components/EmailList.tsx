import { useCallback, useRef, useState, type ReactNode } from "react";
import { FixedSizeList } from "react-window";
import { Alert, Badge, Button, Checkbox, Empty, Spin, Tag } from "antd";
import { hasActiveFilter, useStore } from "../store";
import type { Email, ThreadGroup } from "../types";
import {
  categoryColor,
  categoryLabel,
  formatDate,
  priorityColor,
  priorityLabel,
  statusColor,
  statusLabel
} from "../utils";

function EmailRowItem({ e, selected }: { e: Email; selected: boolean }) {
  const senderName = e.from?.name?.trim() || "";
  const senderAddress = e.from?.address?.trim() || senderName || "(неизвестен)";
  const senderTitle = senderName ? senderName + " <" + senderAddress + ">" : senderAddress;
  const snippet = (e.bodyText || "").replace(/\s+/g, " ").slice(0, 90);
  const a = e.analysis;

  return (
    <div
      style={{
        padding: "10px 12px",
        borderBottom: "1px solid #f5f5f5",
        background: selected ? "#e6f4ff" : undefined
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          title={senderTitle}
          style={{
            minWidth: 0,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }}
        >
          {senderName ? (
            <>
              <span style={{ fontWeight: 600 }}>{senderName}</span>{" "}
              <span style={{ color: "#595959", fontWeight: 400, fontSize: 12 }}>&lt;{senderAddress}&gt;</span>
            </>
          ) : (
            <span style={{ fontWeight: 600 }}>{senderAddress}</span>
          )}
        </span>
        <span style={{ fontSize: 12, color: "#595959", whiteSpace: "nowrap" }}>{formatDate(e.date)}</span>
      </div>
      <div
        title={e.subject}
        style={{
          fontWeight: a?.urgent ? 700 : 500,
          fontSize: 13,
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}
      >
        {e.subject}
      </div>
      {/* Фрагмент обрезан: без подсказки полный текст иначе не увидеть, не открыв письмо. */}
      <div
        title={e.bodyText || undefined}
        style={{
          fontSize: 12,
          color: "#595959",
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}
      >
        {snippet}
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flex: 1, minWidth: 0, overflow: "hidden" }}>
          {a ? (
            <>
              {/*
                Цветные точки несут смысл (приоритет и категория), но текстом не подписаны:
                для чтения с экрана подпись задана здесь, глазами — во всплывающей подсказке.
              */}
              <span
                role="img"
                title={"Приоритет: " + priorityLabel(a.priority) + "; категория: " + categoryLabel(a.category)}
                aria-label={"Приоритет: " + priorityLabel(a.priority) + "; категория: " + categoryLabel(a.category)}
                style={{ display: "inline-flex", gap: 4, alignItems: "center", flexShrink: 0 }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: priorityColor(a.priority),
                    display: "inline-block",
                    flexShrink: 0
                  }}
                />
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: categoryColor(a.category),
                    display: "inline-block",
                    flexShrink: 0
                  }}
                />
              </span>
              {a.tags.slice(0, 3).map((t) => (
                <Tag key={t} style={{ margin: 0, fontSize: 11, lineHeight: "16px", flexShrink: 0 }}>
                  {t}
                </Tag>
              ))}
              {a.tags.length > 3 ? (
                <Tag style={{ margin: 0, fontSize: 11, lineHeight: "16px", flexShrink: 0 }}>
                  +{a.tags.length - 3}
                </Tag>
              ) : null}
            </>
          ) : null}
        </div>
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            color: statusColor(e.analysisStatus),
            whiteSpace: "nowrap"
          }}
        >
          {statusLabel(e.analysisStatus)}
        </span>
      </div>
    </div>
  );
}

function normId(id: string | null | undefined): string {
  return (id ?? "").trim().replace(/^</, "").replace(/>$/, "");
}

/** Строит дерево переписки по In-Reply-To / References и рендерит его с отступами. */
function ThreadTree({
  emails,
  selectedId,
  selectedIds,
  onSelect,
  toggleSelect
}: {
  emails: Email[];
  selectedId: string | null;
  selectedIds: string[];
  onSelect: (id: string) => void;
  toggleSelect: (id: string) => void;
}) {
  const byId = new Map<string, Email>();
  for (const e of emails) byId.set(normId(e.messageId), e);

  const childrenMap = new Map<string, Email[]>();
  const roots: Email[] = [];
  for (const e of emails) {
    const parentId =
      normId(e.inReplyTo) || (e.references?.length ? normId(e.references[e.references.length - 1]) : "");
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      const arr = childrenMap.get(parent.id) ?? [];
      arr.push(e);
      childrenMap.set(parent.id, arr);
    } else {
      roots.push(e);
    }
  }
  const byDate = (a: Email, b: Email) => (a.date ?? "").localeCompare(b.date ?? "");
  roots.sort(byDate);
  for (const arr of childrenMap.values()) arr.sort(byDate);

  const render = (e: Email, depth: number): ReactNode => {
    const kids = childrenMap.get(e.id) ?? [];
    return (
      <div key={e.id}>
        {/* Строка открывает письмо: без role/tabIndex она была доступна только мышью. */}
        <div
          role="button"
          tabIndex={0}
          aria-label={"Открыть письмо: " + (e.subject || "без темы")}
          onClick={() => onSelect(e.id)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              onSelect(e.id);
            }
          }}
          style={{
            cursor: "pointer",
            marginLeft: depth * 20,
            borderLeft: "2px solid #e0e0e0",
            background: depth === 0 ? "#fff" : undefined,
            display: "flex"
          }}
        >
          <div
            onClick={(ev) => ev.stopPropagation()}
            style={{ display: "flex", alignItems: "center", paddingLeft: 8 }}
          >
            <Checkbox
              aria-label={"Выбрать письмо: " + (e.subject || "без темы")}
              checked={selectedIds.includes(e.id)}
              onChange={() => toggleSelect(e.id)}
            />
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              borderLeft: selectedId === e.id ? "3px solid #1677ff" : "3px solid transparent",
              paddingLeft: 6
            }}
          >
            <EmailRowItem e={e} selected={e.id === selectedId} />
          </div>
        </div>
        {kids.map((k) => render(k, depth + 1))}
      </div>
    );
  };

  return <div style={{ background: "#fafafa", paddingBottom: 4 }}>{roots.map((r) => render(r, 0))}</div>;
}

function ThreadGroupItem({
  t,
  expanded,
  onToggle,
  selectedId,
  selectedIds,
  onSelect,
  toggleSelect,
  toggleSelectMany
}: {
  t: ThreadGroup;
  expanded: boolean;
  onToggle: () => void;
  selectedId: string | null;
  selectedIds: string[];
  onSelect: (id: string) => void;
  toggleSelect: (id: string) => void;
  toggleSelectMany: (ids: string[]) => void;
}) {
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={(expanded ? "Свернуть переписку: " : "Развернуть переписку: ") + (t.subject || "без темы")}
        onClick={onToggle}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onToggle();
          }
        }}
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #f5f5f5",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "#fff"
        }}
      >
        <Checkbox
          aria-label={"Выбрать всю переписку: " + (t.subject || "без темы")}
          checked={t.emails.length > 0 && t.emails.every((e) => selectedIds.includes(e.id))}
          indeterminate={
            t.emails.some((e) => selectedIds.includes(e.id)) && !t.emails.every((e) => selectedIds.includes(e.id))
          }
          onChange={() => toggleSelectMany(t.emails.map((e) => e.id))}
          onClick={(ev) => ev.stopPropagation()}
        />
        <Badge count={t.count} size="small" overflowCount={99} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 13,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}
          >
            {t.subject}
          </div>
          <div style={{ fontSize: 12, color: "#595959" }}>
            {formatDate(t.lastMessageAt)} · {t.count} сообщ.
          </div>
        </div>
      </div>
      {expanded ? (
        <ThreadTree
          emails={t.emails}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelect={onSelect}
          toggleSelect={toggleSelect}
        />
      ) : null}
    </div>
  );
}

export default function EmailList() {
  const emails = useStore((s) => s.emails);
  const threads = useStore((s) => s.threads);
  const threadView = useStore((s) => s.threadView);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const loading = useStore((s) => s.loading);
  const selectedIds = useStore((s) => s.selectedIds);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const toggleSelectMany = useStore((s) => s.toggleSelectMany);
  const loadError = useStore((s) => s.loadError);
  const loadEmails = useStore((s) => s.loadEmails);
  const resetFilters = useStore((s) => s.resetFilters);
  const filterActive = useStore((s) => hasActiveFilter(s));
  const [expanded, setExpanded] = useState<string | null>(null);

  const [height, setHeight] = useState(600);
  const resizeObserver = useRef<ResizeObserver | null>(null);

  /**
   * Callback-ref вместо useEffect с [].
   *
   * Раньше высота измерялась в эффекте с пустыми зависимостями: на момент его
   * запуска список ещё не отрисован (или отрисован «Нет писем»), ref был null,
   * эффект выходил и больше не повторялся — FixedSizeList навсегда оставался
   * высотой 600. Callback-ref вызывается в момент появления узла.
   */
  const attachList = useCallback((el: HTMLDivElement | null) => {
    resizeObserver.current?.disconnect();
    resizeObserver.current = null;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    resizeObserver.current = ro;
  }, []);

  /**
   * Сбой сети раньше выглядел как «ничего не произошло»: список молча оставался
   * от прежней папки, а ошибка уходила в консоль. Теперь говорим прямо.
   */
  const errorAlert = loadError ? (
    <Alert
      type="error"
      showIcon
      style={{ margin: 8 }}
      message="Не удалось обновить список писем"
      description={loadError}
      action={
        <Button size="small" onClick={() => void loadEmails()}>
          Повторить
        </Button>
      }
    />
  ) : null;

  /** Пустой список: «нет писем» и «фильтр ничего не нашёл» — разные вещи. */
  const emptyState = (description: string) =>
    filterActive ? (
      <Empty description="Ничего не найдено по фильтру" style={{ marginTop: 80 }}>
        <Button size="small" onClick={resetFilters}>
          Сбросить фильтр
        </Button>
      </Empty>
    ) : (
      <Empty description={description} style={{ marginTop: 80 }} />
    );

  if (loading && emails.length === 0 && threads.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spin />
      </div>
    );
  }

  if (threadView) {
    if (threads.length === 0) {
      return (
        <>
          {errorAlert}
          <div style={{ flex: 1 }}>{emptyState("Нет переписки")}</div>
        </>
      );
    }
    return (
      <div style={{ flex: 1, overflow: "auto" }}>
        {errorAlert}
        {threads.map((t) => (
          <ThreadGroupItem
            key={t.id}
            t={t}
            expanded={expanded === t.id}
            onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
            selectedId={selectedId}
            selectedIds={selectedIds}
            onSelect={(id) => void select(id)}
            toggleSelect={toggleSelect}
            toggleSelectMany={toggleSelectMany}
          />
        ))}
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <>
        {errorAlert}
        <div style={{ flex: 1 }}>{emptyState("Нет писем")}</div>
      </>
    );
  }

  return (
    <div ref={attachList} style={{ flex: 1, overflow: "hidden" }}>
      {errorAlert}
      <FixedSizeList
        height={height}
        itemCount={emails.length}
        itemSize={92}
        width="100%"
      >
        {({ index, style }: { index: number; style: React.CSSProperties }) => {
          const e = emails[index];
          return (
            <div style={{ ...style, display: "flex" }} className="mail-list-row">
              <div
                onClick={(ev) => ev.stopPropagation()}
                style={{ display: "flex", alignItems: "center", paddingLeft: 10 }}
              >
                <Checkbox
                  aria-label={"Выбрать письмо: " + (e.subject || "без темы")}
                  checked={selectedIds.includes(e.id)}
                  onChange={() => toggleSelect(e.id)}
                />
              </div>
              {/* Письмо открывается и с клавиатуры: строка — кнопка, а не только div с onClick. */}
              <div
                role="button"
                tabIndex={0}
                aria-label={"Открыть письмо: " + (e.subject || "без темы")}
                style={{ flex: 1, minWidth: 0 }}
                onClick={() => void select(e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    void select(e.id);
                  }
                }}
              >
                <EmailRowItem e={e} selected={e.id === selectedId} />
              </div>
            </div>
          );
        }}
      </FixedSizeList>
    </div>
  );
}
