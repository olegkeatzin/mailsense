import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Descriptions, Empty, Space, Spin, Tag, Typography, message } from "antd";
import { ProfileOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useStore } from "../store";
import { DOCUMENT_STATUS_TITLES, type DocumentRecord, type EmailView } from "../types";
import DocumentCard from "./DocumentCard";
import { ReplyMarker } from "./ReplyMarker";
import { humanError } from "../utils/humanError";

/**
 * Вкладка «СЭД» в открытом письме (ТЗ п. 5: боковая панель с кнопкой «Зарегистрировать»).
 *
 * Регистрация идёт ВСТРОЕННО, без попапа: форма и письмо видны одновременно. Попап закрывал
 * письмо целиком, а все поля регистрации берутся именно из него.
 */
export default function EmailDocflowTab({ emailId, letter }: { emailId: string; letter: EmailView }) {
  const can = useStore((s) => s.can);
  const [doc, setDoc] = useState<DocumentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [cardId, setCardId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDoc(await api.documentByEmail(emailId));
    } catch (err) {
      message.error("Не удалось получить данные документооборота: " + humanError(err));
    } finally {
      setLoading(false);
    }
  }, [emailId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!can("journal.view")) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Журнал недоступен для вашей роли" />;
  }

  if (loading) return <Spin />;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {/* Разметка письма: аппарат отмечает сам, что это за письмо (Р9, этап 4). */}
      <ReplyMarker emailId={emailId} onMarked={() => void load()} />

      {doc ? (
        <>
          <Alert
            type="success"
            showIcon
            message="Письмо зарегистрировано"
            description="Запись есть в журнале входящих документов."
          />
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="Входящий номер">{doc.regNumber}</Descriptions.Item>
            <Descriptions.Item label="Дата регистрации">{doc.regDate}</Descriptions.Item>
            <Descriptions.Item label="Состояние">
              <Tag>{DOCUMENT_STATUS_TITLES[doc.status]}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Листов">{doc.sheetsCount ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="От кого получен" span={2}>
              {doc.sender || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Краткое содержание" span={2}>
              {doc.summary || "—"}
            </Descriptions.Item>
          </Descriptions>
          <Button icon={<ProfileOutlined />} onClick={() => setCardId(doc.id)}>
            Открыть карточку документа
          </Button>
        </>
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            message="Письмо ещё не зарегистрировано"
            description={
              can("journal.register")
                ? "Форма регистрации — во вкладке «Письмо», рядом с текстом: поля берутся из письма, и оно должно быть видно."
                : "Регистрация доступна аппарату (роль «Секретарь»)."
            }
          />
        </>
      )}

      <DocumentCard documentId={cardId} onClose={() => setCardId(null)} onChanged={() => void load()} />
    </Space>
  );
}