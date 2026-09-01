import { Button, Popconfirm, Select } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { useStore } from "../store";

const FOLDER_OPTIONS = [
  { value: "INBOX", label: "Входящие" },
  { value: "PROCESSED", label: "Обработанные" },
  { value: "SPAM", label: "Спам" }
];

export default function BulkBar() {
  const selectedIds = useStore((s) => s.selectedIds);
  const bulkAnalyze = useStore((s) => s.bulkAnalyze);
  const bulkMove = useStore((s) => s.bulkMove);
  const bulkDelete = useStore((s) => s.bulkDelete);
  const clearSelection = useStore((s) => s.clearSelection);

  if (selectedIds.length === 0) return null;

  return (
    <div
      style={{
        padding: "6px 12px",
        borderBottom: "1px solid #e6f4ff",
        display: "flex",
        gap: 8,
        alignItems: "center",
        background: "#e6f4ff",
        flexWrap: "wrap"
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600 }}>Выбрано: {selectedIds.length}</span>
      <Button size="small" icon={<ThunderboltOutlined />} onClick={() => void bulkAnalyze()}>
        Анализировать
      </Button>
      <Select
        size="small"
        style={{ width: 150 }}
        placeholder="Переместить в…"
        value={undefined}
        onChange={(v) => {
          if (v) void bulkMove(v);
        }}
        options={FOLDER_OPTIONS}
      />
      <Popconfirm title="Удалить выбранные письма?" onConfirm={() => void bulkDelete()}>
        <Button size="small" danger>
          Удалить
        </Button>
      </Popconfirm>
      <Button size="small" onClick={clearSelection}>
        Отмена
      </Button>
    </div>
  );
}
