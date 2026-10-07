import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Radio, Space, Typography, message } from "antd";
import { useStore } from "../store";
import { api } from "../api";
import type { ServiceAccountBlock, ServiceAccountState } from "../types";
import { humanError } from "../utils/humanError";

/**
 * Служебные ящики (Р12 + T25) — только администратор (settings.manage).
 *
 * Две роли, и путать их нельзя:
 *  • ВНУТРЕННЯЯ (делопроизводство) — с неё уходит письмо руководителю и исполнителям;
 *  • ВНЕШНЯЯ (приёмная) — куда приходит внешняя почта от контрагентов.
 *
 * Правило Р19: ответ внешнему контрагенту уходит с того ящика, куда пришло письмо
 * (композер берёт ящик письма), а пересылка руководителю — всегда с внутренней.
 *
 * Выбирается СУЩЕСТВУЮЩИЙ ящик клиента: пароли docflow не хранит и не принимает.
 * Если ящика в клиенте нет — его подключают в разделе «Почта» (пароль шифруется в core).
 */
export function ServiceAccountAdmin() {
  const can = useStore((s) => s.can);
  const authStatus = useStore((s) => s.authStatus);
  const authUser = useStore((s) => s.authUser);
  const accounts = useStore((s) => s.accounts);
  const [state, setState] = useState<ServiceAccountState | null>(null);
  /** accountId или "none" — «не выбран». */
  const [inner, setInner] = useState<string>("none");
  const [incoming, setIncoming] = useState<string>("none");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const allowed = !!authStatus?.docflowEnabled && !!authUser && can("settings.manage");

  const applyState = useCallback((s: ServiceAccountState) => {
    setState(s);
    setInner(s.account?.accountId ?? "none");
    // Старая сборка сервера не отдаёт приёмную роль — тогда селектор честно остаётся «не выбран».
    setIncoming(s.incoming?.account?.accountId ?? "none");
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      applyState(await api.serviceAccount());
    } catch (e) {
      setError(humanError(e));
    }
  }, [applyState]);

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
        message={error.includes("Недостаточно прав") ? "Недостаточно прав для этого раздела" : "Не удалось загрузить служебные ящики"}
        description={error.includes("Недостаточно прав") ? undefined : error}
      />
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      // Отправляем ОБЕ роли одним вызовом: так нельзя случайно снять чужой выбор.
      const res = await api.setServiceAccount({
        accountId: inner === "none" ? null : inner,
        incomingAccountId: incoming === "none" ? null : incoming
      });
      // PUT возвращает тот же shape, что GET — перечитывать не нужно.
      applyState(res);
      message.success("Служебные ящики сохранены");
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setSaving(false);
    }
  };

  /** Человеческий текст состояния одной роли: что с выбором и что мешает. */
  const roleProblem = (block: ServiceAccountBlock | undefined, what: string): string | null => {
    if (!block) return null;
    if (block.problemCode === "account_missing") return "Выбранный ящик " + what + " больше не существует — выберите другой или снимите выбор.";
    if (block.problemCode === "not_configured") return "Ящик " + what + " не выбран: " + what + " работать не будет.";
    return null;
  };

  const innerBlock = state ?? undefined;
  const incomingBlock = state?.incoming;

  const rolePicker = (
    /** Имя радиогруппы обязательно своё: без него браузер считает обе группы одной. */
    name: string,
    title: string,
    hint: string,
    value: string,
    onChange: (v: string) => void
  ) => (
    <div role="group" aria-label={title} style={{ marginTop: 12 }}>
      <Typography.Text strong style={{ display: "block" }}>
        {title}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
        {hint}
      </Typography.Text>
      {accounts.length ? (
        <Radio.Group name={name} value={value} onChange={(e) => onChange(String(e.target.value))}>
          <Space direction="vertical">
            <Radio value="none">Не выбран</Radio>
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
    </div>
  );

  return (
    <div>
      <Typography.Text strong style={{ display: "block", marginBottom: 4 }}>
        Служебные ящики
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
        Внутренняя — от неё уходит письмо руководителю и исполнителям. Внешняя (приёмная) — куда приходит
        внешняя почта от контрагентов. Ответ внешнему контрагенту уходит с того ящика, куда пришло письмо;
        пересылка руководителю — всегда с внутренней.
      </Typography.Text>

      {roleProblem(innerBlock, "внутренней роли") ? (
        <Alert type="warning" showIcon style={{ marginTop: 8 }} message={roleProblem(innerBlock, "внутренней роли")} />
      ) : null}

      {rolePicker(
        "service-account-inner",
        "Внутренняя (делопроизводство)",
        "С неё уходит письмо руководителю на резолюцию и поручения исполнителям.",
        inner,
        setInner
      )}

      {rolePicker(
        "service-account-incoming",
        "Внешняя (приёмная)",
        "Куда приходит внешняя почта — с неё же уходит ответ контрагенту по этому письму.",
        incoming,
        setIncoming
      )}

      {roleProblem(incomingBlock, "внешней приёмной") ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message={roleProblem(incomingBlock, "внешней приёмной")}
        />
      ) : null}

      {/* Предупреждение сервера показываем как есть: свой текст здесь был бы домыслом. */}
      {state?.sameAccount && state.notice ? (
        <Alert type="warning" showIcon style={{ marginTop: 12 }} message={state.notice} />
      ) : null}

      {state?.problem ? (
        <Alert type="warning" showIcon style={{ marginTop: 8 }} message={state.problem} />
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Button type="primary" loading={saving} disabled={!accounts.length} onClick={() => void save()}>
          Сохранить
        </Button>
      </div>
    </div>
  );
}
