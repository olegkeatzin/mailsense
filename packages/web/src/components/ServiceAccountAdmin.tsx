import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Radio, Space, Typography, message } from "antd";
import { useStore } from "../store";
import { api } from "../api";
import type { ServiceAccountState } from "../types";

/**
 * Выбор служебного ящика отправки (Р12) — только администратор (settings.manage).
 *
 * Здесь выбирается СУЩЕСТВУЮЩИЙ ящик клиента: пароли docflow не хранит и не принимает.
 * Если ящика в клиенте нет — его подключают в разделе «Почта» (пароль шифруется в core).
 */
export function ServiceAccountAdmin() {
  const can = useStore((s) => s.can);
  const authStatus = useStore((s) => s.authStatus);
  const authUser = useStore((s) => s.authUser);
  const accounts = useStore((s) => s.accounts);
  const [state, setState] = useState<ServiceAccountState | null>(null);
  /** accountId или "none" — «не выбран». */
  const [selected, setSelected] = useState<string>("none");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const allowed = !!authStatus?.docflowEnabled && !!authUser && can("settings.manage");

  const load = useCallback(async () => {
    setError("");
    try {
      const s = await api.serviceAccount();
      setState(s);
      setSelected(s.account?.accountId ?? "none");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
  }, [allowed, load]);

  if (!allowed) return null;

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={error.includes("403") ? "Недостаточно прав для этого раздела" : "Не удалось загрузить служебный ящик"}
        description={error.includes("403") ? undefined : error}
      />
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.setServiceAccount(selected === "none" ? null : selected);
      // PUT возвращает тот же shape, что GET — перечитывать не нужно.
      setState(res);
      setSelected(res.account?.accountId ?? "none");
      message.success("Служебный ящик сохранён");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const current = state?.account ?? null;

  return (
    <div>
      <Typography.Text strong style={{ display: "block", marginBottom: 4 }}>
        Служебный ящик отправки
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
        От выбора зависит, с какого ящика уходят поручения руководителю и исполнителям. Ящик должен быть подключён в
        клиенте (раздел «Почта»), а параметры отправки — в настройках самого ящика. Аппарат видит эти параметры в
        подсказке, пароли ему не показываются.
      </Typography.Text>

      {accounts.length ? (
        <Radio.Group value={selected} onChange={(e) => setSelected(String(e.target.value))}>
          <Space direction="vertical">
            <Radio value="none">Не выбран — отправка возьмёт первый ящик с настроенной отправкой</Radio>
            {accounts.map((a) => (
              <Radio key={a.id} value={a.id}>
                {a.username}
              </Radio>
            ))}
          </Space>
        </Radio.Group>
      ) : (
        <Empty description="Ящиков нет — подключите ящик в разделе «Почта»" />
      )}

      {current ? (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {current.host + ":" + current.port + " · " + current.tls + " · " + current.username}
          </Typography.Text>
          <div>
            {current.smtpConfigured ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Отправка настроена
              </Typography.Text>
            ) : (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                Отправка не настроена — поручения уйти не смогут. Настройте SMTP у ящика.
              </Typography.Text>
            )}
          </div>
        </div>
      ) : (
        <Typography.Text type="warning" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          {state?.problemCode === "account_missing"
            ? "Выбранный ящик больше не существует — выберите другой или снимите выбор."
            : "Служебный ящик не выбран: отправка возьмёт первый ящик с настроенной отправкой."}
        </Typography.Text>
      )}

      {state?.problem ? <Alert type="warning" showIcon message={state.problem} style={{ marginTop: 8 }} /> : null}

      <div style={{ marginTop: 12 }}>
        <Button type="primary" loading={saving} disabled={!accounts.length} onClick={() => void save()}>
          Сохранить
        </Button>
      </div>
    </div>
  );
}
