import { useState } from "react";
import { Alert, Button, Card, Form, Input, Typography, message } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useStore } from "../store";

/**
 * Экран входа. Аутентификация — доменной учёткой (LDAP bind), пароль
 * в приложении не сохраняется: он живёт только на время запроса.
 */
export default function LoginScreen() {
  const login = useStore((s) => s.login);
  const authStatus = useStore((s) => s.authStatus);
  const [busy, setBusy] = useState(false);

  const submit = async (values: { login: string; password: string }) => {
    setBusy(true);
    try {
      await login(values.login.trim(), values.password);
      message.success("Вход выполнен");
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f7fb"
      }}
    >
      <Card style={{ width: 420, boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          MailSense
        </Typography.Title>
        <Typography.Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
          Вход в систему электронного документооборота
        </Typography.Text>

        {authStatus && !authStatus.ldapConfigured ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Каталог не настроен"
            description="Укажите адрес и Base DN каталога в «Настройки → Каталог (LDAP)». Без этого вход недоступен."
          />
        ) : null}

        {/*
          Администратора назначают вручную (MAILSENSE_ADMIN_LOGINS), автоматически им
          не становится никто. Если список не задан и админа ещё нет — говорим об этом
          прямо, иначе система окажется без того, кто может выдать роли.
        */}
        {authStatus && !authStatus.adminConfigured && !authStatus.hasAdmin ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Администратор не назначен"
            description={
              "Войти можно, но ролей ни у кого нет — управлять пользователями будет некому. " +
              "Задайте на сервере MAILSENSE_ADMIN_LOGINS со списком доменных логинов администраторов " +
              "и перезапустите его."
            }
          />
        ) : null}

        {authStatus?.adminConfigured && authStatus.needsBootstrap ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Справочник сотрудников пуст"
            description="Войдите — профиль подтянется из каталога. Роль администратора выдаётся логинам из MAILSENSE_ADMIN_LOGINS."
          />
        ) : null}

        <Form layout="vertical" onFinish={(v) => void submit(v as { login: string; password: string })}>
          <Form.Item
            name="login"
            label="Доменная учётная запись"
            rules={[{ required: true, message: "Укажите логин" }]}
          >
            <Input
              size="large"
              prefix={<UserOutlined />}
              placeholder="ivanov@company.local"
              autoComplete="username"
              autoFocus
            />
          </Form.Item>
          <Form.Item name="password" label="Пароль" rules={[{ required: true, message: "Укажите пароль" }]}>
            <Input.Password size="large" prefix={<LockOutlined />} autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={busy}>
            Войти
          </Button>
        </Form>

        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
          Используется доменная учётная запись (та же, что для входа в Windows). Почтовый пароль не подойдёт —
          почта и каталог в организации аутентифицируются раздельно.
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
