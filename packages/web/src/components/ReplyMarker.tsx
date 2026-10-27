import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Tag, message } from "antd";
import dayjs from "dayjs";
import { parseTypedDate } from "../utils/deadlineInput";
import { RobotOutlined } from "@ant-design/icons";
import { resolutionApi } from "../api";
import { useStore } from "../store";
import type { AssigneeKind, ReplyContextItem } from "../resolutionTypes";
import { humanError } from "../utils/humanError";

/**
 * Разметка письма в почте: человек говорит, что это за письмо (Р9, этап 4).
 *
 * ⚠️ **Система этого не решает.** Ни при сканировании ящика, ни при открытии письма: определяет
 * человек, прочитав письмо. Система сообщает только ФАКТ из заголовков — что письмо отвечает
 * в переписке по такому-то поручению.
 *
 * ⚠️ Этап могли пройти в Outlook. Поэтому аппарат подтверждает чужие ответы, руководитель
 * утверждает свою резолюцию сам, а исполнитель сам регистрирует свой отчёт.
 *
 * ⚠️ **ИИ не классифицирует.** Он вызывается кнопкой «Заполнить с помощью ИИ» и только готовит
 * черновик полей, которые человек проверит и поправит.
 */
export function ReplyMarker({ emailId, onMarked }: { emailId: string; onMarked: () => void }) {
  const can = useStore((s) => s.can);
  const me = useStore((s) => s.authUser?.id);
  const [items, setItems] = useState<ReplyContextItem[]>([]);
  const [mode, setMode] = useState<{ kind: "approval" | "report"; item: ReplyContextItem } | null>(null);
  const [text, setText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [responsible, setResponsible] = useState<string | undefined>();
  const [deadline, setDeadline] = useState<string | null>(null);
  /**
   * Ввод срока нельзя терять.
   *
   * DatePicker применяет НАБРАННОЕ значение только по Enter или blur, а человек набирает дату
   * и сразу жмёт «Отметить и утвердить» — срок уходил null, и подписант молча терял ввод
   * (нашёл QA в живом прогоне: в резолюции deadline=null, в задаче «нет срока»).
   * Поэтому: держим ref на пикер, на отправке фиксируем ввод (blur) и читаем значение из ref,
   * а не из состояния, которое на момент нажатия ещё пустое.
   */
  const deadlineWrapRef = useRef<HTMLSpanElement | null>(null);
  const deadlineRef = useRef<string | null>(null);
  const commitDeadline = (v: string | null) => {
    deadlineRef.current = v;
    setDeadline(v);
  };
  const [people, setPeople] = useState<Array<{ id: string; fullName: string; email?: string }>>([]);
  /** Адреса из письма, которых нет в каталоге: показываем, чтобы аппарат вписал вручную. */
  const [unknownAddresses, setUnknownAddresses] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setItems(await resolutionApi.replyContext(emailId));
    } catch {
      // Права нет или документооборот выключен — блока просто не будет.
      setItems([]);
    }
  }, [emailId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Аппарат подтверждает разбор, но само письмо могло быть написано в Outlook:
  // руководитель и исполнитель тоже должны уметь зарегистрировать свой шаг здесь.
  const isClerk = can("resolution.dispatch");
  const isApprover = can("resolution.approve");
  const isReporter = can("task.report");
  if (!isClerk && !isApprover && !isReporter) return null;

  async function open(kind: "approval" | "report", item: ReplyContextItem) {
    setMode({ kind, item });
    // Руководитель мог ответить из Outlook: тогда текста резолюции у нас ещё нет,
    // а в письме он есть — подставляем его как черновик (аппарат поправит).
    setText(kind === "approval" ? (item.replyText ?? "") : "");
    setAssignees(item.assignees.map((a) => a.userId));
    setUnknownAddresses([]);
    setResponsible(item.assignees.find((a) => a.kind === "responsible")?.userId);
    commitDeadline(null);
    if (kind === "approval") {
      let list = people;
      if (!list.length) {
        try {
          const fetched = await resolutionApi.executorCandidates();
          list = fetched.map((u) => ({ id: u.id, fullName: u.fullName, email: u.email }));
          setPeople(list);
        } catch {
          list = [];
          setPeople([]);
        }
      }
      // Исполнители, которых руководитель указал в письме (решение заказчика):
      // сопоставляем адреса с каталогом и сразу отмечаем найденных.
      const candidates = item.executorCandidates ?? [];
      if (candidates.length) {
        const matched: string[] = [];
        const unknown: string[] = [];
        for (const c of candidates) {
          const person = list.find((p) => (p.email ?? "").toLowerCase() === c.address.toLowerCase());
          if (person) matched.push(person.id);
          else unknown.push(c.address);
        }
        if (matched.length) setAssignees((prev) => [...new Set([...prev, ...matched])]);
        setUnknownAddresses(unknown);
      }
    }
  }

  /** Черновик полей. Модель может не ответить — тогда аппарат пишет сам, и это нормально. */
  async function fillWithAi() {
    if (!mode) return;
    setAiBusy(true);
    try {
      const r = await resolutionApi.suggestFields(emailId, mode.kind);
      if (r.text) {
        setText(r.text);
        message.success("Черновик готов — проверьте и поправьте");
      } else {
        message.info("Не удалось предложить текст — заполните вручную");
      }
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setAiBusy(false);
    }
  }

  async function submit() {
    if (!mode) return;
    if (!text.trim()) {
      message.warning("Заполните текст");
      return;
    }
    // Набранный срок мог ещё не примениться: DatePicker фиксирует ввод по Enter/blur.
    // Просим поле применить ввод и, если оно этого не сделало, читаем то, что человек
    // реально видит в поле, и разбираем сами — иначе дата теряется молча.
    const deadlineInput = deadlineWrapRef.current?.querySelector("input") as HTMLInputElement | null;
    deadlineInput?.blur();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deadlineValue = deadlineRef.current ?? parseTypedDate(deadlineInput?.value);
    setSaving(true);
    try {
      if (mode.kind === "approval") {
        if (!assignees.length) {
          message.warning("Назначьте исполнителя — поручение без него не уйдёт");
          return;
        }
        const payload = {
          text,
          assignees: assignees.map((uid) => ({
            userId: uid,
            kind: (uid === responsible ? "responsible" : "coexecutor") as AssigneeKind
          })),
          deadline: deadlineValue,
          priority: "normal" as const
        };
        if (isClerk) {
          // Аппарат подтверждает ответ, пришедший письмом.
          await resolutionApi.markApproval(mode.item.resolutionId, { emailId, ...payload });
          message.success("Отмечено как резолюция руководителя — можно отправлять исполнителям");
        } else {
          // Руководитель сам регистрирует свою резолюцию из Outlook.
          await resolutionApi.approve(mode.item.resolutionId, { ...payload, emailId });
          message.success("Резолюция утверждена — аппарат отправит её исполнителям");
        }
      } else if (isClerk) {
        // Отчёт принимает аппарат: он прочитал письмо и решил, что это отчёт.
        await resolutionApi.confirmReport(mode.item.resolutionId, responsible ?? assignees[0] ?? "", text);
        message.success("Отчёт принят");
      } else {
        // Исполнитель сам регистрирует свой отчёт, отправленный из Outlook.
        await resolutionApi.report(mode.item.resolutionId, text, emailId);
        message.success("Отчёт зарегистрирован");
      }
      setMode(null);
      await load();
      onMarked();
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setSaving(false);
    }
  }

  if (!items.length) return null;

  return (
    <>
      {items.map((it) => (
        <Card
          key={it.resolutionId}
          size="small"
          style={{ marginBottom: 12, borderColor: "#91caff", background: "#f0f8ff" }}
          title={
            <Space wrap>
              <span>Это письмо — в переписке по поручению</span>
              <b>{it.documentNumber}</b>
              <Tag color={it.expects === "approval" ? "gold" : "blue"}>
                {it.expects === "approval" ? "ждёт решения руководителя" : "исполняется"}
              </Tag>
            </Space>
          }
        >
          <div style={{ color: "#666", fontSize: 13, marginBottom: 10 }}>{it.taskText}</div>
          {it.executorCandidates?.length ? (
            <div style={{ fontSize: 12, color: "#595959", marginBottom: 8 }}>
              В письме указаны исполнители:{" "}
              {it.executorCandidates.map((c) => c.name || c.address).join(", ")}
            </div>
          ) : null}
          <div style={{ fontSize: 12, color: "#595959", marginBottom: 8 }}>
            Отметьте, что это за письмо — система сама не определяет:
          </div>
          <Space wrap>
            {(isClerk || (isApprover && it.expects === "approval")) && (
              <Button type="primary" onClick={() => void open("approval", it)}>
                {isClerk ? "Это резолюция руководителя" : "Это моя резолюция"}
              </Button>
            )}
            {(isClerk ||
              (isReporter && it.expects === "report" && it.assignees.some((a) => a.userId === me))) && (
              <Button onClick={() => void open("report", it)}>
                {isClerk ? "Это отчёт об исполнении" : "Это мой отчёт"}
              </Button>
            )}
          </Space>
        </Card>
      ))}

      <Modal
        open={!!mode}
        title={mode?.kind === "approval" ? "Резолюция руководителя" : "Отчёт об исполнении"}
        onCancel={() => setMode(null)}
        onOk={() => void submit()}
        confirmLoading={saving}
        okText={
          mode?.kind === "approval"
            ? isClerk
              ? "Отметить и утвердить"
              : "Утвердить"
            : isClerk
              ? "Принять отчёт"
              : "Отправить отчёт"
        }
        width={640}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            mode?.kind === "approval"
              ? "Поручение уйдёт исполнителям только после отправки — её делает аппарат."
              : "Отчёт закроет поручение по правилу: есть ответственный — по его отчёту, нет — когда отчитались все."
          }
        />
        <Form layout="vertical">
          <Form.Item label={mode?.kind === "approval" ? "Текст поручения" : "Что сделано"}>
            <Input.TextArea
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                mode?.kind === "approval"
                  ? "Кому и что сделать"
                  : "Кратко: что сделано и с каким результатом"
              }
            />
          </Form.Item>
          <Button icon={<RobotOutlined />} loading={aiBusy} onClick={() => void fillWithAi()}>
            Заполнить с помощью ИИ
          </Button>
          <div style={{ fontSize: 12, color: "#595959", margin: "6px 0 14px" }}>
            Черновик по тексту письма. Проверьте: отвечает за формулировку человек.
          </div>

          {mode?.kind === "approval" ? (
            <>
              <Form.Item label="Исполнители">
                <Select
                  mode="multiple"
                  value={assignees}
                  onChange={setAssignees}
                  placeholder="Выберите из справочника"
                  options={people.map((p) => ({ value: p.id, label: p.fullName }))}
                />
                {unknownAddresses.length ? (
                  <div style={{ fontSize: 12, color: "#ad6800", marginTop: 4 }}>
                    В письме есть адреса, которых нет в каталоге: {unknownAddresses.join(", ")}.
                    Укажите этих людей вручную — поручение уйдёт только тем, кого выберете.
                  </div>
                ) : null}
              </Form.Item>
              <Space size="large" wrap>
                <Form.Item label="Ответственный" style={{ marginBottom: 0 }}>
                  <Select
                    allowClear
                    style={{ width: 220 }}
                    value={responsible}
                    onChange={setResponsible}
                    placeholder="все равны"
                    options={people
                      .filter((p) => assignees.includes(p.id))
                      .map((p) => ({ value: p.id, label: p.fullName }))}
                  />
                </Form.Item>
                <Form.Item label="Срок" style={{ marginBottom: 0 }}>
                  {/* Обёртка нужна, чтобы прочитать набранное в поле значение на отправке. */}
                  <span ref={deadlineWrapRef}>
                    <DatePicker
                      // Обе формы ввода принимаем: «12.10.2026» и «2026-10-12».
                      format={["DD.MM.YYYY", "YYYY-MM-DD"]}
                      value={deadline ? dayjs(deadline) : null}
                      onChange={(d) => commitDeadline(d ? d.format("YYYY-MM-DD") : null)}
                      placeholder="не указан"
                    />
                  </span>
                </Form.Item>
              </Space>
            </>
          ) : (
            <Form.Item label="Кто отчитывается">
              <Select
                style={{ width: 260 }}
                value={responsible}
                onChange={setResponsible}
                placeholder="выберите исполнителя"
                options={(mode?.item.assignees ?? []).map((a) => ({
                  value: a.userId,
                  label: a.fullName + (a.kind === "responsible" ? " (ответственный)" : "")
                }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}