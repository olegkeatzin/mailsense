import { useState } from "react";
import { Button, DatePicker, Modal, Select, Space, Typography, message } from "antd";
import { useStore } from "../store";

export default function AnalyzeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const analyzeRange = useStore((s) => s.analyzeRange);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);

  const doAnalyze = async () => {
    setBusy(true);
    try {
      const ids = accountIds.length > 0 ? accountIds : undefined;
      const n = await analyzeRange(since || undefined, until || undefined, ids);
      message.success("Запущен анализ " + n + " писем");
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="Анализ писем">
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
          <Typography.Text>Период (пусто = все письма)</Typography.Text>
          <Space style={{ marginTop: 4 }}>
            <DatePicker placeholder="С даты" onChange={(d) => setSince(d ? d.format("YYYY-MM-DD") : "")} />
            <DatePicker placeholder="По дату" onChange={(d) => setUntil(d ? d.format("YYYY-MM-DD") : "")} />
          </Space>
        </div>
        <Button type="primary" loading={busy} onClick={() => void doAnalyze()}>
          Анализировать
        </Button>
      </Space>
    </Modal>
  );
}
