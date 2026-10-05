import { useEffect, useState } from "react";
import { Alert, Button, DatePicker, Input, Modal, Select, Space, Tag, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { resolutionApi } from "../api";
import { PRIORITY_TITLES, type AssigneeKind, type Resolution, type ResolutionPriority } from "../resolutionTypes";
import type { User } from "../types";
import { SuggestedAssignees } from "./SuggestedAssignees";

/**
 * Подготовка резолюции аппаратом (этап 3).
 *
 * ИИ предлагает ТОЛЬКО текст: исполнителей и срок вписывает человек (Р7).
 * Кнопки намеренно разделены — «сохранить черновик» и «отправить на утверждение»:
 * черновик можно отложить, а отправка необратима, текст после неё менять нельзя.
 */
export function ResolutionModal(props: {
  open: boolean;
  documentId: string;
  documentNumber: string;
  documentSummary: string;
  /** Если передан — правим существующий черновик, а не создаём новый. */
  resolution?: Resolution | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { open, documentId, documentNumber, documentSummary, resolution, onClose, onSaved } = props;
  const [text, setText] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceKind, setSourceKind] = useState<"manual" | "ai">("manual");
  const [priority, setPriority] = useState<ResolutionPriority>("normal");
  const [deadline, setDeadline] = useState<string | null>(null);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [responsibleId, setResponsibleId] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    // Не `api.users()`: он только для администратора, а исполнителей выбирает аппарат.
    resolutionApi.executorCandidates().then((l) => setUsers(l as unknown as User[])).catch(() => setUsers([]));
    if (resolution) {
      setText(resolution.text);
      setSourceText(resolution.sourceText);
      setSourceKind(resolution.sourceKind === "ai" ? "ai" : "manual");
      setPriority(resolution.priority);
      setDeadline(resolution.deadline);
      setAssigneeIds(resolution.assignees.map((a) => a.userId));
      setResponsibleId(resolution.assignees.find((a) => a.kind === "responsible")?.userId ?? null);
    } else {
      setText("");
      setSourceText("");
      setSourceKind("manual");
      setPriority("normal");
      setDeadline(null);
      setAssigneeIds([]);
      setResponsibleId(null);
    }
  }, [open, resolution]);

  const assignees = (): Array<{ userId: string; kind: AssigneeKind }> =>
    assigneeIds.map((id) => ({
      userId: id,
      kind: id === responsibleId ? ("responsible" as AssigneeKind) : ("coexecutor" as AssigneeKind)
    }));

  async function suggest() {
    setAiBusy(true);
    setError("");
    try {
      const r = await resolutionApi.draft(documentId);
      if (!r.text) {
        setError(
          r.reason === "no_email"
            ? "У документа нет письма-источника (бумажный входящий) — предложить нечего, напишите текст сами."
            : "Модель не вернула текст. Напишите резолюцию сами или проверьте настройки ИИ."
        );
        return;
      }
      setText(r.text);
      // Исходный текст храним отдельно: на нём будет учиться будущая подсказка.
      setSourceText(r.text);
      setSourceKind("ai");
      message.success("Предложение готово — проверьте и поправьте");
    } catch (e) {
      setError("Не удалось получить предложение: " + (e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  async function save(): Promise<string | null> {
    if (!text.trim()) {
      setError("Текст резолюции пуст");
      return null;
    }
    if (!assigneeIds.length) {
      setError("Укажите хотя бы одного исполнителя");
      return null;
    }
    const payload = { text, priority, deadline, assignees: assignees() };
    if (resolution) {
      await resolutionApi.update(resolution.id, payload);
      return resolution.id;
    }
    const created = await resolutionApi.create({ documentId, ...payload, sourceText, sourceKind });
    return created.id;
  }

  async function onSaveDraft() {
    setBusy(true);
    setError("");
    try {
      await save();
      message.success("Черновик сохранён");
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onSendToApproval() {
    setBusy(true);
    setError("");
    try {
      const id = await save();
      if (!id) return;
      await resolutionApi.requestApproval(id);
      message.success("Отправлено на утверждение");
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={"Резолюция по документу " + (documentNumber || "без номера")}
      width={760}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>Отмена</Button>,
        <Button key="draft" loading={busy} onClick={onSaveDraft}>Сохранить черновик</Button>,
        <Button key="send" type="primary" loading={busy} danger onClick={onSendToApproval}>
          Отправить на утверждение
        </Button>
      ]}
    >
      {documentSummary ? (
        <div style={{ marginBottom: 12, color: "#666", fontSize: 13 }}>{documentSummary}</div>
      ) : null}

      {error ? <Alert type="warning" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <b>Текст резолюции</b>
        {sourceKind === "ai" ? <Tag color="blue">предложено ИИ</Tag> : null}
        <Button size="small" loading={aiBusy} onClick={suggest} style={{ marginLeft: "auto" }}>
          Предложить текст (ИИ)
        </Button>
      </div>
      <Input.TextArea
        rows={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="1. Подготовить… 2. Направить…"
      />

      <div style={{ marginTop: 16 }}>
        <SuggestedAssignees
          documentId={documentId}
          onPick={(uid) => setAssigneeIds((ids) => (ids.includes(uid) ? ids : [...ids, uid]))}
        />
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <div style={{ marginBottom: 4 }}><b>Исполнители</b></div>
          <Select
            mode="multiple"
            style={{ width: "100%" }}
            placeholder="Выберите из справочника"
            value={assigneeIds}
            onChange={(v) => {
              setAssigneeIds(v);
              // Ответственный мог быть снят из списка — тогда сбрасываем его.
              if (responsibleId && !v.includes(responsibleId)) setResponsibleId(null);
            }}
            optionFilterProp="label"
            options={users.map((u) => ({ value: u.id, label: u.fullName || u.email }))}
          />
        </div>
        <div style={{ flex: "0 0 200px" }}>
          <div style={{ marginBottom: 4 }}>
            <b>Ответственный</b>
            <Tooltip title="Если не выбран, все исполнители равны: задача закрывается, когда отчитались все.">
              <span style={{ color: "#999", marginLeft: 4, cursor: "help" }}>?</span>
            </Tooltip>
          </div>
          <Select
            allowClear
            style={{ width: "100%" }}
            placeholder="все равны"
            value={responsibleId ?? undefined}
            onChange={(v) => setResponsibleId(v ?? null)}
            options={assigneeIds.map((id) => ({
              value: id,
              label: users.find((u) => u.id === id)?.fullName || id
            }))}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <div>
          <div style={{ marginBottom: 4 }}>
            <b>Срок</b>
            <Tooltip title="Срок вписывает человек: модель его не назначает (Р7).">
              <span style={{ color: "#999", marginLeft: 4, cursor: "help" }}>?</span>
            </Tooltip>
          </div>
          <Space>
            <DatePicker
              value={deadline ? dayjs(deadline) : null}
              onChange={(d) => setDeadline(d ? d.format("YYYY-MM-DD") : null)}
              format="DD.MM.YYYY"
              placeholder="не указан"
            />
            {!deadline ? <Tag color="orange">не указан — подсветится аппарату</Tag> : null}
          </Space>
        </div>
        <div>
          <div style={{ marginBottom: 4 }}><b>Приоритет</b></div>
          <Select
            style={{ width: 160 }}
            value={priority}
            onChange={setPriority}
            options={(Object.keys(PRIORITY_TITLES) as ResolutionPriority[]).map((p) => ({
              value: p,
              label: PRIORITY_TITLES[p]
            }))}
          />
        </div>
      </div>
    </Modal>
  );
}