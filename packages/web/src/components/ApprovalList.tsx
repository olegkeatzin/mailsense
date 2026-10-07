import { useEffect, useState } from "react";
import { Alert, Button, Card, DatePicker, Empty, Input, Modal, Select, Space, Spin, Tag, Tooltip, Typography, message } from "antd";
import dayjs from "dayjs";
import { resolutionApi } from "../api";
import { useStore } from "../store";
import { PRIORITY_TITLES, RESOLUTION_STATUS_TITLES, type AssigneeKind, type Resolution, type ResolutionPriority } from "../resolutionTypes";
import type { Permission, User } from "../types";
import { SuggestedAssignees } from "./SuggestedAssignees";
import { DeadlinePresets } from "./DeadlinePresets";
import { GOLD_STYLE } from "./notifications/colors";
import { humanError } from "../utils/humanError";

/**
 * Очередь подписанта: что ждёт его решения (этап 3).
 *
 * Ключевое: руководитель **пишет резолюцию здесь же** — текст, исполнители, срок, приоритет.
 * Он не утверждает чужой черновик, а принимает решение сам (Р8). Раньше экран позволял только
 * нажать «Утвердить», и назначить исполнителя было нечем.
 *
 * Два вида строк:
 *  - «на утверждении» — обычный путь, руководитель решает здесь;
 *  - «ответ подписанта — ждёт подтверждения» — способ В: он уже ответил письмом, аппарат проверяет.
 */
