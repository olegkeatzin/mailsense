import { Button, Menu, Typography } from "antd";
import { FolderOutlined, MailOutlined, SettingOutlined } from "@ant-design/icons";
import { useStore } from "../store";

const FOLDERS = [
  { key: "INBOX", label: "Входящие" },
  { key: "PROCESSED", label: "Обработанные" },
  { key: "SPAM", label: "Спам" }
];

export default function AccountSidebar() {
  const accounts = useStore((s) => s.accounts);
  const folder = useStore((s) => s.folder);
  const accountFilter = useStore((s) => s.accountFilter);
  const setFolder = useStore((s) => s.setFolder);
  const setAccountFilter = useStore((s) => s.setAccountFilter);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  const accountItems = [
    { key: "all", icon: <MailOutlined />, label: "Все аккаунты" },
    ...accounts.map((a) => ({ key: a.id, icon: <MailOutlined />, label: a.username }))
  ];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "auto" }}>
      <div style={{ padding: 12 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          MailSense
        </Typography.Title>
        <Button
          size="small"
          block
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen(true)}
          style={{ marginTop: 8 }}
        >
          Настройки
        </Button>
      </div>

      <Typography.Text type="secondary" style={{ padding: "0 16px 4px", fontSize: 12 }}>
        Папки
      </Typography.Text>
      <Menu
        mode="inline"
        selectedKeys={[folder]}
        onClick={({ key }) => setFolder(key as string)}
        items={FOLDERS.map((f) => ({ key: f.key, icon: <FolderOutlined />, label: f.label }))}
      />

      <Typography.Text type="secondary" style={{ padding: "8px 16px 4px", fontSize: 12 }}>
        Аккаунты
      </Typography.Text>
      <Menu
        mode="inline"
        selectedKeys={accountFilter ? [accountFilter] : ["all"]}
        onClick={({ key }) => setAccountFilter(key === "all" ? null : key)}
        items={accountItems}
      />
    </div>
  );
}
