import { useCallback, useEffect, useState } from "react";
import { Alert, Button, DatePicker, Descriptions, Drawer, Empty, Input, InputNumber, List, Modal, Select, Space, Tag, Timeline, message } from "antd";
import { SaveOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api, resolutionApi } from "../api";
import { ResolutionModal } from "./ResolutionModal";
import { SOON_STYLE } from "./notifications/colors";
import { ResolutionEmails } from "./ResolutionEmails";
import {
  PRIORITY_TITLES,
  RESOLUTION_STATUS_TITLES,
  type Resolution
} from "../resolutionTypes";
import { useStore } from "../store";
import { formatAssignees } from "../utils";
import { actionTitle, fieldTitle, formatValue } from "./docflow/labels";
import {
  DOCUMENT_STATUS_TITLES,
  type AuditEntry,
  type DocumentCard as DocCard,
  type DocumentStatus,
  type User
} from "../types";
import { humanError } from "../utils/humanError";
import {
  EdmsMailSelect,
  edmsActionOptions,
  edmsMailProblem,
  edmsSendErrorText,
  isEdmsMailError,
  preferredActionAccountId,
  useEdmsMail
} from "./edmsMail";

/**
 * Карточка документа: графы журнала, связанные письма и история изменений.
 *
 * История читается из аудита по этому документу — видно, кто и что менял.
 */
interface Props {
  documentId: string | null;
  onClose: () => void;
  onChanged?: () => void;
}

const STATUS_OPTIONS = (Object.keys(DOCUMENT_STATUS_TITLES) as DocumentStatus[]).map((s) => ({
  value: s,
  label: DOCUMENT_STATUS_TITLES[s]
}));

