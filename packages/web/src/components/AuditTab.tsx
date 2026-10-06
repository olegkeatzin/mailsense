import { useCallback, useEffect, useState } from "react";
import { Button, DatePicker, Input, Select, Space, Table, Tag, message } from "antd";
import { DownloadOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { api } from "../api";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import type { AuditEntry } from "../types";

/**
 * Аудит действий: кто, когда и что изменил.
 *
 * Нужен, чтобы разобраться, кто внёс неверные данные. Записи только добавляются —
 * из интерфейса их нельзя ни изменить, ни удалить.
 */
const ACTION_TITLES: Record<string, string> = {
  "journal.register": "Регистрация документа",
  "journal.edit": "Изменение документа",
  "journal.link_email": "Привязка письма",
  "journal.register_denied": "Отклонённая регистрация",
  "journal.numbering.save": "Смена правил нумерации",
  "journal.archive_period": "Выгрузка года в архив",
  "journal.reopen_period": "Отмена закрытия года",
  "journal.case.save": "Изменение номенклатуры дел",
  "journal.correspondent.save": "Изменение корреспондента",
  "journal.correspondent.create": "Новый корреспондент",
  "auth.login": "Вход в систему",
  "auth.logout": "Выход из системы",
  "user.roles": "Смена ролей",
  "user.block": "Блокировка пользователя",
  "settings.save": "Изменение настроек"
};

const ACTION_OPTIONS = [
  { value: "", label: "Все действия" },
  ...Object.entries(ACTION_TITLES).map(([value, label]) => ({ value, label }))
];

const ENTITY_OPTIONS = [
  { value: "", label: "Все объекты" },
  { value: "document", label: "Документы" },
  { value: "number_rule", label: "Правила нумерации" },
  { value: "case", label: "Номенклатура дел" },
  { value: "correspondent", label: "Корреспонденты" },
  { value: "user", label: "Пользователи" }
];

/** Показываем «было → стало» построчно: так сразу видно, что человек поменял. */
function diffText(entry: AuditEntry): string {
  if (!entry.oldValue || !entry.newValue) return "";
  try {
    const before = JSON.parse(entry.oldValue) as Record<string, unknown>;
    const after = JSON.parse(entry.newValue) as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(after)) {
      if (k === "updatedAt" || k === "createdAt" || k === "id") continue;
      const b = before[k];
      const a = after[k];
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        parts.push(k + ": «" + (b === undefined || b === null || b === "" ? "—" : String(b)) + "» → «" + (a === null || a === "" ? "—" : String(a)) + "»");
      }
    }
    return parts.join("; ");
  } catch {
    return "";
  }
}

export default function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  // Идентификатор объекта вводят руками: запрос ждёт паузы, а не идёт на каждую букву.
  const entityIdDebounced = useDebouncedValue(entityId, 300);
  const [range, setRange] = useState<[string, string]>(["", ""]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.audit({
        action: action || undefined,
        entityType: entityType || undefined,
        entityId: entityIdDebounced.trim() || undefined,
        dateFrom: range[0] || undefined,
        dateTo: range[1] || undefined,
        limit: 300
      });
      setEntries(res.entries);
      setTotal(res.total);
    } catch (err) {
      message.error("Не удалось загрузить аудит: " + (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [action, entityType, entityIdDebounced, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<AuditEntry> = [
    {
      title: "Когда",
      dataIndex: "createdAt",
      width: 160,
      render: (v: string) => dayjs(v).format("DD.MM.YYYY HH:mm:ss")
    },
    {
      title: "Кто",
      dataIndex: "userName",
      width: 180,
      render: (v: string) => v || <span style={{ color: "#767676" }}>система</span>
    },
    {
      title: "Действие",
      dataIndex: "action",
      width: 200,
      render: (v: string) => (
        <Tag color={v === "journal.register_denied" ? "red" : undefined}>{ACTION_TITLES[v] ?? v}</Tag>
      )
    },
    { title: "Объект", dataIndex: "entityType", width: 140 },
    {
      title: "Что изменилось",
      key: "diff",
      render: (_v, r) => {
        const d = diffText(r);
        if (d) return <span style={{ fontSize: 12 }}>{d}</span>;
        if (r.newValue) return <span style={{ fontSize: 12, color: "#555" }}>{r.newValue.slice(0, 200)}</span>;
        return <span style={{ color: "#767676" }}>—</span>;
      }
    }
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Select style={{ width: 220 }} value={action} options={ACTION_OPTIONS} onChange={setAction} />
        <Select style={{ width: 180 }} value={entityType} options={ENTITY_OPTIONS} onChange={setEntityType} />
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Идентификатор объекта"
          aria-label="Идентификатор объекта в аудите"
          style={{ width: 260 }}
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
        />
        <DatePicker.RangePicker
          format="DD.MM.YYYY"
          placeholder={["Дата с", "по"]}
          onChange={(v) =>
            setRange([v?.[0] ? v[0].format("YYYY-MM-DD") : "", v?.[1] ? v[1].format("YYYY-MM-DD") : ""])
          }
        />
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          Обновить
        </Button>
        <Button
          icon={<DownloadOutlined />}
          href={api.auditExportUrl({
            action: action || undefined,
            entityType: entityType || undefined,
            entityId: entityId.trim() || undefined,
            dateFrom: range[0] || undefined,
            dateTo: range[1] || undefined
          })}
          target="_blank"
        >
          Выгрузить в Excel
        </Button>
      </Space>

      <div style={{ color: "#595959", fontSize: 12 }}>
        Всего записей: {total}. Журнал аудита только дополняется: изменить или удалить запись нельзя.
      </div>

      <Table<AuditEntry>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={entries}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        locale={{ emptyText: "Записей нет" }}
      />
    </Space>
  );
}