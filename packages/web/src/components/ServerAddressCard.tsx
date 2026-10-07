import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Skeleton, Space, Typography, message } from "antd";
import { serverBridge, serverSourceTitle, type ServerConfig } from "../ipc";

/**
 * Адрес сервера документооборота (тонкий клиент, Т37/Т43).
 *
 * Показываем ТЕКУЩИЙ адрес и его источник человеческим текстом. Если адрес задал
 * администратор файлом рядом с программой — поле только для чтения: переписывать
 * админский адрес нельзя. Если файл конфигурации не разобрался — говорим об этом
 * честно и объясняем, что приложение работает автономно, а не делаем вид, что «подключено».
 */
export function ServerAddressCard() {
  const bridge = serverBridge();
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    if (!bridge) return;
    setLoadError("");
    try {
      const next = await bridge.getServerConfig();
      setConfig(next);
      setValue(next.serverUrl ?? "");
    } catch (e) {
      // Мост есть, но ответа нет: это не «подключено», это ошибка — и о ней надо сказать.
      setLoadError(e instanceof Error ? e.message : "Не удалось получить адрес сервера");
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  // В браузере моста нет: адрес задаёт сервер, который отдал страницу.
  if (!bridge) {
    return (
      <div>
        <Typography.Text style={{ display: "block", marginBottom: 4 }}>Адрес сервера</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          В браузере адрес задаётся сервером, который открыл эту страницу. Сменить его можно в приложении
          MailSense на рабочем месте.
        </Typography.Text>
      </div>
    );
  }

  if (!config && loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Не удалось получить адрес сервера"
        description={loadError}
        action={
          <Button size="small" onClick={() => void load()}>
            Повторить
          </Button>
        }
      />
    );
  }

  if (!config) return <Skeleton active paragraph={{ rows: 2 }} />;

  const readOnly = config.managedByAdmin;

  const save = async () => {
    if (!bridge) return;
    setBusy(true);
    try {
      const res = await bridge.setServerUrl(value.trim());
      if (res?.ok === false) {
        // Отказ администратора или сервера показываем его же словами, а не молчим.
        message.error(res.error || "Не удалось сохранить адрес");
        return;
      }
      message.warning("Адрес сохранён. Перезапустите приложение, чтобы он применился.");
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Не удалось сохранить адрес");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!bridge) return;
    setBusy(true);
    try {
      const res = await bridge.clearServerUrl();
      if (res?.ok === false) {
        message.error(res.error || "Не удалось сбросить адрес");
        return;
      }
      message.warning("Адрес сброшен — журнал будет локальным. Перезапустите приложение.");
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Не удалось сбросить адрес");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Typography.Text style={{ display: "block", marginBottom: 4 }}>Адрес сервера</Typography.Text>
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        <Input
          value={value}
          readOnly={readOnly}
          disabled={readOnly}
          onChange={(e) => setValue(e.target.value)}
          placeholder="http://сервер:8123"
          aria-label="Адрес сервера"
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Текущий адрес: {config.serverUrl || "не задан"} · источник: {serverSourceTitle(config.source)}
        </Typography.Text>

        {readOnly ? (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            Адрес задан администратором — изменить нельзя
          </Typography.Text>
        ) : null}

        {config.error ? (
          <Alert
            type="error"
            showIcon
            message={config.error}
            description="Адрес из файла настроек не применён: приложение работает автономно, пока адрес не исправят."
          />
        ) : null}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Адрес можно раздать файлом server.json рядом с программой — тогда его задаёт администратор, а
          сотрудникам менять ничего не нужно.
        </Typography.Text>

        <Space>
          <Button type="primary" size="small" loading={busy} disabled={readOnly} onClick={() => void save()}>
            Сохранить адрес
          </Button>
          <Button size="small" loading={busy} disabled={readOnly} onClick={() => void clear()}>
            Сбросить
          </Button>
        </Space>
      </Space>
    </div>
  );
}
