import { Button, Result, Space, Typography } from "antd";
import { FileTextOutlined, SettingOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { useStore } from "../store";

/**
 * Почта предприятия недоступна (T39/T44).
 *
 * У аппарата и администратора есть право mail.view, у остальных — нет. Раньше такой
 * сотрудник видел пустой список и 403 в консоли; теперь получает объяснение и свои
 * личные разделы: черновики, шаблоны и личные настройки никуда не деваются.
 */
export function MailUnavailable() {
  const setSection = useStore((s) => s.setSection);
  const setDraftsOpen = useStore((s) => s.setDraftsOpen);
  const openSettings = useStore((s) => s.openSettings);
  const canViewTasks = useStore((s) => s.can("task.view"));

  return (
    <Result
      status="info"
      title="Почта недоступна"
      subTitle="Служебной почтой работают аппарат и администратор. Ваше поручение открывается в разделе «Мои задачи»."
      extra={
        <Space direction="vertical" size="small" align="center">
          <Space wrap>
            {canViewTasks ? (
              <Button type="primary" icon={<UnorderedListOutlined />} onClick={() => setSection("tasks")}>
                Мои задачи
              </Button>
            ) : null}
            <Button icon={<FileTextOutlined />} onClick={() => setDraftsOpen(true)}>
              Черновики
            </Button>
            <Button icon={<SettingOutlined />} onClick={() => openSettings("profile")}>
              Личные настройки
            </Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Черновики, шаблоны и личные настройки доступны всегда — они ваши.
          </Typography.Text>
        </Space>
      }
    />
  );
}
