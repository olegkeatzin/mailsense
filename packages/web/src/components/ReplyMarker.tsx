import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Tag, message } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { resolutionApi } from "../api";
import { useStore } from "../store";
import type { AssigneeKind, ReplyContextItem } from "../resolutionTypes";

/**
 * Разметка письма в почте: аппарат говорит, что это за письмо (Р9, этап 4).
 *
 * ⚠️ **Система этого не решает.** Ни при сканировании ящика, ни при открытии письма: определяет
 * человек, прочитав письмо. Система сообщает только ФАКТ из заголовков — что письмо отвечает
 * в переписке по такому-то поручению. Это экономит поиск, но ничего не решает за аппарата.
 *
 * ⚠️ **ИИ не классифицирует.** Он вызывается кнопкой «Заполнить с помощью ИИ» и только готовит
 * черновик полей, которые аппарат проверит и поправит.
 */
export function ReplyMarker({ emailId, onMarked }: { emailId: string; onMarked: () => void }) {
  const can = useStore((s) => s.can);
  const [items, setItems] = useState<ReplyContextItem[]>([]);
  const [mode, setMode] = useState<{ kind: "approval" | "report"; item: ReplyContextItem } | null>(null);
  const [text, setText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [responsible, setResponsible] = useState<string | undefined>();
  const [deadline, setDeadline] = useState<string | null>(null);
  const [people, setPeople] = useState<Array<{ id: string; fullName: string }>>([]);

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

  // Работа аппарата: подтверждает он, значит и право его.
  if (!can("resolution.dispatch")) return null;

  async function open(kind: "approval" | "report", item: ReplyContextItem) {
    setMode({ kind, item });
    setText("");
    setAssignees(item.assignees.map((a) => a.userId));
    setResponsible(item.assignees.find((a) => a.kind === "responsible")?.userId);
    setDeadline(null);
    if (kind === "approval" && !people.length) {
      try {
        const list = await resolutionApi.executorCandidates();
        setPeople(list.map((u) => ({ id: u.id, fullName: u.fullName })));
      } catch {
        setPeople([]);
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
      message.error((e as Error).message);
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
    setSaving(true);
    try {
      if (mode.kind === "approval") {
        if (!assignees.length) {
          message.warning("Назначьте исполнителя — поручение без него не уйдёт");
          return;
        }
        await resolutionApi.markApproval(mode.item.resolutionId, {
          emailId,
          text,
          assignees: assignees.map((uid) => ({
            userId: uid,
            kind: (uid === responsible ? "responsible" : "coexecutor") as AssigneeKind
          })),
          deadline,
          priority: "normal"
        });
        message.success("Отмечено как резолюция руководителя — можно отправлять исполнителям");
      } else {
        // Отчёт принимает аппарат: он прочитал письмо и решил, что это отчёт. 
        await resolutionApi.confirmReport(mode.item.resolutionId, responsible ?? assignees[0] ?? "", text);
        message.success("Отчёт принят");
      }
      setMode(null);
      await load();
      onMarked();
    } catch (e) {
      message.error((e as Error).message);
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
          <div style={{ fontSize: 12, color: "#595959", marginBottom: 8 }}>
            Отметьте, что это за письмо — система сама не определяет:
          </div>
          <Space wrap>
            <Button type="primary" onClick={() => void open("approval", it)}>
              Это резолюция руководителя
            </Button>
            <Button onClick={() => void open("report", it)}>Это отчёт об исполнении</Button>
          </Space>
        </Card>
      ))}

      <Modal
        open={!!mode}
        title={mode?.kind === "approval" ? "Резолюция руководителя" : "Отчёт об исполнении"}
        onCancel={() => setMode(null)}
        onOk={() => void submit()}
        confirmLoading={saving}
        okText={mode?.kind === "approval" ? "Отметить и утвердить" : "Принять отчёт"}
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
                  <DatePicker
                    onChange={(_d, s) => setDeadline(s ? String(s) : null)}
                    placeholder="не указан"
                  />
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