export function ApprovalList({ mode = "approve" }: { mode?: "approve" | "confirm" }) {
  // Режим `confirm` — рабочее место АППАРАТА: он подтверждает разбор ответов, пришедших
  // письмом. Очередь подписанта требует права подписи, у аппарата его нет — поэтому
  // отдельный маршрут, а не та же выборка.
  const isConfirm = mode === "confirm";
  const can = useStore((s) => s.can);
  /** Право на саму очередь: подписант — approve, аппарат (подтверждение разбора) — dispatch. */
  const requiredPermission: Permission = isConfirm ? "resolution.dispatch" : "resolution.approve";
  const allowed = can(requiredPermission);
  /** Справочник людей — управленческий вид: тот, кто поручает, или тот, кто подписывает. */
  const canLoadCandidates = can("resolution.create") || can("resolution.approve");
  /** Подтверждение разбора — работа АППАРАТА, а не подписанта (D4). */
  const canConfirm = can("resolution.dispatch");
  const [items, setItems] = useState<Resolution[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** Черновик решения по каждой резолюции: пока не утвердили — правится свободно. */
  const [forms, setForms] = useState<Record<string, { text: string; ids: string[]; resp: string | null; priority: ResolutionPriority; deadline: string | null }>>({});

  function patchForm(id: string, patch: Partial<{ text: string; ids: string[]; resp: string | null; priority: ResolutionPriority; deadline: string | null }>) {
    setForms((f) => ({ ...f, [id]: { ...f[id], ...patch } }));
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      // Кандидатов берём из маршрута резолюций: `/api/users` доступен только администратору,
      // и экран руководителя из-за него оставался пустым.
      const [queue, list] = await Promise.all([
        isConfirm ? resolutionApi.forConfirmation() : resolutionApi.forApproval(),
        // Без права на справочник запрос не отправляем: иначе 403 в консоли у роли без прав.
        canLoadCandidates ? resolutionApi.executorCandidates() : Promise.resolve([] as User[])
      ]);
      setItems(queue.items);
      setUsers(list as unknown as User[]);
      // Заполняем формы тем, что уже есть: у пересланного письма текст пуст — руководитель напишет.
      const init: typeof forms = {};
      for (const r of queue.items) {
        // Для ответа письмом подставляем ТЕКСТ ДИРЕКТОРА: он и есть резолюция.
        // Иначе аппарату пришлось бы перепечатывать формулировку руководителя —
        // а подтверждать нужно его слова, не пересказ.
        const replyEntry = r.history.filter((h) => h.step === "approved" && h.method === "email").pop();
        const replyText = (replyEntry?.comment ?? "").trim();
        init[r.id] = {
          text: r.text || replyText,
          ids: r.assignees.map((a) => a.userId),
          resp: r.assignees.find((a) => a.kind === "responsible")?.userId ?? null,
          priority: r.priority,
          deadline: r.deadline
        };
      }
      setForms(init);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Права нет — данных раздела не запрашиваем вовсе: это не «спрятать кнопку», а не ходить.
    if (!allowed) {
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, allowed]);

  /** Подтверждение разбора: без текста и исполнителя поручение не уйдёт (сервер тоже проверит). */
  function confirm(r: Resolution) {
    const f = forms[r.id];
    if (!f?.text.trim()) {
      message.warning("Текст резолюции пуст — впишите формулировку руководителя");
      return;
    }
    if (!f.ids.length) {
      message.warning("Назначьте исполнителя — по одному тексту поручение не уйдёт");
      return;
    }
    void act(
      r.id,
      () =>
        resolutionApi.confirm(r.id, r.approvedBy, {
          text: f.text,
          assignees: f.ids.map((uid) => ({
            userId: uid,
            kind: (uid === f.resp ? "responsible" : "coexecutor") as AssigneeKind
          })),
          priority: f.priority,
          deadline: f.deadline
        }),
      "Утверждение подтверждено — осталось отправить исполнителям"
    );
  }

  async function act(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusyId(id);
    setError("");
    try {
      await fn();
      message.success(ok);
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Утверждение вместе с решением: текст и исполнители уходят одним запросом.
   *
   * ⚠️ Спрашиваем подтверждение: отменить утверждение нельзя, дальше аппарат отправляет
   * поручение исполнителям. В окне показываем то, что человек утверждает — документ,
   * текст, исполнителей и срок: раньше он нажимал кнопку, видя только поля формы.
   */
  function approve(r: Resolution) {
    const f = forms[r.id];
    if (!f?.text.trim()) {
      message.warning("Напишите текст резолюции — поручение без текста уйти не может");
      return;
    }
    if (!f.ids.length) {
      message.warning("Назначьте хотя бы одного исполнителя");
      return;
    }
    const assignees = f.ids
      .map((uid) => users.find((u) => u.id === uid)?.fullName || "исполнитель")
      .join(", ");
    const deadline = f.deadline ? dayjs(f.deadline).format("DD.MM.YYYY") : "без срока";
    const text = f.text.length > 300 ? f.text.slice(0, 300) + "…" : f.text;

    Modal.confirm({
      title: "Утвердить поручение?",
      okText: "Утвердить",
      cancelText: "Отмена",
      width: 520,
      content: (
        <div style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 6 }}>
            <b>{r.documentNumber}</b>
            {" · "}
            {PRIORITY_TITLES[f.priority]}
            {" · срок: "}
            {deadline}
          </div>
          <div style={{ marginBottom: 6, whiteSpace: "pre-wrap" }}>{text}</div>
          <div>
            Исполнители: <b>{assignees}</b>
          </div>
          <div style={{ color: "#595959", marginTop: 8 }}>
            Отменить утверждение нельзя: дальше аппарат отправит поручение исполнителям.
          </div>
        </div>
      ),
      onOk: () =>
        act(
          r.id,
          () =>
            resolutionApi.approve(r.id, {
              text: f.text,
              assignees: f.ids.map((uid) => ({
                userId: uid,
                kind: (uid === f.resp ? "responsible" : "coexecutor") as AssigneeKind
              })),
              priority: f.priority,
              deadline: f.deadline
            }),
          "Утверждено"
        )
    });
  }

  function reject(id: string) {
    let comment = "";
    Modal.confirm({
      title: "Вернуть на доработку",
      content: <Input.TextArea rows={3} placeholder="Что не так" onChange={(e) => (comment = e.target.value)} />,
      onOk: () => {
        if (!comment.trim()) {
          message.warning("Укажите причину возврата");
          return Promise.reject(new Error("нет причины"));
        }
        return act(id, () => resolutionApi.reject(id, comment), "Возвращено на доработку");
      }
    });
  }

  if (!allowed) return <Alert type="error" showIcon message="Недостаточно прав для этого раздела" />;

  if (loading) return <Spin style={{ margin: 24 }} />;

  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {isConfirm ? "Ответы руководителя — подтверждение" : "На утверждении"}
      </Typography.Title>
      {isConfirm ? (
        <div style={{ color: "#595959", fontSize: 12, marginBottom: 8 }}>
          Руководитель ответил письмом. Система нашла ответ в переписке и определила подписавшего
          по адресу отправителя, но утвердить его
          автоматически не может: проверьте формулировку и подтвердите — только после этого
          поручение можно отправить исполнителям.
        </div>
      ) : null}
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {!items.length ? (
        <Empty description="Ничего не ждёт вашего решения" />
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          {items.map((r) => {
            const byEmail = r.status === "email_approval";
            // Поля правит тот, кто действует. В очереди ПОДПИСАНТА ответ, пришедший
            // письмом, — только для чтения: подтверждает его аппарат. А в очереди
            // АППАРАТА те же поля обязаны быть доступны: без исполнителя поручение
            // не уйдёт, а фамилию из письма машина разобрать не может.
            const readOnly = byEmail && !isConfirm;
            const f = forms[r.id] ?? { text: r.text, ids: [], resp: null, priority: r.priority, deadline: r.deadline };
            const reply = r.history.filter((h) => h.step === "approved" && h.method === "email").pop();
            return (
              <Card
                key={r.id}
                size="small"
                title={
                  <Space wrap>
                    <b>{r.documentNumber}</b>
                    <span style={{ color: "#666", fontWeight: 400 }}>{r.documentSummary}</span>
                    {/* Пресет gold даёт 2.76:1 — норма AA не проходит, поэтому свой стиль. */}
                    {byEmail ? <Tag style={GOLD_STYLE}>{RESOLUTION_STATUS_TITLES.email_approval}</Tag> : null}
                  </Space>
                }
              >
                <div style={{ fontSize: 12, color: "#595959", marginBottom: 8 }}>
                  Подготовил: {r.preparedByName || "—"}
                  {r.sourceKind === "forwarded" ? " · письмо направлено руководителю" : ""}
                </div>

                {byEmail ? (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 10 }}
                    /* Имя подписавшего обязательно: подтверждающий должен видеть, ЧЬЁ решение
                       он подтверждает. Определено оно по адресу отправителя ответа. */
                    message={
                      "Подписал: " +
                      (r.approvedByName || "не определён") +
                      " — ответом на письмо. Проверьте, что он действительно утвердил"
                    }
                    description=<div style={{ whiteSpace: "pre-wrap" }}>{(reply?.comment ?? "").slice(0, 600) || "(текст ответа пуст)"}</div>
                  />
                ) : null}

                <div style={{ marginBottom: 4 }}><b>Текст резолюции</b></div>
                <Input.TextArea
                  rows={4}
                  value={f.text}
                  disabled={readOnly}
                  placeholder="Кому и что сделать. Например: Романову Е.С. подготовить ответ в срок до 20.09.2026."
                  onChange={(e) => patchForm(r.id, { text: e.target.value })}
                />

                {!byEmail ? (
                  <div style={{ marginTop: 12 }}>
                    <SuggestedAssignees
                      documentId={r.documentId}
                      onPick={(uid) => patchForm(r.id, { ids: f.ids.includes(uid) ? f.ids : [...f.ids, uid] })}
                    />
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 300px" }}>
                    <div style={{ marginBottom: 4 }}><b>Исполнители</b></div>
                    <Select
                      mode="multiple"
                      style={{ width: "100%" }}
                      placeholder="Выберите из справочника"
                      disabled={readOnly}
                      value={f.ids}
                      optionFilterProp="label"
                      onChange={(v) => {
                        patchForm(r.id, { ids: v, resp: f.resp && v.includes(f.resp) ? f.resp : null });
                      }}
                      options={users.map((u) => ({ value: u.id, label: u.fullName || u.email }))}
                    />
                  </div>
                  <div style={{ flex: "0 0 190px" }}>
                    <div style={{ marginBottom: 4 }}>
                      <b>Ответственный</b>
                      <Tooltip title="Если не выбран, все исполнители равны.">
                        <span style={{ color: "#595959", marginLeft: 4, cursor: "help" }}>?</span>
                      </Tooltip>
                    </div>
                    <Select
                      allowClear
                      style={{ width: "100%" }}
                      placeholder="все равны"
                      disabled={readOnly}
                      value={f.resp ?? undefined}
                      onChange={(v) => patchForm(r.id, { resp: v ?? null })}
                      options={f.ids.map((id) => ({ value: id, label: users.find((u) => u.id === id)?.fullName || id }))}
                    />
                  </div>
                  <div>
                    <div style={{ marginBottom: 4 }}><b>Срок</b></div>
                    <DatePicker
                      value={f.deadline ? dayjs(f.deadline) : null}
                      disabled={readOnly}
                      format="DD.MM.YYYY"
                      placeholder="не указан"
                      onChange={(d) => patchForm(r.id, { deadline: d ? d.format("YYYY-MM-DD") : null })}
                    />
                    {!readOnly ? (
                      // Типовые сроки: даты считает сервер (А9) — своей арифметики нет.
                      <DeadlinePresets onPick={(d) => patchForm(r.id, { deadline: d })} />
                    ) : null}
                  </div>
                  <div>
                    <div style={{ marginBottom: 4 }}><b>Приоритет</b></div>
                    <Select
                      style={{ width: 140 }}
                      value={f.priority}
                      disabled={readOnly}
                      onChange={(v) => patchForm(r.id, { priority: v })}
                      options={(Object.keys(PRIORITY_TITLES) as ResolutionPriority[]).map((p) => ({ value: p, label: PRIORITY_TITLES[p] }))}
                    />
                  </div>
                </div>

                <Space wrap style={{ marginTop: 12 }}>
                  {byEmail ? (
                    // Аппарат НЕ утверждает — директор уже утвердил. Он подтверждает, что
                    // разбор ответа верен. Поэтому и формулировка про подтверждение.
                    // Подписанту этой кнопки быть не должно: он утверждает, а не подтверждает
                    // чужой разбор (нашёл QA: кнопка показывалась роли signer).
                    canConfirm ? (
                      <Button
                        type="primary"
                        loading={busyId === r.id}
                        onClick={() => confirm(r)}
                      >
                        Подтвердить утверждение
                      </Button>
                    ) : (
                      <span style={{ color: "#595959", fontSize: 12 }}>
                        Подтверждает аппарат — у вас нет права подтверждения разбора
                      </span>
                    )
                  ) : (
                    <Button type="primary" loading={busyId === r.id} onClick={() => approve(r)}>Утвердить</Button>
                  )}
                  <Button loading={busyId === r.id} onClick={() => reject(r.id)}>Вернуть на доработку</Button>
                  <Tooltip title="Отправляет исполнителям аппарат — после утверждения.">
                    <span style={{ color: "#595959", fontSize: 12 }}>отправка — на стороне аппарата</span>
                  </Tooltip>
                </Space>
              </Card>
            );
          })}
        </Space>
      )}
    </div>
  );
}