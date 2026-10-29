import { useEffect, useState } from "react";
import { Alert, Card, Empty, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { resolutionApi } from "../api";
import { useStore } from "../store";
import { PRIORITY_TITLES, type BoardColumn, type Resolution } from "../resolutionTypes";
import { DeadlineTag } from "./notifications/deadline";
import { humanError } from "../utils/humanError";

/**
 * Канбан резолюций (ТЗ п. 5, этап 3).
 *
 * Колонка «Просрочено» намеренно отдельная и первая по важности: просрочка — то,
 * на что смотрят в первую очередь. Резолюция может быть одновременно «в работе»
 * и «просрочена» — это разные вопросы, и смешивать их нельзя.
 */
function CardBody({ r, onOpen }: { r: Resolution; onOpen?: (documentId: string) => void }) {
  const responsible = r.assignees.find((a) => a.kind === "responsible") ?? r.assignees[0];
  // Канбан без перехода — витрина: видно, что работа есть, а сделать ничего нельзя.
  // Ведём в карточку документа, где и живут действия; кому журнал недоступен по правам,
  // тот видит обычную карточку без обещания клика.
  const openProps = onOpen
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": "Открыть документ " + r.documentNumber,
        onClick: () => onOpen(r.documentId),
        onKeyDown: (ev: React.KeyboardEvent) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onOpen(r.documentId);
          }
        },
        style: { marginBottom: 8, cursor: "pointer" as const }
      }
    : { style: { marginBottom: 8 } };
  return (
    <Card size="small" {...openProps}>
      <Space wrap size={4} style={{ marginBottom: 6 }}>
        <b>{r.documentNumber}</b>
        <Tag color={r.priority === "urgent" ? "red" : r.priority === "important" ? "orange" : "default"}>
          {PRIORITY_TITLES[r.priority]}
        </Tag>
        {/* Срок и «скоро» приходят с сервера (А11): своего порога на клиенте нет. */}
        <DeadlineTag
          deadline={r.deadline}
          daysLeft={r.daysLeft ?? null}
          dueSoon={r.dueSoon}
          overdue={r.overdue}
          variant="card"
        />
      </Space>
      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 6 }}>
        {r.text.length > 220 ? r.text.slice(0, 220) + "…" : r.text}
      </div>
      <div style={{ fontSize: 12, color: "#666" }}>
        {responsible ? responsible.fullName + (responsible.kind === "responsible" ? " (отв.)" : "") : "исполнитель не указан"}
        {r.assignees.length > 1 ? " и ещё " + (r.assignees.length - 1) : ""}
      </div>
      <div style={{ fontSize: 11, color: "#595959", marginTop: 4 }}>
        подготовил: {r.preparedByName || "—"}
        {r.approvedByName ? " · утвердил: " + r.approvedByName : ""}
        {r.dispatchedByName ? " · отправил: " + r.dispatchedByName : ""}
        {r.closedByName ? " · закрыл: " + r.closedByName : ""}
      </div>
    </Card>
  );
}

export function ResolutionBoard() {
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const can = useStore((s) => s.can);
  const setSection = useStore((s) => s.setSection);
  const requestDocument = useStore((s) => s.requestDocument);
  const canOpenDocument = can("journal.view");

  const openDocument = (documentId: string) => {
    requestDocument(documentId);
    setSection("journal");
  };

  useEffect(() => {
    // Канбан — управленческий вид (право resolution.create): без него не запрашиваем.
    if (!can("resolution.create")) {
      setLoading(false);
      return;
    }
    resolutionApi
      .board()
      .then(setColumns)
      .catch((e) => setError(humanError(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spin style={{ margin: 24 }} />;

  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>Резолюции</Typography.Title>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {!columns.length ? (
        <Empty description="Резолюций пока нет" />
      ) : (
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", overflowX: "auto" }}>
          {columns.map((c) => (
            <div key={c.key} style={{ flex: "1 1 240px", minWidth: 240 }}>
              <div style={{ marginBottom: 8 }}>
                <b>{c.title}</b> <Tag>{c.items.length}</Tag>
              </div>
              <div style={{ background: "#fafafa", borderRadius: 8, padding: 8, minHeight: 80 }}>
                {c.items.length ? (
                  c.items.map((r) => (
                    <CardBody key={r.id + c.key} r={r} onOpen={canOpenDocument ? openDocument : undefined} />
                  ))
                ) : (
                  <div style={{ color: "#595959", fontSize: 12, textAlign: "center", padding: 12 }}>пусто</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}