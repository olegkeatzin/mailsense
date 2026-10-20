import { useCallback, useEffect, useRef, useState } from "react";
import { Button, DatePicker, Input, Select, Space, Table, Tag, message } from "antd";
import { DownloadOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { api, resolutionApi } from "../api";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import type { AuditEntry } from "../types";
import {
  ACTION_TITLES,
  ENTITY_TITLES,
  actionTitle,
  entityTitle,
  fieldTitle,
  formatValue,
  looksLikeId,
  type ValueRefs
} from "./docflow/labels";
import { humanError } from "../utils/humanError";

/**
 * Аудит действий: кто, когда и что изменил.
 *
 * Нужен, чтобы разобраться, кто внёс неверные данные. Записи только добавляются —
 * из интерфейса их нельзя ни изменить, ни удалить.
 */
// Подписи — из общего модуля: раньше карта жила здесь и в DocumentCard, и тексты расходились.
const ACTION_OPTIONS = [
  { value: "", label: "Все действия" },
  ...Object.entries(ACTION_TITLES).map(([value, label]) => ({ value, label }))
];

const ENTITY_OPTIONS = [
  { value: "", label: "Все объекты" },
  ...Object.entries(ENTITY_TITLES).map(([value, label]) => ({ value, label: label + "ы" }))
];

/** Красным помечаем отказы и неудачи — по известным действиям, а не по сырому ключу. */
const BAD_ACTIONS = new Set(["journal.register_denied", "login_failed", "login_blocked", "resolution.approve_denied", "resolution.dispatch_failed"]);

/**
 * Показываем «было → стало» построчно: так сразу видно, что человек поменял.
 *
 * Значения-идентификаторы разрешаем в человеческое (ящик → адрес, пользователь → ФИО,
 * документ → номер, поручение → «поручение по вхN»). Не удалось — нейтральный текст.
 * Сырой идентификатор остаётся только в подсказке (title), чтобы его можно было найти в базе.
 */
function diffText(entry: AuditEntry, refs: ValueRefs): { text: string; rawIds: string[] } {
  if (!entry.oldValue || !entry.newValue) return { text: "", rawIds: [] };
  try {
    const before = JSON.parse(entry.oldValue) as Record<string, unknown>;
    const after = JSON.parse(entry.newValue) as Record<string, unknown>;
    const parts: string[] = [];
    const rawIds: string[] = [];
    for (const k of Object.keys(after)) {
      if (k === "updatedAt" || k === "createdAt" || k === "id") continue;
      const b = before[k];
      const a = after[k];
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        for (const v of [b, a]) {
          if (looksLikeId(v)) rawIds.push(String(v));
          if (Array.isArray(v)) for (const item of v) if (looksLikeId(item)) rawIds.push(String(item));
        }
        // Имена полей и значения — только человеческие: сырой JSON и UUID в текст не попадают.
        parts.push(
          fieldTitle(k) + ": «" + formatValue(b, k, refs) + "» → «" + formatValue(a, k, refs) + "»"
        );
      }
    }
    return { text: parts.join("; "), rawIds: [...new Set(rawIds)] };
  } catch {
    return { text: "", rawIds: [] };
  }
}

/**
 * Поля, которые менялись: по ключам JSON из записи аудита, человеческими названиями.
 * JSON наружу не отдаём (правило аудита), но перечень полей полезнее заглушки.
 */
function changedFields(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const names = Object.keys(parsed)
      // «field» — технический контейнер аудита, а не поле объекта: в перечне он бесполезен.
      .filter((k) => !["updatedAt", "createdAt", "id", "field"].includes(k))
      .map((k) => fieldTitle(k))
      .filter(Boolean);
    return [...new Set(names)].slice(0, 4).join(", ");
  } catch {
    return "";
  }
}

/**
 * Какие идентификаторы из записей аудита ещё нужно спросить у сервера.
 *
 * Чистая функция без React: её проверяет тест D8. Смысл — уже спрошенные (attempted)
 * и уже известные (known) идентификаторы НЕ возвращаются, иначе экран зацикливается.
 */
