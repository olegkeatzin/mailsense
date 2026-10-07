import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Empty,
  Input,
  InputNumber,
  Modal,
  Skeleton,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { notificationApi } from "../../api";
import { NOTIFICATION_KIND_TITLES } from "../notifications/texts";
import type { NotificationSettings, NotificationTemplate } from "../../types";
import { humanError } from "../../utils/humanError";

/**
 * Вкладка «Уведомления» (stage5-ux.md §5.2 + А2/А3 приложения к контракту).
 *
 * Уведомления живут только в приложении: писем-напоминаний не отправляем (Р11).
 * Подстановки шаблона приходят с сервера — свой список не хардкодим, иначе подсказка
 * разойдётся с тем, что реально заменяет сервер.
 */

const HOLIDAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function NotificationsTab() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [dueSoonDays, setDueSoonDays] = useState(3);
  const [workdayDeadlines, setWorkdayDeadlines] = useState(true);
  const [holidaysText, setHolidaysText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [editing, setEditing] = useState<NotificationTemplate | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const s = await notificationApi.settings();
      setSettings(s);
      setEnabled(s.enabled);
      setDueSoonDays(s.dueSoonDays);
      setWorkdayDeadlines(s.workdayDeadlines);
      setHolidaysText((s.holidays ?? []).join("\n"));
      setForbidden(false);
    } catch (e) {
      const text = humanError(e);
      if (text.includes("403")) setForbidden(true);
      setError(text);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** Разбирает textarea «по одной дате в строке»; кривую дату не отправляем молча. */
  function parseHolidays(): string[] | null {
    const dates = holidaysText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = dates.find((d) => !HOLIDAY_RE.test(d));
    if (bad) {
      message.error("Дата должна быть в формате ГГГГ-ММ-ДД: " + bad);
      return null;
    }
    return dates;
  }

  const save = async () => {
    const holidays = parseHolidays();
    if (holidays === null) return;
    if (!Number.isInteger(dueSoonDays) || dueSoonDays < 0 || dueSoonDays > 30) {
      message.error("Введите целое число от 0 до 30.");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      await notificationApi.saveSettings({ enabled, dueSoonDays, workdayDeadlines, holidays });
      message.success("Настройки уведомлений сохранены");
      await load();
    } catch (e) {
      setSaveError(humanError(e));
    } finally {
      setSaving(false);
    }
  };

  const openTemplate = (t: NotificationTemplate) => {
    setEditing(t);
    setEditTitle(t.title);
    setEditBody(t.body);
  };

  const saveTemplate = async () => {
    if (!editing || !settings) return;
    setSavingTemplate(true);
    try {
      // Шаблоны сохраняются отдельным PUT: смешивать их с выключателем нельзя — у того
      // же маршрута нет полей шаблонов (stage5-ux.md §5.2).
      await notificationApi.saveSettings({
        templates: settings.templates.map((t) =>
          t.key === editing.key ? { key: t.key, title: editTitle, body: editBody, isActive: t.isActive } : { key: t.key, title: t.title, body: t.body, isActive: t.isActive }
        )
      });
      message.success("Шаблон сохранён");
      setEditing(null);
      await load();
    } catch (e) {
      message.error("Не удалось сохранить шаблон: " + humanError(e));
    } finally {
      setSavingTemplate(false);
    }
  };

  const columns: ColumnsType<NotificationTemplate> = [
    {
      title: "Вид",
      dataIndex: "key",
      width: 220,
      render: (k: string) => NOTIFICATION_KIND_TITLES[k] ?? "Другое уведомление"
    },
    {
      title: "Заголовок",
      dataIndex: "title",
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{v}</span>
        </Tooltip>
      )
    },
    {
      title: "Состояние",
      dataIndex: "isActive",
      width: 110,
      render: (v: boolean) => (v ? null : <Tag>выключен</Tag>)
    },
    {
      title: "Действия",
      key: "actions",
      width: 110,
      render: (_v, t) => (
        <Button type="link" size="small" onClick={() => openTemplate(t)}>
          Изменить
        </Button>
      )
    }
  ];

  if (forbidden) {
    return <Alert type="error" showIcon message="Недостаточно прав для этого раздела" />;
  }

  if (loading && !settings) return <Skeleton active paragraph={{ rows: 4 }} />;

  if (error && !settings) {
    return (
      <Alert
        type="error"
        showIcon
        message="Не удалось загрузить настройки уведомлений"
        description={error}
        action={
          <Button size="small" onClick={() => void load()}>
            Повторить
          </Button>
        }
      />
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Switch checked={enabled} onChange={setEnabled} id="notifications-enabled" />
        <Typography.Text>Показывать уведомления в приложении</Typography.Text>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
        Письма-напоминания не отправляются: исполнитель видит срок в приложении и может поставить задачу в календарь.
      </Typography.Text>

      <Divider />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Typography.Text>Предупреждать о сроке за</Typography.Text>
        <InputNumber
          min={0}
          max={30}
          value={dueSoonDays}
          onChange={(v) => setDueSoonDays(typeof v === "number" ? v : 0)}
          addonAfter="дн."
          aria-label="Предупреждать о сроке за N дней"
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
        0 — предупреждать только в день срока.
      </Typography.Text>

      <Divider />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Switch checked={workdayDeadlines} onChange={setWorkdayDeadlines} />
        <Typography.Text>Считать типовой срок в рабочих днях</Typography.Text>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
        Суббота и воскресенье пропускаются.
      </Typography.Text>

      <Divider />

      <Typography.Text strong style={{ display: "block", marginBottom: 4 }}>
        Праздничные дни
      </Typography.Text>
      <Input.TextArea
        rows={4}
        value={holidaysText}
        onChange={(e) => setHolidaysText(e.target.value)}
        placeholder="2026-01-01"
        aria-label="Праздничные дни"
      />
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
        По одной дате в формате ГГГГ-ММ-ДД в строке. Пустое значение допустимо.
      </Typography.Text>

      {saveError ? (
        <Alert type="error" showIcon message="Не удалось сохранить настройки" description={saveError} style={{ marginTop: 12 }} />
      ) : null}
      <Button type="primary" loading={saving} onClick={() => void save()} style={{ marginTop: 12 }}>
        Сохранить настройки
      </Button>

      <Divider />

      <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
        Тексты уведомлений
      </Typography.Text>
      {settings && settings.templates.length ? (
        <Table
          rowKey={(t) => t.key}
          columns={columns}
          dataSource={settings.templates}
          pagination={false}
          size="small"
        />
      ) : (
        <Empty description="Шаблоны уведомлений не загружены">
          <Button size="small" onClick={() => void load()}>
            Повторить
          </Button>
        </Empty>
      )}

      <Modal
        open={!!editing}
        title={editing ? NOTIFICATION_KIND_TITLES[editing.key] ?? "Другое уведомление" : ""}
        onCancel={() => setEditing(null)}
        onOk={() => void saveTemplate()}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={savingTemplate}
        width={620}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
          В тексте могут быть подстановки в фигурных скобках — сервер заменит их данными поручения. Не удаляйте уже
          существующие подстановки.
        </Typography.Text>
        {settings && settings.variables.length ? (
          <div style={{ marginBottom: 12 }}>
            {/* Список подстановок приходит с сервера (А2): свой не хардкодим. */}
            {settings.variables.map((v) => (
              <Tooltip key={v.key} title={v.title}>
                <Tag style={{ marginBottom: 4 }}>{"{" + v.key + "}"}</Tag>
              </Tooltip>
            ))}
          </div>
        ) : null}
        <Input
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          maxLength={200}
          aria-label="Заголовок шаблона"
          style={{ marginBottom: 8 }}
        />
        <Input.TextArea
          rows={4}
          value={editBody}
          onChange={(e) => setEditBody(e.target.value)}
          aria-label="Текст шаблона"
        />
      </Modal>
    </div>
  );
}
