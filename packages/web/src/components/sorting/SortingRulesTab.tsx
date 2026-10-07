import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { notificationApi } from "../../api";
import { priorityLabel } from "../../utils";
import type { MailSortRule, MailSortRuleInput, SortPreview, SortPreviewSample } from "../../types";
import { humanError } from "../../utils/humanError";

/**
 * Вкладка «Правила сортировки» (stage5-ux.md §5.1).
 *
 * Правило помечает письмо меткой, приоритетом и подсказкой и поднимает его в очереди.
 * Документ по-прежнему регистрирует человек — правило номер не выдаёт и записи в журнале
 * не создаёт ни при каких настройках (rules §6.1, контракт §0.2). Это сказано прямо в тексте:
 * подпись «зарегистрирует» здесь запрещена.
 */

const INTRO =
  "Правило помечает письмо меткой, приоритетом и подсказкой и может поднять его в очереди. Документ по-прежнему регистрирует человек — правило номер не выдаёт.";

const MATCH_HINT =
  "Сравнение без учёта регистра. Пустое условие означает «любое». Заполните хотя бы одно поле.";

const MATCH_ERROR =
  "Заполните хотя бы одно условие: отправитель, получатель или тема. Иначе правило поймает всю почту.";

/** «от: ivanov@ · кому: pochta@ · тема содержит: обращение» — только непустые части. */
export function matchSummary(r: MailSortRuleInput): string {
  const parts: string[] = [];
  if (r.matchFrom) parts.push("от: " + r.matchFrom);
  if (r.matchTo) parts.push("кому: " + r.matchTo);
  if (r.matchSubject) parts.push("тема содержит: " + r.matchSubject);
  return parts.length ? parts.join(" · ") : "условия не заданы — правило не работает";
}

/** Текст результата предпросмотра — один для строки таблицы и для формы. */
function previewText(p: SortPreview): string {
  if (!p.matched) {
    return "Под это правило пока не подходит ни одно письмо. Проверьте условия: возможно, они слишком узкие.";
  }
  return "Под правило подходят " + p.matched + " из " + p.total + " писем.";
}

/**
 * Образцы предпросмотра: «{subject} — {from}», ниже — метки, приоритет и примечание,
 * если они есть (stage5-ux.md §5.1, редакция от 2026-10-07). Даты в sample нет — §6 её не отдаёт.
 */
