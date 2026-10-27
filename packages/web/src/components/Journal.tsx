import { useCallback, useEffect, useState } from "react";
import { Button, DatePicker, Input, Select, Space, Table, Tag, Tooltip, message } from "antd";
import { DownloadOutlined, ReloadOutlined, SearchOutlined, SettingOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { api } from "../api";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useStore } from "../store";
import { DOCUMENT_STATUS_TITLES, type DocumentListItem, type DocumentStatus } from "../types";
import DocumentCard from "./DocumentCard";
import { DocumentFilesButton } from "./DocumentFiles";
import { humanError } from "../utils/humanError";

/**
 * Журнал регистрации входящих документов.
 *
 * Колонки повторяют бумажный журнал (10 графов): номер по порядку, дата, номер и дата
 * документа, от кого получен, краткое содержание, количество листов, резолюция,
 * кому передано на исполнение, контроль исполнения, номер дела.
 * Графы 7–9 заполняются на этапе резолюций — пока показываем прочерк, чтобы
 * структура журнала была видна целиком.
 */
const STATUS_COLORS: Record<DocumentStatus, string> = {
  new: "default",
  on_resolution: "blue",
  in_progress: "gold",
  executed: "green",
  archived: "purple"
};

const STATUS_OPTIONS = [
  { value: "", label: "Все состояния" },
  { value: "new", label: DOCUMENT_STATUS_TITLES.new },
  { value: "on_resolution", label: DOCUMENT_STATUS_TITLES.on_resolution },
  { value: "in_progress", label: DOCUMENT_STATUS_TITLES.in_progress },
  { value: "executed", label: DOCUMENT_STATUS_TITLES.executed },
  { value: "archived", label: DOCUMENT_STATUS_TITLES.archived }
];

