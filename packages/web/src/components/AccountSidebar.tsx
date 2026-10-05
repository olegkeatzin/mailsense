import { Button, Menu, Typography } from "antd";
import {
  AuditOutlined,
  CheckSquareOutlined,
  FileTextOutlined,
  FolderOutlined,
  InboxOutlined,
  MailOutlined,
  ProjectOutlined,
  SafetyOutlined,
  SettingOutlined
} from "@ant-design/icons";
import { useStore, type AppSection } from "../store";

const FOLDERS = [
  { key: "INBOX", label: "Входящие" },
  { key: "Sent", label: "Отправленные" },
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
  const can = useStore((s) => s.can);
  const section = useStore((s) => s.section);
  const setSection = useStore((s) => s.setSection);

  const accountItems = [
    { key: "all", icon: <MailOutlined />, label: "Все аккаунты" },
    ...accounts.map((a) => ({ key: a.id, icon: <MailOutlined />, label: a.username }))
  ];

  /** Разделы СЭД показываем только тем, кому доступен журнал (ТЗ п. 5). */
  const canJournal = can("journal.view");
  // Пункты меню разведены по правам так же, как маршруты на сервере: подписант видит
  // «На утверждении», исполнитель — «Мои задачи». Аппарат ведёт журнал и регистрацию.
  const docflowItems = [
    { key: "journal", icon: <FileTextOutlined />, label: "Журнал" },
    ...(can("journal.register") ? [{ key: "incoming", icon: <InboxOutlined />, label: "На регистрацию" }] : []),
    ...(can("resolution.approve") ? [{ key: "approvals", icon: <AuditOutlined />, label: "На утверждении" }] : []),
    // ⚠️ Раздела «На подтверждение» здесь больше нет и быть не должно: раньше сюда попадали
    // ответы, которые система распознала САМА. Теперь аппарат отмечает письмо в почте —
    // отдельная очередь не нужна, потому что решения за человека никто не принимает.
    ...(can("task.view") ? [{ key: "tasks", icon: <CheckSquareOutlined />, label: "Мои задачи" }] : []),
    ...(can("resolution.create") ? [{ key: "board", icon: <ProjectOutlined />, label: "Резолюции" }] : [])
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

      {canJournal && (
        <>
          <Typography.Text type="secondary" style={{ padding: "0 16px 4px", fontSize: 12 }}>
            Документооборот
          </Typography.Text>
          <Menu
            mode="inline"
            selectedKeys={section === "mail" ? [] : [section]}
            onClick={({ key }) => setSection(key as AppSection)}
            items={docflowItems}
          />
        </>
      )}

      <Typography.Text type="secondary" style={{ padding: "8px 16px 4px", fontSize: 12 }}>
        Папки
      </Typography.Text>
      <Menu
        mode="inline"
        selectedKeys={section === "mail" ? [folder] : []}
        onClick={({ key }) => {
          setSection("mail");
          setFolder(key as string);
        }}
        items={FOLDERS.map((f) => ({ key: f.key, icon: <FolderOutlined />, label: f.label }))}
      />

      <Typography.Text type="secondary" style={{ padding: "8px 16px 4px", fontSize: 12 }}>
        Аккаунты
      </Typography.Text>
      <Menu
        mode="inline"
        selectedKeys={accountFilter ? [accountFilter] : ["all"]}
        onClick={({ key }) => {
          setSection("mail");
          setAccountFilter(key === "all" ? null : key);
        }}
        items={accountItems}
      />
    </div>
  );
}