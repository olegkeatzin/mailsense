import { Menu, Typography } from "antd";
import {
  AuditOutlined,
  CheckSquareOutlined,
  FileTextOutlined,
  FolderOutlined,
  InboxOutlined,
  MailOutlined,
  ProjectOutlined
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
  const can = useStore((s) => s.can);
  const section = useStore((s) => s.section);
  const setSection = useStore((s) => s.setSection);

  const accountItems = [
    { key: "all", icon: <MailOutlined />, label: "Все аккаунты" },
    ...accounts.map((a) => ({ key: a.id, icon: <MailOutlined />, label: a.username }))
  ];

  // Каждый раздел виден по СВОЕМУ праву — ровно тому, которое проверяет его маршрут
  // (SECTION_PERMISSIONS в store.ts). Раньше весь список был обёрнут в journal.view:
  // администратор снимал у исполнителя «Смотреть журнал», и вместе с журналом у него
  // пропадали «Мои задачи», хотя право task.view никто не отнимал.
  // Заголовок группы тоже не должен зависеть от журнала: она показывается, пока в ней
  // есть хоть один доступный раздел.
  const docflowItems = [
    ...(can("journal.view") ? [{ key: "journal", icon: <FileTextOutlined />, label: "Журнал" }] : []),
    ...(can("journal.register") ? [{ key: "incoming", icon: <InboxOutlined />, label: "На регистрацию" }] : []),
    ...(can("resolution.approve") ? [{ key: "approvals", icon: <AuditOutlined />, label: "На утверждении" }] : []),
    ...(can("task.view") ? [{ key: "tasks", icon: <CheckSquareOutlined />, label: "Мои задачи" }] : []),
    ...(can("resolution.create") ? [{ key: "board", icon: <ProjectOutlined />, label: "Резолюции" }] : [])
  ];
  const hasDocflow = docflowItems.length > 0;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "auto" }}>
      <div style={{ padding: 12 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          MailSense
        </Typography.Title>
      </div>

      {hasDocflow && (
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