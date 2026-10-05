import { useEffect, useState } from "react";
import { Alert, Card, Empty, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { resolutionApi } from "../api";
import { PRIORITY_TITLES, type BoardColumn, type Resolution } from "../resolutionTypes";

/**
 * Канбан резолюций (ТЗ п. 5, этап 3).
 *
 * Колонка «Просрочено» намеренно отдельная и первая по важности: просрочка — то,
 * на что смотрят в первую очередь. Резолюция может быть одновременно «в работе»
 * и «просрочена» — это разные вопросы, и смешивать их нельзя.
 */
function CardBody({ r }: { r: Resolution }) {
  const responsible = r.assignees.find((a) => a.kind === "responsible") ?? r.assignees[0];
  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <Space wrap size={4} style={{ marginBottom: 6 }}>
        <b>{r.documentNumber}</b>
        <Tag color={r.priority === "urgent" ? "red" : r.priority === "important" ? "orange" : "default"}>
          {PRIORITY_TITLES[r.priority]}
        </Tag>
        {r.deadline ? <Tag>{dayjs(r.deadline).format("DD.MM.YYYY")}</Tag> : <Tag color="orange">без срока</Tag>}
      </Space>
      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 6 }}>
        {r.text.length > 220 ? r.text.slice(0, 220) + "…" : r.text}
      </div>
      <div style={{ fontSize: 12, color: "#666" }}>
        {responsible ? responsible.fullName + (responsible.kind === "responsible" ? " (отв.)" : "") : "исполнитель не указан"}
        {r.assignees.length > 1 ? " и ещё " + (r.assignees.length - 1) : ""}
      </div>
      <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
        подготовил: {r.preparedByName || "—"}
        {r.approvedByName ? " · утвердил: " + r.approvedByName : ""}
        {r.dispatchedByName ? " · отправил: " + r.dispatchedByName : ""}
      </div>
    </Card>
  );
}

export function ResolutionBoard() {
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    resolutionApi
      .board()
      .then(setColumns)
      .catch((e) => setError((e as Error).message))
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
                  c.items.map((r) => <CardBody key={r.id + c.key} r={r} />)
                ) : (
                  <div style={{ color: "#bbb", fontSize: 12, textAlign: "center", padding: 12 }}>пусто</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}