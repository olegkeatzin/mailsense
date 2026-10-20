import { useEffect, useState } from "react";
import { Alert, Button, Divider, Select, Skeleton, Typography, message } from "antd";
import { resolutionApi } from "../api";
import { useStore } from "../store";
import { humanError } from "../utils/humanError";
import { edmsMailOptionTitle, edmsMailProblem, edmsMailWarning, edmsSendErrorText, useEdmsMail } from "./edmsMail";

/**
 * Раздел «Почта для СЭД» в личных настройках (T53).
 *
 * Работник сам решает, с какого ящика уходят письма по документообороту. Если адрес
 * задал администратор файлом предприятия, служебный ящик всё равно виден здесь.
 */
export function EdmsMailSection() {
  const { settings, loading, error, reload, setSettings } = useEdmsMail(true);
  // Подпись берём у ЯЩИКА (решение заказчика): здесь только показываем её выбранного.
  const accounts = useStore((st) => st.accounts);
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) setValue(settings.accountId);
  }, [settings]);

  if (loading && !settings) return <Skeleton active paragraph={{ rows: 2 }} />;

  if (error && !settings) {
    return (
      <Alert
        type="error"
        showIcon
        message="Не удалось загрузить выбор ящика"
        description={error}
        action={
          <Button size="small" onClick={() => void reload()}>
            Повторить
          </Button>
        }
      />
    );
  }

  const selectedAccount = accounts.find((a) => a.id === value) ?? null;
  const selectedSignature = selectedAccount ? String(selectedAccount.settings?.signature ?? "").trim() : "";
  const problem = settings ? edmsMailProblem(settings) : "";
  // Ящик без настроенной отправки: не запрет, а предупреждение (контракт T58).
  const warning = settings ? edmsMailWarning(settings) : "";
  const noMailboxes = !!settings && settings.allowed.length === 0;

  const save = async () => {
    setSaving(true);
    try {
      const saved = await resolutionApi.saveMyEdmsMail(value);
      setSettings(saved);
      setValue(saved.accountId);
      message.success("Ящик для СЭД сохранён");
    } catch (e) {
      // 403 account_not_allowed на сохранении: объясняем, что ящик недоступен.
      message.error(edmsSendErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Divider style={{ margin: "8px 0 12px" }} />
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Почта для СЭД
      </Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
        С этого ящика уходят письма руководителю и исполнителям. Ответ контрагенту всегда уходит с ящика,
        куда письмо пришло, — здесь это не настраивается. Если ничего не выбрать, письма по
        документообороту уходить не будут: «первый подходящий» ящик система не подставляет.
      </Typography.Text>

      {noMailboxes ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Доступных ящиков нет"
          description="Попросите администратора подключить ящик — после этого его можно будет выбрать здесь."
        />
      ) : (
        <>
          <Select
            style={{ width: "100%", marginBottom: 8 }}
            value={value ?? "none"}
            aria-label="Ящик для СЭД"
            onChange={(v) => setValue(v === "none" ? null : (v as string))}
            options={[
              { value: "none", label: "Не выбран" },
              ...(settings?.allowed ?? []).map((a) => ({ value: a.id, label: edmsMailOptionTitle(a) })),
              // Выбор остался, а ящика больше нет: показываем словами, идентификатор не светим.
              ...(value && !(settings?.allowed ?? []).some((a) => a.id === value)
                ? [{ value, label: "Выбранный ящик больше не существует" }]
                : [])
            ]}
          />
          {selectedAccount ? (
            <div style={{ marginBottom: 8 }}>
              <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                Подпись выбранного ящика
              </Typography.Text>
              <Typography.Paragraph style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                {selectedSignature ||
                  "не задана — задаётся в «Настройки → Почта» → выберите ящик → «Подпись»"}
              </Typography.Paragraph>
            </div>
          ) : null}
          {problem || warning ? (
            <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={problem || warning} />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
              Письма СЭД уйдут с выбранного ящика.
            </Typography.Text>
          )}
          <Button type="primary" loading={saving} onClick={() => void save()}>
            Сохранить выбор
          </Button>
        </>
      )}
    </div>
  );
}
