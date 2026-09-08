import { useEffect, useRef, useState, type ReactNode } from "react";
import { FixedSizeList } from "react-window";
import { Badge, Checkbox, Empty, Spin, Tag } from "antd";
import { useStore } from "../store";
import type { Email, ThreadGroup } from "../types";
import {
  categoryColor,
  formatDate,
  priorityColor,
  statusColor,
  statusLabel
} from "../utils";

function EmailRowItem({ e, selected }: { e: Email; selected: boolean }) {
  const sender = e.from ? e.from.name || e.from.address : "(неизвестен)";
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
          style={{
            fontWeight: 600,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }}
        >
          {sender}
        </span>
        <span style={{ fontSize: 12, color: "#888", whiteSpace: "nowrap" }}>{formatDate(e.date)}</span>
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
      <div
        style={{
          fontSize: 12,
          color: "#999",
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
        <div
          onClick={() => onSelect(e.id)}
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
            <Checkbox checked={selectedIds.includes(e.id)} onChange={() => toggleSelect(e.id)} />
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
        onClick={onToggle}
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
          <div style={{ fontSize: 12, color: "#888" }}>
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
  const [expanded, setExpanded] = useState<string | null>(null);

  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const update = () => setHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
        <div style={{ flex: 1 }}>
          <Empty description="Нет переписки" style={{ marginTop: 80 }} />
        </div>
      );
    }
    return (
      <div style={{ flex: 1, overflow: "auto" }}>
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
      <div style={{ flex: 1 }}>
        <Empty description="Нет писем" style={{ marginTop: 80 }} />
      </div>
    );
  }

  return (
    <div ref={ref} style={{ flex: 1, overflow: "hidden" }}>
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
                <Checkbox checked={selectedIds.includes(e.id)} onChange={() => toggleSelect(e.id)} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }} onClick={() => void select(e.id)}>
                <EmailRowItem e={e} selected={e.id === selectedId} />
              </div>
            </div>
          );
        }}
      </FixedSizeList>
    </div>
  );
}
