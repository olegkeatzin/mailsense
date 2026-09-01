import { useEffect, useRef, useState } from "react";
import { FixedSizeList } from "react-window";
import { Checkbox, Empty, Spin, Tag } from "antd";
import { useStore } from "../store";
import type { Email } from "../types";
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

export default function EmailList() {
  const emails = useStore((s) => s.emails);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const loading = useStore((s) => s.loading);
  const selectedIds = useStore((s) => s.selectedIds);
  const toggleSelect = useStore((s) => s.toggleSelect);

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

  if (loading && emails.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spin />
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
