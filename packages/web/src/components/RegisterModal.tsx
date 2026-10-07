import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, InputNumber, Select, Space, Spin, message } from "antd";
import { api } from "../api";
import type { CaseRecord, DuplicateMatch, RegisterSuggest } from "../types";
import { humanError } from "../utils/humanError";

/**
 * Форма регистрации входящего документа.
 *
 * Поля подставляются из письма и результатов ИИ — секретарь проверяет и дополняет,
 * а не заполняет всё руками. Перед сохранением проверяются дубли.
 */
interface Props {
  emailId: string | null;
  onRegistered: (regNumber: string) => void;
}

const REASON_TITLES: Record<string, string> = {
  email: "это письмо уже зарегистрировано",
  docNumber: "совпадает номер документа",
  summary: "совпадает краткое содержание"
};

/**
 * Обёртка формы — ВСЕГДА карточка, никогда попап.
 *
 * ⚠️ Попап здесь стоял и был убран намеренно. Регистрация заполняется по письму: номер
 * отправителя, дата, отправитель, число листов, краткое содержание. Модальное окно закрывает
 * текст письма целиком, и поля заполняются по памяти — а это прямой путь к неверной записи
 * в журнале. Форму открывают кнопкой «Зарегистрировать» рядом с письмом.
 *
 * Не возвращайте сюда Modal: если понадобится место, лучше расширить колонку.
 */
function RegisterShell({
  onOk,
  saving,
  loading,
  children
}: {
  onOk: () => void;
  saving: boolean;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card
      size="small"
      title="Регистрация входящего документа"
      extra={
        <Button type="primary" loading={saving} disabled={loading} onClick={onOk}>
          Зарегистрировать
        </Button>
      }
    >
      {children}
    </Card>
  );
}

export default function RegisterModal({ emailId, onRegistered }: Props) {
  const [form] = Form.useForm();
  const [suggest, setSuggest] = useState<RegisterSuggest | null>(null);
  const [dups, setDups] = useState<DuplicateMatch[]>([]);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Номер, который присвоит база. Подсказка: настоящий выдаётся при регистрации. */
  const [nextNumber, setNextNumber] = useState<string | null>(null);

  const checkDuplicates = useCallback(async (values: { docNumber?: string; summary?: string }) => {
    if (!emailId) return;
    try {
      const found = await api.journalDuplicates({
        emailId,
        docNumber: values.docNumber,
        summary: values.summary
      });
      setDups(found);
    } catch {
      setDups([]);
    }
  }, [emailId]);

  useEffect(() => {
    if (!emailId) return;
    setLoading(true);
    setSuggest(null);
    setDups([]);
    Promise.all([
      api.journalSuggest(emailId),
      api.cases(true).catch(() => []),
      api.nextRegNumber().catch(() => null)
    ])
      .then(([s, c, n]) => {
        setSuggest(s);
        setCases(c);
        setNextNumber(n?.regNumber ?? null);
        form.setFieldsValue({
          docNumber: s.docNumber,
          docDate: s.docDate,
          sender: s.sender,
          summary: s.summary,
          sheetsCount: s.sheetsCount,
          documentName: s.documentName
        });
        void checkDuplicates({ docNumber: s.docNumber, summary: s.summary });
      })
      .catch((err) => message.error("Не удалось получить данные письма: " + humanError(err)))
      .finally(() => setLoading(false));
  }, [emailId, form, checkDuplicates]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const doc = await api.registerDocument({
        emailId,
        docNumber: values.docNumber ?? "",
        docDate: values.docDate || null,
        sender: values.sender ?? "",
        summary: values.summary ?? "",
        sheetsCount: values.sheetsCount ?? null,
        caseNumber: values.caseNumber || null,
        documentName: values.documentName ?? ""
      });
      message.success("Документ зарегистрирован: " + doc.regNumber);
      onRegistered(doc.regNumber);
    } catch (err) {
      message.error(humanError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <RegisterShell onOk={() => void submit()} saving={saving} loading={loading}>
      {loading ? (
        <Spin />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {suggest?.alreadyRegistered && (
            <Alert
              type="warning"
              showIcon
              message={"Письмо уже зарегистрировано как " + suggest.alreadyRegistered}
            />
          )}

          {dups.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message="Возможны дубли"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {dups.map((d) => (
                    <li key={d.document.id}>
                      <b>{d.document.regNumber}</b> от {d.document.regDate} — {REASON_TITLES[d.reason] ?? d.reason}: 
                      {d.document.summary || d.document.documentName}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {/*
         * Номер выдаёт база по счётчику — вводить его не нужно. Показываем заранее, чтобы
         * аппарат видел, какой номер получит документ, и не искал поле для него.
         */}
        {nextNumber ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={"Входящий номер: " + nextNumber + " — будет присвоен автоматически"}
            description="Номер ведётся счётчиком в базе по порядку, без пропусков. Вводить его не нужно."
          />
        ) : null}

        <Form form={form} layout="vertical" size="small">
            <Space size="middle" wrap style={{ width: "100%" }} align="start">
              {/* Номер ОТПРАВИТЕЛЯ с бланка — не путать с входящим номером журнала. */}
        <Form.Item label="Номер отправителя" name="docNumber" style={{ width: 200 }}>
                <Input
                  placeholder="из письма или бланка"
                  onBlur={(e) => void checkDuplicates({ docNumber: e.target.value, summary: form.getFieldValue("summary") })}
                />
              </Form.Item>
              <Form.Item label="Дата документа" name="docDate" style={{ width: 160 }}>
                <Input placeholder="ГГГГ-ММ-ДД" />
              </Form.Item>
              <Form.Item label="Количество листов" name="sheetsCount" style={{ width: 160 }}>
                <InputNumber min={0} style={{ width: "100%" }} placeholder="из PDF или вручную" />
              </Form.Item>
            </Space>

            <Form.Item label="От кого получен" name="sender">
              <Input placeholder="организация-отправитель" />
            </Form.Item>

            <Form.Item label="Краткое содержание" name="summary">
              <Input.TextArea
                autoSize={{ minRows: 2, maxRows: 5 }}
                onBlur={(e) => void checkDuplicates({ docNumber: form.getFieldValue("docNumber"), summary: e.target.value })}
              />
            </Form.Item>

            <Space size="middle" wrap style={{ width: "100%" }} align="start">
              <Form.Item label="Наименование документа" name="documentName" style={{ width: 380 }}>
                <Input placeholder="тема письма" />
              </Form.Item>
              <Form.Item label="Номер дела" name="caseNumber" style={{ width: 250 }}>
                <Select
                  allowClear
                  placeholder="из номенклатуры дел"
                  options={cases.map((c) => ({ value: c.code, label: c.code + " — " + c.title }))}
                />
              </Form.Item>
            </Space>
          </Form>
        </Space>
      )}
    </RegisterShell>
  );
}