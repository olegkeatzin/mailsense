import { useEffect, useState } from "react";
import { Alert, Badge, Button, Empty, Input, Modal, Space, Spin, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { resolutionApi } from "../api";
import { useStore } from "../store";
import { PRIORITY_TITLES, type TaskItem } from "../resolutionTypes";

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
  const setSection = useStore((s) => s.setSection);
  const select = useStore((s) => s.select);
  /** Открывает исходное письмо в почтовом разделе — из задачи виден её предмет. */
  async function openLetter(emailId: string) {
    setSection("mail");
    await select(emailId);
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
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const columns: ColumnsType<TaskItem> = [
    {
      title: "Документ",
      dataIndex: "documentNumber",
      width: 110,
      render: (v: string, r) => <a onClick={() => message.info(r.documentSummary || "Без описания")}>{v || "—"}</a>
    },
    {
      title: "",
      key: "email",
      width: 100,
      render: (_v, r) =>
        r.emailId ? (
          // Поручение без предмета бесполезно: исполнитель должен видеть само письмо.
          <Button size="small" type="link" onClick={() => void openLetter(r.emailId!)}>
            Письмо
          </Button>
        ) : (
          <span style={{ color: "#bbb", fontSize: 12 }}>бумажный</span>
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
      width: 170,
      render: (_v, r) => {
        if (!r.deadline) return <span style={{ color: "#999" }}>не указан</span>;
        const label = dayjs(r.deadline).format("DD.MM.YYYY");
        if (r.overdue) {
          return (
            <Space size={4}>
              <span style={{ color: "#cf1322", fontWeight: 600 }}>{label}</span>
              <Tag color="red">просрочено на {-1 * (r.daysLeft ?? 0)} дн.</Tag>
            </Space>
          );
        }
        if (r.daysLeft !== null && r.daysLeft <= 3) {
          return (
            <Space size={4}>
              <span>{label}</span>
              <Tag color="orange">осталось {r.daysLeft} дн.</Tag>
            </Space>
          );
        }
        return <span>{label}</span>;
      }
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
          <span style={{ color: "#bbb", fontSize: 12 }}>нет срока</span>
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
            <Tag color="green" style={{ cursor: "help" }}>
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
      message.error((e as Error).message);
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
        <div style={{ color: "#999", fontSize: 12, marginTop: 8 }}>
          Отчёт увидят аппарат и руководитель. Когда отчитается ответственный, поручение закроется.
        </div>
      </Modal>

      <div style={{ marginTop: 12, fontSize: 12, color: "#999" }}>
        Отчёт об исполнении появится на следующем этапе. Пока о результате сообщайте аппарату письмом.
      </div>
    </div>
  );
}