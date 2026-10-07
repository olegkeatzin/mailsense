import { useEffect, useState } from "react";
import { Alert, Badge, Button, Empty, Input, Modal, Space, Spin, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { resolutionApi } from "../api";
import { useStore } from "../store";
import { PRIORITY_TITLES, type TaskItem } from "../resolutionTypes";
import type { TaskSourceEmail } from "../types";
import { SafeLetterHtml } from "./SafeLetterHtml";
import { DeadlineTag } from "./notifications/deadline";
import { READY_STYLE } from "./notifications/colors";
import { humanError } from "../utils/humanError";

/**
 * «Мои задачи» исполнителя (этап 3).
 *
 * Задача появляется здесь только после того, как резолюцию утвердил подписант
 * и отправил аппарат — до этого исполнитель о ней не знает.
 *
 * Открытие списка фиксирует «расписку» (графа 8 журнала): важно, когда человек
 * получил документ, а не когда открыл его в последний раз.
 */
export function MyTasks() {
  const can = useStore((s) => s.can);
  /**
   * Письмо-источник (T41): открывается ПОРУЧЕНИЕМ, а не почтовым разделом.
   * У исполнителя нет права mail.view, поэтому общий почтовый экран ему закрыт,
   * но предмет поручения он видеть обязан — сервер отдаёт урезанный вид письма.
   */
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceLetter, setSourceLetter] = useState<TaskSourceEmail | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState("");

  async function openSourceLetter(resolutionId: string) {
    setSourceOpen(true);
    setSourceLoading(true);
    setSourceError("");
    setSourceLetter(null);
    try {
      setSourceLetter(await resolutionApi.sourceEmail(resolutionId));
    } catch (e) {
      setSourceError(humanError(e));
    } finally {
      setSourceLoading(false);
    }
  }

  const [items, setItems] = useState<TaskItem[]>([]);
  /** Задача, по которой сейчас пишут отчёт. */
  const [reportFor, setReportFor] = useState<TaskItem | null>(null);
  const [reportText, setReportText] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const list = await resolutionApi.myTasks();
      setItems(list);
      // Отмечаем получение по каждой задаче, где его ещё нет.
      await Promise.all(
        list.filter((t) => !t.receivedAt).map((t) => resolutionApi.markReceived(t.resolutionId).catch(() => null))
      );
      if (list.some((t) => !t.receivedAt)) {
        const again = await resolutionApi.myTasks();
        setItems(again);
      }
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Права нет — «Мои задачи» не грузятся: иначе 403 в консоли у чужой роли.
    if (!can("task.view")) {
      setLoading(false);
      return;
    }
    void load();
  }, []);

  const columns: ColumnsType<TaskItem> = [
    {
      title: "Документ",
      dataIndex: "documentNumber",
      width: 110,
      // Кнопка, а не <a> без href: ссылка без адреса не берёт фокус и не нажимается с клавиатуры.
      render: (v: string, r) => (
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: "auto" }}
          onClick={() => message.info(r.documentSummary || "Без описания")}
        >
          {v || "—"}
        </Button>
      )
    },
    {
      title: "",
      key: "email",
      width: 100,
      render: (_v, r) =>
        r.emailId ? (
          // Поручение без предмета бесполезно: исполнитель должен видеть само письмо.
          <Button size="small" type="link" onClick={() => void openSourceLetter(r.resolutionId)}>
            Письмо
          </Button>
        ) : (
          <span style={{ color: "#767676", fontSize: 12 }}>бумажный</span>
        )
    },
    {
      title: "Поручение",
      dataIndex: "text",
      render: (v: string) => <div style={{ whiteSpace: "pre-wrap" }}>{v}</div>
    },
    {
      title: "Роль",
      dataIndex: "kind",
      width: 130,
      render: (v: TaskItem["kind"]) =>
        v === "responsible" ? <Tag color="blue">ответственный</Tag> : <Tag>соисполнитель</Tag>
    },
    {
      title: "Приоритет",
      dataIndex: "priority",
      width: 110,
      render: (p: TaskItem["priority"]) => (
        <Tag color={p === "urgent" ? "red" : p === "important" ? "orange" : "default"}>{PRIORITY_TITLES[p]}</Tag>
      )
    },
    {
      title: "Срок",
      dataIndex: "deadline",
      width: 200,
      // Порог «скоро» — серверный (dueSoon, тот же, что у уведомления). Свой порог
      // в интерфейсе разошёлся бы с напоминанием (А5 приложения к контракту).
      render: (_v, r) => (
        <DeadlineTag
          deadline={r.deadline}
          daysLeft={r.daysLeft}
          dueSoon={r.dueSoon}
          overdue={r.overdue}
          variant="table"
        />
      )
    },
    {
      title: "Получено",
      dataIndex: "receivedAt",
      width: 130,
      render: (v: string | null) => (v ? dayjs(v).format("DD.MM HH:mm") : <Tag>не отмечено</Tag>)
    },
    {
      title: "",
      key: "ics",
      width: 130,
      render: (_v, r) =>
        r.deadline ? (
          // Напоминания делает календарь — отдельные письма для этого не нужны (Р11).
          <Button size="small" href={resolutionApi.icsUrl(r.resolutionId)}>
            В календарь
          </Button>
        ) : (
          <span style={{ color: "#767676", fontSize: 12 }}>нет срока</span>
        )
    },
    {
      title: "Отчёт",
      dataIndex: "reportAt",
      width: 190,
      render: (v: string | null, r) =>
        v ? (
          // Видно и когда сдан, и что именно написал исполнитель — без открытия карточки.
          <Tooltip title={r.reportText || ""}>
            {/* Пресет color="green" даёт 3.37:1 — норма AA не проходит, поэтому свой стиль. */}
            <Tag style={{ ...READY_STYLE, cursor: "help" }}>
              сдан {dayjs(v).format("DD.MM HH:mm")}
            </Tag>
          </Tooltip>
        ) : (
          <Button size="small" type="primary" onClick={() => setReportFor(r)}>
            Отчитаться
          </Button>
        )
    }
  ];

  if (loading) return <Spin style={{ margin: 24 }} />;

  /** Отправляет отчёт и перечитывает список: поручение может закрыться сразу. */
  async function submitReport() {
    if (!reportFor) return;
    if (!reportText.trim()) {
      message.warning("Опишите, что сделано — пустой отчёт не принимается");
      return;
    }
    setReportBusy(true);
    try {
      await resolutionApi.report(reportFor.resolutionId, reportText);
      message.success("Отчёт отправлен");
      setReportFor(null);
      setReportText("");
      await load();
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setReportBusy(false);
    }
  }

  const overdue = items.filter((t) => t.overdue).length;

  return (
    <div style={{ padding: 16 }}>
      <Space align="center" style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>Мои задачи</Typography.Title>
        {overdue ? <Badge count={overdue} style={{ backgroundColor: "#cf1322" }} /> : null}
        {overdue ? <span style={{ color: "#cf1322" }}>просрочено</span> : null}
      </Space>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {!items.length ? (
        <Empty description="Задач нет" />
      ) : (
        <Table rowKey={(r) => r.resolutionId} columns={columns} dataSource={items} pagination={false} size="small" />
      )}
      <Modal
        open={!!reportFor}
        title={"Отчёт по документу " + (reportFor?.documentNumber ?? "")}
        okText="Отправить отчёт"
        confirmLoading={reportBusy}
        onCancel={() => setReportFor(null)}
        onOk={() => void submitReport()}
      >
        <div style={{ color: "#666", fontSize: 13, marginBottom: 8 }}>{reportFor?.text}</div>
        <Input.TextArea
          rows={5}
          value={reportText}
          onChange={(e) => setReportText(e.target.value)}
          placeholder="Что сделано и с каким результатом"
        />
        <div style={{ color: "#595959", fontSize: 12, marginTop: 8 }}>
          Отчёт увидят аппарат и руководитель. Когда отчитается ответственный, поручение закроется.
        </div>
      </Modal>

      {/* Письмо-источник: то же письмо, но по маршруту поручения — без доступа к почте. */}
      <Modal
        open={sourceOpen}
        title={sourceLetter?.subject || "Письмо-источник"}
        footer={null}
        width={720}
        onCancel={() => setSourceOpen(false)}
      >
        {sourceLoading ? <Spin /> : null}
        {sourceError ? <Alert type="error" showIcon message={sourceError} /> : null}
        {sourceLetter ? (
          <div>
            <div style={{ color: "#595959", fontSize: 12, marginBottom: 8 }}>
              От: {(sourceLetter.from?.name || sourceLetter.from?.address) ?? "не указан"} ·{" "}
              {sourceLetter.date ? dayjs(sourceLetter.date).format("DD.MM.YYYY HH:mm") : "без даты"}
            </div>
            {sourceLetter.bodyHtml ? (
              <SafeLetterHtml html={sourceLetter.bodyHtml} />
            ) : (
              <div style={{ whiteSpace: "pre-wrap" }}>{sourceLetter.bodyText}</div>
            )}
            {sourceLetter.attachments.length ? (
              <div style={{ marginTop: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Вложения: {sourceLetter.attachments.map((a) => a.filename).join(", ")}
                </Typography.Text>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <div style={{ marginTop: 12, fontSize: 12, color: "#595959" }}>
        Отчёт по задаче сдаётся кнопкой «Отчитаться»: его увидят аппарат и руководитель.
      </div>
    </div>
  );
}