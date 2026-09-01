import { useState } from "react";
import { Button, DatePicker, Modal, Select, Space, Typography, message } from "antd";
import { useStore } from "../store";

export default function FetchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const fetchAccounts = useStore((s) => s.fetchAccounts);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);

  const doFetch = async () => {
    setBusy(true);
    try {
      const ids = accountIds.length > 0 ? accountIds : accounts.map((a) => a.id);
      await fetchAccounts(ids, since || undefined, until || undefined);
      message.success("Сканирование завершено");
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="Сканировать ящик">
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <div>
          <Typography.Text>Аккаунты (пусто = все)</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            style={{ width: "100%", marginTop: 4 }}
            placeholder="Все аккаунты"
            value={accountIds}
            onChange={setAccountIds}
            options={accounts.map((a) => ({ value: a.id, label: a.username }))}
          />
        </div>
        <div>
          <Typography.Text>Период (пусто = без ограничения)</Typography.Text>
          <Space style={{ marginTop: 4 }}>
            <DatePicker placeholder="С даты" onChange={(d) => setSince(d ? d.format("YYYY-MM-DD") : "")} />
            <DatePicker placeholder="По дату" onChange={(d) => setUntil(d ? d.format("YYYY-MM-DD") : "")} />
          </Space>
        </div>
        <Button type="primary" loading={busy} onClick={() => void doFetch()}>
          Сканировать
        </Button>
      </Space>
    </Modal>
  );
}
