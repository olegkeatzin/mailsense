import { useState } from "react";
import { Button, Empty, List, Modal, Spin, Typography, message } from "antd";
import { DownloadOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { api } from "../api";
import { humanError } from "../utils/humanError";

/**
 * Вложения зарегистрированного документа из папки mailDocs на сервере.
 * Скачиваем blob-ом: обычная ссылка из Electron ушла бы во внешний браузер без сессии.
 */
export function DocumentFilesButton({
  documentId,
  size = "small"
}: {
  documentId: string;
  size?: "small" | "middle";
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [docFilesPath, setDocFilesPath] = useState("");
  const [files, setFiles] = useState<Array<{ name: string; size: number }>>([]);

  async function load() {
    setOpen(true);
    setLoading(true);
    try {
      const data = await api.journalFiles(documentId);
      setDocFilesPath(data.docFilesPath);
      setFiles(data.files);
    } catch (e) {
      message.error("Не удалось получить вложения: " + humanError(e));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }

  async function download(name: string) {
    setBusy(name);
    try {
      const blob = await api.journalFileBlob(documentId, name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Даём браузеру начать скачивание, потом освобождаем память.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      message.error("Не удалось скачать файл: " + humanError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Button
        size={size}
        icon={<FolderOpenOutlined />}
        onClick={(e) => {
          e.stopPropagation();
          void load();
        }}
      >
        Файлы
      </Button>
      <Modal
        open={open}
        title="Вложения документа"
        footer={null}
        width={680}
        onCancel={() => {
          setOpen(false);
          setFiles([]);
        }}
      >
        <Spin spinning={loading}>
          {docFilesPath ? (
            <Typography.Paragraph type="secondary" copyable style={{ fontSize: 12, wordBreak: "break-all" }}>
              Папка на сервере: {docFilesPath}
            </Typography.Paragraph>
          ) : null}
          {files.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Вложений нет" />
          ) : (
            <List
              size="small"
              dataSource={files}
              renderItem={(f) => (
                <List.Item style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ wordBreak: "break-all" }}>{f.name}</div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {(f.size / 1024).toFixed(1)} КБ
                    </Typography.Text>
                  </div>
                  <Button
                    type="link"
                    icon={<DownloadOutlined />}
                    loading={busy === f.name}
                    style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}
                    onClick={() => void download(f.name)}
                  >
                    Скачать
                  </Button>
                </List.Item>
              )}
            />
          )}
        </Spin>
      </Modal>
    </>
  );
}
