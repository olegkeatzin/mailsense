import { useEffect, useState } from "react";
import { Button, DatePicker, Descriptions, Input, List, Select, Tabs, Tag, Typography, message } from "antd";
import {
  DownloadOutlined,
  EyeOutlined,
  FileOutlined,
  ThunderboltOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useStore } from "../store";
import { api, attachmentUrl, previewUrl } from "../api";
import type { Attachment, EmailView } from "../types";
import { formatBytes, formatDate, statusColor, statusLabel } from "../utils";
import AnalysisPanel from "./AnalysisPanel";

const FOLDER_OPTIONS = [
  { value: "INBOX", label: "Входящие" },
  { value: "Sent", label: "Отправленные" },
  { value: "PROCESSED", label: "Обработанные" },
  { value: "SPAM", label: "Спам" }
];

function AttachmentItem({ view, a }: { view: EmailView; a: Attachment }) {
  const [showContent, setShowContent] = useState(false);
  return (
    <List.Item
      actions={[
        <Button key="open" size="small" icon={<EyeOutlined />} href={attachmentUrl(view.id, a.id, true)} target="_blank">
          Открыть
        </Button>,
        <Button key="dl" size="small" icon={<DownloadOutlined />} href={attachmentUrl(view.id, a.id, false)}>
          Скачать
        </Button>
      ]}
    >
      <div style={{ width: "100%" }}>
        <List.Item.Meta
          avatar={<FileOutlined style={{ fontSize: 20 }} />}
          title={a.filename}
          description={
            formatBytes(a.size) + " · " + a.mimeType + (a.handled ? "" : " · не обработано ИИ")
          }
        />
        {a.extractedText || a.aiDescription ? (
          <div style={{ marginTop: 8 }}>
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setShowContent(!showContent)}>
              {showContent ? "Скрыть содержимое" : "Содержимое"}
            </Button>
            {showContent ? (
              <>
                {a.aiDescription ? (
                  <div
                    style={{
                      marginTop: 6,
                      padding: 8,
                      borderRadius: 4,
                      background: "#f6f8ff",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word"
                    }}
                  >
                    <span style={{ fontWeight: 600, color: "#1677ff" }}>Описание ИИ: </span>
                    {a.aiDescription}
                  </div>
                ) : null}
                {a.extractedText ? (
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      background: "#fafafa",
                      padding: 8,
                      borderRadius: 4,
                      maxHeight: 320,
                      overflow: "auto",
                      fontSize: 12,
                      marginTop: 8
                    }}
                  >
                    {a.extractedText}
                  </pre>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </List.Item>
  );
}

function MailTab({ view }: { view: EmailView }) {
  const from = view.from ? view.from.name || view.from.address : "(неизвестен)";
  const to = view.to.map((t) => t.address).join(", ");
  const refreshSelected = useStore((s) => s.refreshSelected);
  const [number, setNumber] = useState(view.externalNumber ?? "");
  const [saving, setSaving] = useState(false);
  const [sendDate, setSendDate] = useState(view.sendDate ?? "");
  const [savingDate, setSavingDate] = useState(false);

  useEffect(() => {
    setNumber(view.externalNumber ?? "");
    setSendDate(view.sendDate ?? "");
  }, [view.id, view.externalNumber, view.sendDate]);

  const saveNumber = async () => {
    setSaving(true);
    try {
      await api.setExternalNumber(view.id, number.trim() || null);
      await refreshSelected();
      message.success("Номер сохранён");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveSendDate = async () => {
    setSavingDate(true);
    try {
      await api.setSendDate(view.id, sendDate || null);
      await refreshSelected();
      message.success("Дата отправки сохранена");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSavingDate(false);
    }
  };

  const previewAtt =
    view.attachments.find((a) => a.id === view.numberSourceAttachmentId) ??
    view.attachments.find((a) => a.kind === "pdf" || a.kind === "image") ??
    null;
  const previewPage = previewAtt && previewAtt.id === view.numberSourceAttachmentId ? view.numberSourcePage : 1;

  return (
    <div>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="От">{from}</Descriptions.Item>
        <Descriptions.Item label="Кому">{to || "—"}</Descriptions.Item>
        <Descriptions.Item label="Дата получения">{formatDate(view.date)}</Descriptions.Item>
        <Descriptions.Item label="Внешний номер">{view.externalNumber || "—"}</Descriptions.Item>
        <Descriptions.Item label="Дата отправки">{formatDate(view.sendDate)}</Descriptions.Item>
      </Descriptions>

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          Внешний номер:
        </Typography.Text>
        <Input
          size="small"
          style={{ width: 220 }}
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="Не определён"
        />
        <Button size="small" loading={saving} onClick={() => void saveNumber()}>
          Сохранить
        </Button>
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          Дата отправки:
        </Typography.Text>
        <DatePicker
          size="small"
          value={sendDate ? dayjs(sendDate) : null}
          onChange={(d) => setSendDate(d ? d.format("YYYY-MM-DD") : "")}
          placeholder="Не определена"
          format="YYYY-MM-DD"
          style={{ width: 180 }}
        />
        <Button size="small" loading={savingDate} onClick={() => void saveSendDate()}>
          Сохранить
        </Button>
      </div>

      <div style={{ marginTop: 16 }}>
        {view.bodyText ? (
          <div className="email-body">{view.bodyText}</div>
        ) : view.bodyHtml ? (
          <div dangerouslySetInnerHTML={{ __html: view.bodyHtml }} />
        ) : (
          <Typography.Text type="secondary">(пустое письмо)</Typography.Text>
        )}
      </div>

      {previewAtt && (previewAtt.kind === "pdf" || previewAtt.kind === "image") ? (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>Документ с номером</Typography.Title>
          <img
            src={previewUrl(view.id, previewAtt.id, previewPage)}
            alt={previewAtt.filename}
            style={{
              width: "100%",
              maxWidth: 960,
              border: "1px solid #e0e0e0",
              borderRadius: 4,
              display: "block",
              background: "#fff"
            }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
            {previewAtt.filename}
            {previewAtt.kind === "pdf" && previewPage > 1 ? " · стр. " + previewPage : ""}
          </Typography.Text>
        </div>
      ) : null}

      {view.attachments.length > 0 ? (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5}>Вложения ({view.attachments.length})</Typography.Title>
          <List dataSource={view.attachments} renderItem={(a) => <AttachmentItem view={view} a={a} />} />
        </div>
      ) : null}
    </div>
  );
}

export default function EmailViewer() {
  const view = useStore((s) => s.emailView);
  const analyze = useStore((s) => s.analyze);
  const moveSelected = useStore((s) => s.moveSelected);
  const openCompose = useStore((s) => s.openCompose);
  const [activeTab, setActiveTab] = useState("mail");

  if (!view) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#999" }}>
        Выберите письмо
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Typography.Title
          level={4}
          style={{ margin: 0, flex: "1 1 200px", minWidth: 160 }}
          ellipsis={{ tooltip: view.subject }}
        >
          {view.subject}
        </Typography.Title>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Tag color={statusColor(view.analysisStatus)}>{statusLabel(view.analysisStatus)}</Tag>
          <Button size="small" onClick={() => openCompose("reply", view.id)}>
            Ответить
          </Button>
          <Button size="small" onClick={() => openCompose("replyAll", view.id)}>
            Ответить всем
          </Button>
          <Button size="small" onClick={() => openCompose("forward", view.id)}>
            Переслать
          </Button>
          <Button icon={<ThunderboltOutlined />} onClick={() => void analyze(view.id)}>
            Анализировать
          </Button>
          <Select
            size="small"
            value={view.folder}
            style={{ width: 150 }}
            onChange={(v) => void moveSelected(v)}
            options={FOLDER_OPTIONS}
          />
        </div>
      </div>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: "mail", label: "Письмо", children: <MailTab view={view} /> },
          { key: "analysis", label: "Анализ", children: <AnalysisPanel view={view} /> }
        ]}
      />
    </div>
  );
}