export default function Journal() {
  const can = useStore((s) => s.can);
  const setSection = useStore((s) => s.setSection);

  const [rows, setRows] = useState<DocumentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Переход с канбана резолюций: карточка документа открывается сразу.
  const documentIntent = useStore((s) => s.documentIntent);
  const clearDocumentIntent = useStore((s) => s.clearDocumentIntent);

  useEffect(() => {
    if (!documentIntent) return;
    setOpenId(documentIntent);
    clearDocumentIntent();
  }, [documentIntent, clearDocumentIntent]);

  const [search, setSearch] = useState("");
  // Пока пользователь печатает, запрос не уходит: иначе журнал спрашивается на каждую букву.
  const searchDebounced = useDebouncedValue(search, 300);
  const [status, setStatus] = useState<string>("");
  const [period, setPeriod] = useState<string>("");
  const [range, setRange] = useState<[string, string]>(["", ""]);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const filter = useCallback(
    () => ({
      search: searchDebounced.trim() || undefined,
      status: (status || undefined) as DocumentStatus | undefined,
      period: period || undefined,
      dateFrom: range[0] || undefined,
      dateTo: range[1] || undefined
    }),
    [searchDebounced, status, period, range]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.journal({ ...filter(), limit: pageSize, offset: (page - 1) * pageSize });
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      message.error("Не удалось загрузить журнал: " + humanError(err));
    } finally {
      setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    // Права нет — журнал не запрашивается: иначе 403 в консоли у чужой роли.
    if (!can("journal.view")) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    if (!can("journal.view")) return;
    api
      .journalStatusCounts()
      .then(setCounts)
      .catch(() => setCounts({}));
  }, [reloadKey]);

  /** Годы для фильтра: текущий и несколько предыдущих — журнал ведётся по годам. */
  const yearOptions = (() => {
    const now = new Date().getFullYear();
    const list = [{ value: "", label: "Все годы" }];
    for (let y = now + 1; y >= now - 5; y--) list.push({ value: String(y), label: String(y) });
    return list;
  })();

  const columns: ColumnsType<DocumentListItem> = [
    {
      title: "№",
      key: "n",
      width: 56,
      align: "right",
      render: (_v, _r, i) => (page - 1) * pageSize + i + 1
    },
    {
      title: "Вх. №",
      dataIndex: "regNumber",
      width: 90,
      render: (v: string) => <b>{v}</b>
    },
    {
      title: "Дата рег.",
      dataIndex: "regDate",
      width: 108,
      render: (v: string) => (v ? dayjs(v).format("DD.MM.YYYY") : "")
    },
    {
      title: "Номер и дата документа",
      key: "doc",
      width: 190,
      render: (_v, r) =>
        r.docNumber || r.docDate ? (
          <span>
            {r.docNumber}
            {r.docDate ? " от " + dayjs(r.docDate).format("DD.MM.YYYY") : ""}
          </span>
        ) : (
          <span style={{ color: "#767676" }}>—</span>
        )
    },
    {
      title: "От кого получен",
      dataIndex: "sender",
      width: 200,
      ellipsis: true,
      render: (v: string) => v || <span style={{ color: "#767676" }}>—</span>
    },
    {
      title: "Краткое содержание",
      dataIndex: "summary",
      ellipsis: true,
      render: (v: string, r) => (
        <Tooltip title={v}>
          <span>{v || r.documentName || <span style={{ color: "#767676" }}>—</span>}</span>
        </Tooltip>
      )
    },
    {
      title: "Листов",
      dataIndex: "sheetsCount",
      width: 80,
      align: "right",
      render: (v: number | null) => (v === null ? <span style={{ color: "#767676" }}>—</span> : v)
    },
    /*
      ⚠️ Раньше это были заглушки «—» с подсказкой «заполняется на этапе резолюций»: текст
      поручения, исполнитель и срок жили только в карточке (жалоба заказчика). Теперь список
      отдаёт последнее поручение по документу, и графы заполняются по-настоящему.
    */
    {
      title: (
        <Tooltip title="Последнее поручение по документу">
          <span>Резолюция</span>
        </Tooltip>
      ),
      key: "resolution",
      width: 200,
      render: (_v, r) => {
        const text = r.resolution?.text ?? "";
        if (!text) return <span style={{ color: "#767676" }}>—</span>;
        return (
          <Tooltip title={text}>
            <span>{text.length > 60 ? text.slice(0, 60) + "…" : text}</span>
          </Tooltip>
        );
      }
    },
    {
      title: (
        <Tooltip title="Исполнители поручения и срок исполнения">
          <span>Исполнитель и срок</span>
        </Tooltip>
      ),
      key: "assignee",
      width: 190,
      render: (_v, r) => {
        const names = r.resolution?.assignees ?? [];
        const due = r.resolution?.deadline;
        if (!names.length && !due) return <span style={{ color: "#767676" }}>—</span>;
        return (
          <span style={{ fontSize: 12 }}>
            {names.join(", ")}
            {due ? <span style={{ color: "#595959" }}> · до {dayjs(due).format("DD.MM.YYYY")}</span> : null}
          </span>
        );
      }
    },
    {
      title: "№ дела",
      dataIndex: "caseNumber",
      width: 100,
      render: (v: string | null) => v || <span style={{ color: "#767676" }}>—</span>
    },
    {
      title: "Файлы",
      key: "files",
      width: 100,
      render: (_v, r) => <DocumentFilesButton documentId={r.id} />
    },
    {
      title: "Состояние",
      dataIndex: "status",
      width: 130,
      render: (v: DocumentStatus) => <Tag color={STATUS_COLORS[v]}>{DOCUMENT_STATUS_TITLES[v]}</Tag>
    },
    {
      title: "Кто зарегистрировал",
      dataIndex: "createdByName",
      width: 170,
      ellipsis: true,
      render: (v: string) => v || <span style={{ color: "#767676" }}>—</span>
    }
  ];

  return (
    <div style={{ padding: 16, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Журнал регистрации входящих документов</h3>
        {can("journal.register") && (
          <Button onClick={() => setSection("incoming")}>Входящие на регистрацию</Button>
        )}
        <Button icon={<ReloadOutlined />} onClick={() => setReloadKey((k) => k + 1)}>
          Обновить
        </Button>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          href={api.journalExportUrl(filter())}
          target="_blank"
        >
          Выгрузить в Excel
        </Button>
      </div>

      <Space wrap style={{ marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Поиск по номеру, отправителю, содержанию"
          aria-label="Поиск по журналу регистрации"
          style={{ width: 320 }}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select
          style={{ width: 170 }}
          value={status}
          options={STATUS_OPTIONS}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
        <Select
          style={{ width: 130 }}
          value={period}
          options={yearOptions}
          onChange={(v) => {
            setPeriod(v);
            setPage(1);
          }}
        />
        <DatePicker.RangePicker
          format="DD.MM.YYYY"
          placeholder={["Дата с", "по"]}
          onChange={(v) => {
            setRange([v?.[0] ? v[0].format("YYYY-MM-DD") : "", v?.[1] ? v[1].format("YYYY-MM-DD") : ""]);
            setPage(1);
          }}
        />
        {Object.entries(counts).length > 0 && (
          <span style={{ color: "#595959", marginLeft: 8 }}>
            Всего записей: {Object.values(counts).reduce((a, b) => a + b, 0)}
          </span>
        )}
      </Space>

      <Table<DocumentListItem>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 1700 }}
        onRow={(r) => ({
          onClick: () => setOpenId(r.id),
          // Строку открывают и с клавиатуры: раньше карточка документа была доступна только мышью.
          onKeyDown: (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              setOpenId(r.id);
            }
          },
          tabIndex: 0,
          "aria-label": "Открыть карточку документа " + r.regNumber,
          style: { cursor: "pointer" }
        })}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: false,
          onChange: setPage,
          showTotal: (t) => "Всего: " + t
        }}
        locale={{ emptyText: "В журнале пока нет записей. Зарегистрируйте входящий документ." }}
      />

      <DocumentCard
        documentId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}