function PreviewSamples({ samples }: { samples: SortPreviewSample[] }) {
  if (!samples.length) return null;
  return (
    <div style={{ fontSize: 12, color: "#595959" }}>
      {samples.map((s, i) => (
        <div key={s.emailId || String(i)} style={{ marginTop: i ? 6 : 0 }}>
          {s.subject + " — " + (s.from || "отправитель не указан")}
          {s.labels.length ? <div>{"метки: " + s.labels.join(", ")}</div> : null}
          {s.priority !== null ? <div>{"приоритет: " + priorityLabel(s.priority)}</div> : null}
          {s.notes.length ? <div>{s.notes.join(" ")}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function SortingRulesTab() {
  const [rules, setRules] = useState<MailSortRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MailSortRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ text: string; samples: SortPreviewSample[] } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [form] = Form.useForm();

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await notificationApi.sortRules();
      setRules(res.items);
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

  const openNew = () => {
    setEditing(null);
    setPreview(null);
    setPreviewError("");
    form.resetFields();
    form.setFieldsValue({ isActive: true, sortOrder: rules.length, priority: null });
    setOpen(true);
  };

  const openEdit = (r: MailSortRule) => {
    setEditing(r);
    setPreview(null);
    setPreviewError("");
    form.setFieldsValue({
      name: r.name,
      matchFrom: r.matchFrom,
      matchTo: r.matchTo,
      matchSubject: r.matchSubject,
      label: r.label,
      priority: r.priority,
      note: r.note,
      sortOrder: r.sortOrder,
      isActive: r.isActive
    });
    setOpen(true);
  };

  /** Проверка по текущим полям формы — до сохранения и без записи. */
  const previewCurrent = async () => {
    const v = form.getFieldsValue();
    const input: MailSortRuleInput = {
      name: v.name ? String(v.name) : "",
      matchFrom: v.matchFrom ? String(v.matchFrom) : "",
      matchTo: v.matchTo ? String(v.matchTo) : "",
      matchSubject: v.matchSubject ? String(v.matchSubject) : "",
      label: v.label ? String(v.label) : "",
      priority: typeof v.priority === "number" ? v.priority : null,
      note: v.note ? String(v.note) : ""
    };
    if (!input.matchFrom && !input.matchTo && !input.matchSubject) {
      setPreviewError(MATCH_ERROR);
      setPreview(null);
      return;
    }
    setPreviewing(true);
    setPreviewError("");
    try {
      const res = await notificationApi.previewSortRule(input);
      // Дата в образце не приходит: §6 отдаёт emailId, subject, from, labels, notes, priority.
      // Своё поле не выдумываем — показываем тему, отправителя, метки и приоритет.
      setPreview({ text: previewText(res), samples: res.samples.slice(0, 3) });
    } catch (e) {
      setPreviewError("Не удалось проверить правило: " + humanError(e));
    } finally {
      setPreviewing(false);
    }
  };

  /** Предпросмотр правила из строки таблицы: то же, что в форме, но по сохранённым полям. */
  const previewRule = async (r: MailSortRule) => {
    setPreviewError("");
    setPreview({ text: "Проверяем…", samples: [] });
    try {
      const res = await notificationApi.previewSortRule({
        name: r.name,
        matchFrom: r.matchFrom,
        matchTo: r.matchTo,
        matchSubject: r.matchSubject,
        label: r.label,
        priority: r.priority,
        note: r.note
      });
      setPreview({ text: previewText(res), samples: res.samples.slice(0, 3) });
    } catch (e) {
      setPreview(null);
      setPreviewError("Не удалось проверить правило: " + humanError(e));
    }
  };

  const submit = async () => {
    let v: Record<string, unknown>;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const input: MailSortRuleInput = {
      name: String(v.name ?? "").trim(),
      matchFrom: String(v.matchFrom ?? "").trim(),
      matchTo: String(v.matchTo ?? "").trim(),
      matchSubject: String(v.matchSubject ?? "").trim(),
      label: String(v.label ?? "").trim(),
      priority: typeof v.priority === "number" ? v.priority : null,
      note: String(v.note ?? "").trim(),
      sortOrder: typeof v.sortOrder === "number" ? v.sortOrder : 0,
      isActive: v.isActive !== false
    };
    if (!input.matchFrom && !input.matchTo && !input.matchSubject) {
      message.error(MATCH_ERROR);
      return;
    }
    setSaving(true);
    try {
      if (editing) await notificationApi.updateSortRule(editing.id, input);
      else await notificationApi.createSortRule(input);
      message.success(editing ? "Правило сохранено" : "Правило добавлено");
      setOpen(false);
      await load();
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (r: MailSortRule, isActive: boolean) => {
    try {
      await notificationApi.updateSortRule(r.id, { isActive });
      setRules((list) => list.map((x) => (x.id === r.id ? { ...x, isActive } : x)));
    } catch (e) {
      const text = humanError(e);
      message.error(text.includes("404") ? "Правило уже удалено. Обновите список." : text);
      await load();
    }
  };

  const remove = async (r: MailSortRule) => {
    try {
      await notificationApi.deleteSortRule(r.id);
      message.success("Правило удалено");
      await load();
    } catch (e) {
      const text = humanError(e);
      message.error(
        text.includes("404") ? "Правило уже удалено. Обновите список." : "Не удалось удалить правило: " + text
      );
      await load();
    }
  };

  const columns: ColumnsType<MailSortRule> = [
    {
      title: "Вкл",
      key: "active",
      width: 60,
      render: (_v, r) => (
        <Switch
          size="small"
          checked={r.isActive}
          aria-label={"Правило «" + (r.name || "без названия") + "» включено"}
          onChange={(checked) => void toggleActive(r, checked)}
        />
      )
    },
    {
      title: "Название",
      dataIndex: "name",
      width: 180,
      render: (v: string) => v || <span style={{ color: "#595959" }}>без названия</span>
    },
    {
      title: "Что ловит",
      key: "match",
      render: (_v, r) => {
        const summary = matchSummary(r);
        const empty = summary.startsWith("условия не заданы");
        return <span style={empty ? { color: "#ad4e00" } : undefined}>{summary}</span>;
      }
    },
    {
      title: "Метка",
      dataIndex: "label",
      width: 130,
      render: (v: string) => (v ? <Tag color="blue">{v}</Tag> : "—")
    },
    {
      title: "Приоритет",
      dataIndex: "priority",
      width: 120,
      render: (p: number | null) => (p === null ? "не подсказывать" : p + " — " + priorityLabel(p))
    },
    { title: "Порядок", dataIndex: "sortOrder", width: 80 },
    {
      title: "Действия",
      key: "actions",
      width: 210,
      render: (_v, r) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => void previewRule(r)}>
            Проверить
          </Button>
          <Button type="link" size="small" onClick={() => openEdit(r)}>
            Изменить
          </Button>
          <Popconfirm
            title={"Удалить правило «" + (r.name || "без названия") + "»?"}
            description="Письма останутся на месте: удаляется только правило. Регистрация документов не затрагивается."
            okText="Удалить"
            cancelText="Отмена"
            okButtonProps={{ danger: true }}
            onConfirm={() => void remove(r)}
          >
            <Button type="link" size="small" danger>
              Удалить
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  if (forbidden) {
    return <Alert type="error" showIcon message="Недостаточно прав для этого раздела" />;
  }

  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
        {INTRO}
      </Typography.Text>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
          Добавить правило
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          Обновить
        </Button>
      </div>

      {error && !forbidden ? (
        <Alert type="error" showIcon message="Не удалось загрузить правила" description={error} style={{ marginBottom: 12 }} />
      ) : null}

      {previewError ? (
        <Alert
          type="error"
          showIcon
          message={previewError}
          style={{ marginBottom: 12 }}
          action={
            <Button size="small" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {preview ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={preview.text}
          description={preview.samples.length ? <PreviewSamples samples={preview.samples} /> : undefined}
        />
      ) : null}

      {loading && !rules.length ? (
        <Spin />
      ) : rules.length ? (
        <Table rowKey={(r) => r.id} columns={columns} dataSource={rules} pagination={false} size="small" />
      ) : (
        <Empty description="Правил сортировки пока нет">
          <div style={{ color: "#595959", fontSize: 12, marginBottom: 8 }}>
            Письма размечает аппарат вручную. Добавьте правило, чтобы подсказать метку, приоритет и поднять письмо
            в очереди.
          </div>
          <Button type="primary" onClick={openNew}>
            Добавить правило
          </Button>
        </Empty>
      )}

      <Modal
        open={open}
        title={editing ? "Правило «" + (editing.name || "без названия") + "»" : "Новое правило"}
        width={640}
        onCancel={() => setOpen(false)}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={saving}
        onOk={() => void submit()}
        footer={[
          <Button key="preview" loading={previewing} onClick={() => void previewCurrent()} style={{ float: "left" }}>
            {previewing ? "Проверяем…" : "Проверить на письмах"}
          </Button>,
          <Button key="cancel" onClick={() => setOpen(false)}>
            Отмена
          </Button>,
          <Button key="ok" type="primary" loading={saving} onClick={() => void submit()}>
            Сохранить
          </Button>
        ]}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Название" rules={[{ required: true, message: "Укажите название" }]}>
            <Input placeholder="Например: обращения из прокуратуры" maxLength={120} showCount />
          </Form.Item>
          <Form.Item name="matchFrom" label="Отправитель содержит">
            <Input placeholder="ivanov@ или @prokuratura.ru" maxLength={200} />
          </Form.Item>
          <Form.Item name="matchTo" label="Получатель содержит">
            <Input placeholder="pochta@org.ru" maxLength={200} />
          </Form.Item>
          <Form.Item name="matchSubject" label="Тема содержит">
            <Input placeholder="обращение" maxLength={200} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
            {MATCH_HINT}
          </Typography.Text>
          <Form.Item name="label" label="Метка">
            <Input placeholder="Прокуратура" maxLength={40} showCount />
          </Form.Item>
          <Form.Item name="priority" label="Приоритет">
            <Select
              allowClear
              placeholder="Не подсказывать"
              options={[1, 2, 3, 4, 5].map((p) => ({ value: p, label: p + " — " + priorityLabel(p) }))}
            />
          </Form.Item>
          <Form.Item name="note" label="Примечание аппарату">
            <Input.TextArea rows={3} placeholder="Проверить срок ответа по регламенту" maxLength={200} showCount />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="sortOrder" label="Порядок">
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="isActive" label="Включено" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          {previewError ? (
            <Alert type="error" showIcon message={previewError} style={{ marginBottom: 8 }} />
          ) : null}
          {preview ? (
            <Alert
              type="info"
              showIcon
              message={preview.text}
              description={preview.samples.length ? <PreviewSamples samples={preview.samples} /> : undefined}
            />
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
