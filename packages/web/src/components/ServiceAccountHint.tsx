import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Space, Tag, Typography, message } from "antd";
import { useStore } from "../store";
import { api } from "../api";
import type { ServiceAccountState } from "../types";

/**
 * Подсказка аппарату: в какой служебный ящик входить (Р12).
 *
 * Читается с правом journal.register — аппарат должен видеть, куда подключаться.
 * Пароли сервер не отдаёт: интерфейс показывает только хост, порт, TLS и логин.
 * Подсказка НИЧЕГО не меняет и не расширяет права: выбор служебного ящика — настройка
 * администратора (settings.manage), а добавить ящик в клиент аппарат может только так же,
 * как любой другой ящик. Никакого «подключить за меня» здесь нет.
 */
export function ServiceAccountHint() {
  const can = useStore((s) => s.can);
  const authStatus = useStore((s) => s.authStatus);
  const authUser = useStore((s) => s.authUser);
  const accounts = useStore((s) => s.accounts);
  const [state, setState] = useState<ServiceAccountState | null>(null);
  const [error, setError] = useState("");

  const visible = !!authStatus?.docflowEnabled && !!authUser && can("journal.register");

  const load = useCallback(async () => {
    setError("");
    try {
      setState(await api.serviceAccount());
    } catch (e) {
      // Ошибку показываем один раз и не долбим маршрут: повтор — только кнопкой.
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
  }, [visible, load]);

  if (!visible) return null;

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Не удалось проверить служебный ящик"
        description={error}
        action={
          <Button size="small" onClick={() => void load()}>
            Повторить
          </Button>
        }
        style={{ marginBottom: 12 }}
      />
    );
  }

  if (!state) return null;

  const account = state.account;
  // "ok" — проблем нет; старые сборки могут не отдать код вовсе — считаем так же.
  const problemCode = state.problemCode ?? "ok";
  const connected = !!account && accounts.some((a) => a.username === account.username);

  /** Копируем ровно параметры подключения, без текстов интерфейса. */
  const copyParams = async () => {
    if (!account) return;
    const text =
      "Служебный ящик: " +
      account.username +
      "\nСервер: " +
      account.host +
      ":" +
      account.port +
      ", TLS: " +
      account.tls +
      ", аутентификация: " +
      account.authType +
      "\nSMTP: " +
      account.smtpHost +
      (account.smtpPort ? ":" + account.smtpPort : "") +
      (account.smtpTls ? " (" + account.smtpTls + ")" : "") +
      ", логин " +
      account.smtpUsername;
    try {
      await navigator.clipboard.writeText(text);
      message.success("Параметры скопированы");
    } catch {
      // Буфер обмена может быть недоступен (нет разрешения, http) — говорим об этом честно.
      message.error("Не удалось скопировать — перепишите параметры вручную");
    }
  };

  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      <Space align="center" style={{ marginBottom: 4 }}>
        <Typography.Text strong>Служебный ящик</Typography.Text>
        {connected ? <Tag color="blue">Ящик подключён</Tag> : null}
      </Space>

      {account ? (
        <div>
          <Space size={12} wrap>
            <span>{account.host + ":" + account.port}</span>
            <span>{account.tls}</span>
            <span>{account.username}</span>
          </Space>
          <div style={{ marginTop: 4 }}>
            {account.smtpConfigured ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Отправка настроена
              </Typography.Text>
            ) : account.smtpHostConfigured ? (
              // Адрес есть, а пароля нет: отправка не работает — говорим точнее, чем «не настроена».
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                Адрес SMTP указан, но пароль не задан — отправка не работает. Попросите администратора настроить SMTP у
                ящика.
              </Typography.Text>
            ) : (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                Отправка не настроена — письмо отправить нечем. Попросите администратора настроить SMTP у ящика.
              </Typography.Text>
            )}
          </div>
          {connected ? null : (
            <div style={{ marginTop: 4 }}>
              <Typography.Text style={{ fontSize: 12 }}>
                {"Попросите администратора подключить ящик " + account.username}
              </Typography.Text>
              <div style={{ marginTop: 4 }}>
                <Button size="small" onClick={() => void copyParams()}>
                  Скопировать параметры
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <Typography.Text style={{ fontSize: 12 }}>
          {problemCode === "account_missing"
            ? "Выбранный служебный ящик больше не существует — попросите администратора выбрать другой."
            : problemCode === "not_configured"
              ? "Служебный ящик не выбран: отправка возьмёт первый ящик с настроенной отправкой. Попросите администратора выбрать служебный ящик в настройках."
              : problemCode === "smtp_not_configured"
                ? "У служебного ящика не настроена отправка — письмо отправить нечем."
                : "Служебный ящик не выбран."}
        </Typography.Text>
      )}

      {/* problem — готовый текст для человека. Показываем как есть, плоско, без разметки. */}
      {state.problem ? (
        <Alert type="warning" showIcon message={state.problem} style={{ marginTop: 8 }} />
      ) : null}
    </Card>
  );
}