export default function DocumentCard({ documentId, onClose, onChanged }: Props) {
  const can = useStore((s) => s.can);
  const [doc, setDoc] = useState<DocCard | null>(null);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [editing, setEditing] = useState<Resolution | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  /** Поиск руководителя: список не показываем целиком — только совпадения по вводу. */
  const [signerQuery, setSignerQuery] = useState("");
  const [forwardTo, setForwardTo] = useState<string | null>(null);
  const [forwardBusy, setForwardBusy] = useState(false);
  /** Кандидаты на получение письма: только те, кто вправе подписывать. */
  const [signers, setSigners] = useState<User[]>([]);

  const editable = can("journal.edit");
  /**
   * Ящик для писем СЭД (T53). Показываем выбор только там, где работник отправляет
   * (аппарат): у исполнителя выбора в действиях нет — он задаётся в личных настройках.
   */
  const canDispatch = can("resolution.dispatch");
  /** Переход в личные настройки по ссылке из отказа («Выбрать другой ящик»). */
  const openSettings = useStore((s) => s.openSettings);
  const edms = useEdmsMail(canDispatch);
  const [edmsAccountId, setEdmsAccountId] = useState<string | null>(null);

  useEffect(() => {
    const settings = edms.settings;
    if (!settings) return;
    // Список для действий = служебный + выбранный личный (D-T55). Сменил работник выбор
    // в личных настройках — вместе с ним меняются список и предвыбранное значение.
    setEdmsAccountId((prev) => {
      const options = edmsActionOptions(settings);
      if (prev && options.some((o) => o.id === prev)) return prev;
      // Выбранный ящик мог исчезнуть: показываем его человеческой строкой, а не теряем молча.
      return preferredActionAccountId(settings) ?? settings.accountId ?? null;
    });
  }, [edms.settings]);

  /** Перечитывает резолюции документа: после каждого шага список меняется. */
  const loadResolutions = useCallback(async () => {
    if (!documentId) return;
    try {
      setResolutions(await resolutionApi.byDocument(documentId));
    } catch {
      setResolutions([]);
    }
  }, [documentId]);

  useEffect(() => {
    if (!forwardOpen) return;
    // Право подписи дают роли «Подписант» и «Руководитель» — по ним и фильтруем.
    // Список подписантов требует `/api/users` — он только для администратора. Показываем
    // всех действующих: руководитель выбирается из них, ошибиться нечем — право подписи
    // всё равно проверит сервер при утверждении.
    resolutionApi
      .executorCandidates()
      .then((list) => setSigners(list as unknown as User[]))
      .catch(() => setSigners([]));
  }, [forwardOpen]);

  /**
   * Отказ по ящику объясняем и сразу даём путь починить: ссылка открывает настройки
   * на вкладке «Личные настройки», где лежит «Почта для СЭД». Иначе аппарат оказывается
   * заблокирован и идёт писать в поддержку.
   */
  const showMailError = (e: unknown) => {
    const text = edmsSendErrorText(e);
    if (!isEdmsMailError(e)) {
      message.error(text);
      return;
    }
    message.error({
      content: (
        <span>
          {text}{" "}
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: "auto" }}
            onClick={() => openSettings("profile")}
          >
            Выбрать другой ящик
          </Button>
        </span>
      ),
      duration: 8
    });
  };

  async function actResolution(id: string, fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      message.success(ok);
      await loadResolutions();
      onChanged?.();
    } catch (e) {
      showMailError(e);
    }
  }

  function statusColor(s: Resolution["status"]): string {
    if (s === "draft") return "default";
    if (s === "pending_approval") return "gold";
    if (s === "email_approval") return "orange";
    if (s === "approved") return "blue";
    if (s === "sent") return "geekblue";
    if (s === "done") return "green";
    return "red";
  }

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    try {
      const d = await api.document(documentId);
      setDoc(d);
      setDraft({
        docNumber: d.docNumber,
        docDate: d.docDate,
        sender: d.sender,
        summary: d.summary,
        sheetsCount: d.sheetsCount,
        caseNumber: d.caseNumber,
        documentName: d.documentName,
        status: d.status
      });
      // Историю изменений запрашиваем только при праве `audit.view`: у руководителя его нет,
      // и карточка сыпала 403 в консоль (заметно при разборе любого другого сбоя).
      if (can("audit.view")) {
        const audit = await api.audit({ entityType: "document", entityId: documentId, limit: 50 });
        setHistory(audit.entries);
      } else {
        setHistory([]);
      }
      await loadResolutions();
    } catch (err) {
      message.error("Не удалось открыть карточку: " + humanError(err));
    } finally {
      setLoading(false);
    }
    // Полный список зависимостей: без can/loadResolutions карточка могла остаться
    // с прежними правами и прежним списком резолюций после смены документа.
  }, [documentId, can, loadResolutions]);

  useEffect(() => {
    if (documentId) void load();
    else {
      setDoc(null);
      setHistory([]);
    }
  }, [documentId, load]);

  const save = async () => {
    if (!doc) return;
    setSaving(true);
    try {
      await api.updateDocument(doc.id, draft);
      message.success("Изменения сохранены");
      await load();
      onChanged?.();
    } catch (err) {
      message.error(humanError(err));
    } finally {
      setSaving(false);
    }
  };

  const fmtDate = (v: string | null | undefined) => (v ? dayjs(v).format("DD.MM.YYYY") : "");

  /**
   * Автора регистрации берём из истории: запись аудита создаётся в той же
   * транзакции, что и документ, поэтому она есть всегда и является первоисточником.
   */
  const registrar = history.find((h) => h.action === "journal.register");

  /** Показываем, что именно изменилось: «было → стало» по каждому полю. */
  const diffOf = (entry: AuditEntry): string => {
    if (!entry.oldValue || !entry.newValue) return "";
    try {
      const before = JSON.parse(entry.oldValue) as Record<string, unknown>;
      const after = JSON.parse(entry.newValue) as Record<string, unknown>;
      const keys = ["docNumber", "docDate", "sender", "summary", "sheetsCount", "caseNumber", "documentName", "status"];
      const parts: string[] = [];
      for (const k of keys) {
        if (String(before[k] ?? "") !== String(after[k] ?? "")) {
          // Имена полей и значения — человеческие: status переводится, JSON не показываем.
          parts.push(fieldTitle(k) + ": «" + formatValue(before[k], k) + "» → «" + formatValue(after[k], k) + "»");
        }
      }
      return parts.join("; ");
    } catch {
      return "";
    }
  };

  return (
    <Drawer
      title={doc ? "Документ " + doc.regNumber : "Документ"}
      width={720}
      open={!!documentId}
      onClose={onClose}
      extra={
        editable && (
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
            Сохранить
          </Button>
        )
      }
    >
      {!doc ? (
        <Empty description={loading ? "Загрузка…" : "Документ не найден"} />
      ) : (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="Входящий номер">{doc.regNumber}</Descriptions.Item>
            <Descriptions.Item label="Дата регистрации">{fmtDate(doc.regDate)}</Descriptions.Item>
            <Descriptions.Item label="Номер документа">
              {editable ? (
                <Input
                  value={String(draft.docNumber ?? "")}
                  onChange={(e) => setDraft({ ...draft, docNumber: e.target.value })}
                />
              ) : (
                doc.docNumber || "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Дата документа">
              {editable ? (
                // ⚠️ Дата — формой даты, а не текстом: «ГГГГ-ММ-ДД» руками набирали с опечатками
                // (жалоба заказчика). В базе по-прежнему YYYY-MM-DD.
                <DatePicker
                  style={{ width: "100%" }}
                  format="DD.MM.YYYY"
                  placeholder="ДД.ММ.ГГГГ"
                  allowClear
                  value={draft.docDate ? dayjs(String(draft.docDate)) : null}
                  onChange={(d) => setDraft({ ...draft, docDate: d ? d.format("YYYY-MM-DD") : null })}
                />
              ) : (
                fmtDate(doc.docDate) || "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="От кого получен" span={2}>
              {editable ? (
                <Input value={String(draft.sender ?? "")} onChange={(e) => setDraft({ ...draft, sender: e.target.value })} />
              ) : (
                doc.sender || "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Краткое содержание" span={2}>
              {editable ? (
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  value={String(draft.summary ?? "")}
                  onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                />
              ) : (
                doc.summary || "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Количество листов">
              {editable ? (
                <InputNumber
                  min={0}
                  value={draft.sheetsCount as number | null}
                  onChange={(v) => setDraft({ ...draft, sheetsCount: v })}
                />
              ) : (
                doc.sheetsCount ?? "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Номер дела">
              {editable ? (
                <Input
                  value={String(draft.caseNumber ?? "")}
                  onChange={(e) => setDraft({ ...draft, caseNumber: e.target.value || null })}
                />
              ) : (
                doc.caseNumber || "—"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Состояние" span={2}>
              {editable ? (
                <Select
                  style={{ width: 220 }}
                  value={String(draft.status ?? doc.status)}
                  options={STATUS_OPTIONS}
                  onChange={(v) => setDraft({ ...draft, status: v })}
                />
              ) : (
                <Tag>{DOCUMENT_STATUS_TITLES[doc.status]}</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Зарегистрировал" span={2}>
              {registrar ? (
                <span>
                  <b>{registrar.userName || "система"}</b> · {dayjs(registrar.createdAt).format("DD.MM.YYYY HH:mm")}
                </span>
              ) : (
                "—"
              )}
            </Descriptions.Item>
          </Descriptions>

          {/* Резолюции: подготовка, утверждение, отправка (этап 3). */}
          <div>
            <Space style={{ marginBottom: 8 }} wrap>
              <h4 style={{ margin: 0 }}>Резолюции</h4>
              {/* Основной путь: аппарат направляет письмо, решение принимает руководитель. */}
              {can("resolution.dispatch") ? (
                <Button size="small" type="primary" onClick={() => setForwardOpen(true)}>
                  Направить руководителю
                </Button>
              ) : null}
              {/* Запасной путь: аппарат сам готовит черновик. */}
              {can("resolution.create") ? (
                <Button size="small" onClick={() => setResolutionOpen(true)}>
                  Подготовить черновик
                </Button>
              ) : null}
            </Space>
            {!resolutions.length ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Резолюций нет" />
            ) : (
              <List
                size="small"
                dataSource={resolutions}
                renderItem={(r) => (
                  <List.Item>
                    <Space direction="vertical" size={2} style={{ width: "100%" }}>
                      <Space wrap size={4}>
                        <Tag color={statusColor(r.status)}>{RESOLUTION_STATUS_TITLES[r.status]}</Tag>
                        <Tag color={r.priority === "urgent" ? "red" : r.priority === "important" ? "orange" : "default"}>
                          {PRIORITY_TITLES[r.priority]}
                        </Tag>
                        {r.deadline ? (
                          <span style={{ fontSize: 12 }}>срок {dayjs(r.deadline).format("DD.MM.YYYY")}</span>
                        ) : (
                          <Tag style={SOON_STYLE}>срок не указан</Tag>
                        )}
                      </Space>
                      <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{r.text}</div>
                      <div style={{ fontSize: 12, color: "#666" }}>
                        Исполнители: {formatAssignees(r.assignees)}
                      </div>
                      <ResolutionEmails resolution={r} />
                      <div style={{ fontSize: 11, color: "#595959" }}>
                        подготовил: {r.preparedByName || "—"}
                        {r.approvedByName ? " · утвердил: " + r.approvedByName : ""}
                        {r.dispatchedByName ? " · отправил: " + r.dispatchedByName : ""}
                      </div>
                      <Space wrap size={4}>
                        {r.status === "draft" && can("resolution.create") ? (
                          <>
                            <Button size="small" onClick={() => { setEditing(r); setResolutionOpen(true); }}>Править</Button>
                            <Button size="small" type="primary" onClick={() => actResolution(r.id, () => resolutionApi.requestApproval(r.id), "Отправлено на утверждение")}>
                              На утверждение
                            </Button>
                          </>
                        ) : null}
                        {/* Закрытие — аппарат: исполнитель мог отчитаться письмом или лично. */}
                        {r.status === "sent" && can("resolution.dispatch") ? (
                          <Button
                            size="small"
                            onClick={() => {
                              let comment = "";
                              Modal.confirm({
                                title: "Закрыть поручение",
                                content: (
                                  <Input.TextArea
                                    rows={3}
                                    placeholder="На каком основании закрываете: доклад, письмо, личный отчёт"
                                    onChange={(e) => (comment = e.target.value)}
                                  />
                                ),
                                onOk: async () => {
                                  if (!comment.trim()) {
                                    message.warning("Укажите основание — оно попадёт в историю");
                                    return Promise.reject(new Error("нет основания"));
                                  }
                                  await actResolution(r.id, () => resolutionApi.close(r.id, comment), "Поручение закрыто");
                                }
                              });
                            }}
                          >
                            Закрыть
                          </Button>
                        ) : null}

                        {/* Отправка — только аппарат и только после утверждения. */}
                        {r.status === "approved" && can("resolution.dispatch") ? (
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => {
                              // Без выбранного ящика письмо не уходит: «первый подходящий» не подставляем.
                              const problem = edmsMailProblem(edms.settings);
                              if (problem) {
                                message.warning(problem);
                                return;
                              }
                              void actResolution(
                                r.id,
                                () => resolutionApi.dispatch(r.id, edmsAccountId ?? undefined),
                                "Отправлено исполнителям"
                              );
                            }}
                          >
                            Отправить исполнителям
                          </Button>
                        ) : null}
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </div>

          <div>
            <h4 style={{ marginBottom: 8 }}>Связанные письма</h4>
            {doc.emails.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Писем не привязано" />
            ) : (
              <List
                size="small"
                dataSource={doc.emails}
                renderItem={(e) => (
                  <List.Item>
                    <span style={{ color: "#595959", marginRight: 8 }}>{e.role === "source" ? "входящее" : e.role}</span>
                    {/* Внутренний идентификатор письма человеку бесполезен: показываем, когда привязано. */}
                    <span style={{ color: "#595959", fontSize: 12 }}>
                      {e.linkedAt ? "привязано " + dayjs(e.linkedAt).format("DD.MM.YYYY HH:mm") : "привязано"}
                    </span>
                  </List.Item>
                )}
              />
            )}
          </div>

          <div>
            <h4 style={{ marginBottom: 8 }}>История изменений</h4>
            {!can("audit.view") ? (
              <div style={{ color: "#595959", fontSize: 12, marginBottom: 8 }}>
                История доступна пользователям с правом просмотра аудита.
              </div>
            ) : null}
            {history.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Изменений не было" />
            ) : (
              <Timeline
                items={history.map((h) => {
                  const diff = diffOf(h);
                  return {
                    children: (
                      <div>
                        <div>
                          <b>{h.userName || "система"}</b> · {actionTitle(h.action)} · 
                          {dayjs(h.createdAt).format("DD.MM.YYYY HH:mm:ss")}
                        </div>
                        {diff && <div style={{ color: "#555", fontSize: 12 }}>{diff}</div>}
                      </div>
                    )
                  };
                })}
              />
            )}
          </div>
        </Space>
      )}

      {/* Кому направить: только те, у кого есть право подписи. */}
      <Modal
        open={forwardOpen}
        title="Направить письмо руководителю"
        okText="Направить"
        confirmLoading={forwardBusy}
        onCancel={() => setForwardOpen(false)}
        onOk={async () => {
          if (!forwardTo) {
            message.warning("Выберите руководителя");
            return;
          }
          // Ящик обязателен: без него не отправляем и говорим, что сделать.
          const problem = edmsMailProblem(edms.settings);
          if (problem) {
            message.warning(problem);
            return;
          }
          setForwardBusy(true);
          try {
            const r = await resolutionApi.forward(documentId ?? "", forwardTo, edmsAccountId ?? undefined);
            message.success("Письмо направлено: " + (r.sentTo ?? ""));
            setForwardOpen(false);
            await loadResolutions();
            onChanged?.();
          } catch (e) {
            showMailError(e);
          } finally {
            setForwardBusy(false);
          }
        }}
      >
        <p style={{ color: "#666", fontSize: 13 }}>
          Письмо уйдёт на адрес руководителя из каталога, вместе с кратким содержанием.
          Резолюцию — кому и что поручить — он напишет сам.
        </p>
        <div style={{ marginBottom: 8 }}>
          {/* Причину показываем сразу в окне: «выберите ящик» человек должен видеть до нажатия. */}
          {edmsMailProblem(edms.settings) ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message={edmsMailProblem(edms.settings)}
            />
          ) : null}
          <EdmsMailSelect
            value={edmsAccountId}
            onChange={setEdmsAccountId}
            settings={edms.settings}
            loading={edms.loading}
          />
        </div>
        {/*
          ⚠️ Автокомплит, а не список всех сотрудников: на предприятии их сотни, и открытый
          список не давал ничего выбрать (жалоба заказчика). Пока не начали печатать —
          подсказка; совпадения ограничены 50, чтобы окно не тормозило.
        */}
        <Select
          style={{ width: "100%" }}
          aria-label="Кому направить"
          showSearch
          placeholder="Начните вводить фамилию или адрес"
          value={forwardTo ?? undefined}
          onChange={(v) => setForwardTo(v)}
          onSearch={setSignerQuery}
          filterOption={(input, option) =>
            String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())
          }
          options={
            signerQuery.trim()
              ? signers
                  .filter((u) => (u.fullName || u.email).toLowerCase().includes(signerQuery.trim().toLowerCase()))
                  .slice(0, 50)
                  .map((u) => ({ value: u.id, label: u.fullName || u.email }))
              : []
          }
          notFoundContent={
            signerQuery.trim()
              ? "Никого не нашли — проверьте фамилию"
              : "Начните вводить фамилию или адрес — список появится по совпадению"
          }
        />
      </Modal>

      {/* Модалка вынесена наружу условия: она нужна и когда карточка ещё грузится. */}
      <ResolutionModal
        open={resolutionOpen}
        documentId={documentId ?? ""}
        documentNumber={doc?.regNumber ?? ""}
        documentSummary={doc?.summary ?? doc?.documentName ?? ""}
        resolution={editing}
        onClose={() => {
          setResolutionOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          void loadResolutions();
          onChanged?.();
        }}
      />
    </Drawer>
  );
}