import { useRef, useState } from "react";
import { Button, Modal, Select, Space, Typography, message } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { useStore } from "../store";

const FOLDER_OPTIONS = [
  { value: "INBOX", label: "Входящие" },
  { value: "PROCESSED", label: "Обработанные" },
  { value: "SPAM", label: "Спам" }
];

function readAsBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(f);
  });
}

export default function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const loadEmails = useStore((s) => s.loadEmails);
  const [accountId, setAccountId] = useState<string>("");
  const [folder, setFolder] = useState("INBOX");
  const [files, setFiles] = useState<{ filename: string; data: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    const read: { filename: string; data: string }[] = [];
    for (const f of list) {
      read.push({ filename: f.name, data: await readAsBase64(f) });
    }
    setFiles(read);
  };

  const doImport = async () => {
    if (!accountId || files.length === 0) {
      message.warning("Выберите аккаунт и файлы");
      return;
    }
    setBusy(true);
    try {
      const r = await useStore.getState().importEmails(accountId, folder, files);
      message.success("Импортировано: " + r.added + ", пропущено: " + r.skipped);
      await loadEmails();
      setFiles([]);
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="Импорт писем (.eml / .mbox)">
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <div>
          <Typography.Text>Аккаунт назначения</Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 4 }}
            placeholder="Выберите аккаунт"
            value={accountId || undefined}
            onChange={setAccountId}
            options={accounts.map((a) => ({ value: a.id, label: a.username }))}
          />
        </div>
        <div>
          <Typography.Text>Папка</Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 4 }}
            value={folder}
            onChange={setFolder}
            options={FOLDER_OPTIONS}
          />
        </div>
        <div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".eml,.mbox,.msg"
            style={{ display: "none" }}
            onChange={(e) => void pickFiles(e)}
          />
          <Button icon={<InboxOutlined />} onClick={() => fileRef.current?.click()}>
            Выбрать файлы
          </Button>
          {files.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
              {files.map((f) => f.filename).join(", ")}
            </div>
          )}
        </div>
        <Button type="primary" loading={busy} onClick={() => void doImport()}>
          Импортировать
        </Button>
      </Space>
    </Modal>
  );
}