export function collectUnresolvedIds(
  entries: AuditEntry[],
  known: Set<string>,
  attempted: Set<string>,
  limit: number
): string[] {
  const pending: string[] = [];
  const collect = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (looksLikeId(v)) {
      const id = String(v);
      if (!known.has(id) && !attempted.has(id)) pending.push(id);
    }
  };
  for (const e of entries) {
    for (const raw of [e.oldValue, e.newValue]) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (k === "updatedAt" || k === "createdAt" || k === "id") continue;
          // Идентификатор письма поручением быть не может: спрашивать о нём /resolutions
          // бессмысленно, а каждый такой вопрос — лишний 404 в консоли.
          if (/email|message/i.test(k)) continue;
          collect(v);
        }
      } catch {
        /* запись аудита может быть не JSON — тогда просто не разрешаем значения */
      }
    }
  }
  return [...new Set(pending)].slice(0, limit);
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
      message.error("Не удалось загрузить аудит: " + humanError(err));
    } finally {
      setLoading(false);
    }
  }, [action, entityType, entityIdDebounced, range]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Справочники для разрешения идентификаторов: ящик → адрес, сотрудник → ФИО,
   * документ → номер. Каждый — ОДИН запрос, дальше смотрим локально.
   */
  const [refs, setRefs] = useState<Map<string, string>>(new Map());
  /** Поручения добираем поштучно: списка всех поручений у интерфейса нет. */
  const [resolutionRefs, setResolutionRefs] = useState<Map<string, string>>(new Map());
  /**
   * Негативный кэш: по каким идентификаторам запрос УЖЕ был (успех или 404/403).
   * Без него неудачный id запрашивался заново на каждый проход эффекта — экран настроек
   * устраивал шторм запросов (~430/с по замеру QA), пока открыт.
   */
  const attemptedIds = useRef<Set<string>>(new Set());
  /** Карта ссылок загружена: до этого добор не запускаем, иначе в /resolutions уходят id сотрудников и ящиков (D9). */
  const [refsLoaded, setRefsLoaded] = useState(false);
  /** Потолок запросов на одну загрузку данных: больше 40 уникальных id не пробуем. */
  const RESOLVE_LIMIT = 40;

  useEffect(() => {
    let alive = true;
    const map = new Map<string, string>();
    void Promise.allSettled([
      api.accounts().then((list) => list.forEach((a) => map.set(a.id, a.username))),
      api.users({ includeInactive: true }).then((list) => list.forEach((u) => map.set(u.id, u.fullName || u.email))),
      api.journal({ limit: 300 }).then((page) => page.items.forEach((d) => map.set(d.id, d.regNumber))),
      // ⚠️ Без ролей идентификаторы в диффе «Смена ролей» не разрешались, и запись выглядела
      // как «Поле: «—» → «изменено (не удалось расшифровать)» (жалоба заказчика).
      api.roles().then((list) => list.forEach((r) => map.set(r.id, r.name)))
    ]).then(() => {
      if (!alive) return;
      setRefs(new Map(map));
      setRefsLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Что осталось неразрешённым — пробуем как поручения. Без прав запрос не пройдёт,
  // и значение честно останется нейтральным: UUID в текст не попадёт ни при каком ответе.
  useEffect(() => {
    // Ждём справочники: без них в добор попадут id, которые поручениями не являются (D9).
    if (!refsLoaded) return;
    const known = new Set<string>([...refs.keys(), ...resolutionRefs.keys()]);
    const unique = collectUnresolvedIds(entries, known, attemptedIds.current, RESOLVE_LIMIT);
    if (!unique.length) return;
    // Помечаем ДО запроса: неудачный id больше не спрашиваем никогда (негативный кэш).
    unique.forEach((id) => attemptedIds.current.add(id));
    let alive = true;
    void Promise.allSettled(
      unique.map((id) => resolutionApi.get(id).then((r) => ({ id, number: r.documentNumber })))
    ).then((results) => {
      if (!alive) return;
      const found = new Map<string, string>();
      for (const res of results) {
        if (res.status === "fulfilled") {
          found.set(res.value.id, "поручение по " + (res.value.number || "документу"));
        }
      }
      if (!found.size) return;
      // Обновляем функцией: тогда сам кэш не нужно держать в зависимостях эффекта,
      // иначе эффект зацикливается (это и была регрессия D8).
      setResolutionRefs((prev) => {
        const next = new Map(prev);
        for (const [k, v] of found) next.set(k, v);
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [entries, refs, refsLoaded]);

  const valueRefs: ValueRefs = {
    resolve: (_field, id) => refs.get(id) ?? resolutionRefs.get(id) ?? null
  };

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
      render: (v: string) => <Tag color={BAD_ACTIONS.has(v) ? "red" : undefined}>{actionTitle(v)}</Tag>
    },
    { title: "Объект", dataIndex: "entityType", width: 140, render: (v: string) => entityTitle(v) },
    {
      title: "Что изменилось",
      key: "diff",
      render: (_v, r) => {
        // Вход — не изменение полей: в колонке «Действие» уже написано «Вход в систему».
        if (r.action === "login") return <span style={{ color: "#767676" }}>—</span>;
        const d = diffText(r, valueRefs);
        // Сырой идентификатор доступен только в подсказке — в тексте его быть не должно.
        if (d.text) {
          return (
            <span style={{ fontSize: 12 }} title={d.rawIds.length ? d.rawIds.join(", ") : undefined}>
              {d.text}
            </span>
          );
        }
        // JSON в интерфейс не показываем, но и заглушка «изменение записано в аудите» бесполезна:
        // человек и так в журнале. Показываем, КАКИЕ поля менялись.
        if (r.newValue) {
          const fields = changedFields(r.newValue);
          if (fields) return <span style={{ fontSize: 12, color: "#555" }}>Изменены поля: {fields}</span>;
        }
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
          title="Идентификатор можно скопировать из адреса карточки документа"
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