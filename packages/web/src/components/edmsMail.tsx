import { useCallback, useEffect, useState } from "react";
import { Select, Typography } from "antd";
import { resolutionApi } from "../api";
import { humanError } from "../utils/humanError";
import type { EdmsMailOption, EdmsMailSettings } from "../types";

/**
 * Ящик для писем СЭД (T53).
 *
 * С этого ящика уходят письма руководителю и исполнителям. Ответ контрагенту всегда
 * уходит с ящика, куда письмо пришло, — личный выбор на него не влияет.
 */
export function edmsMailOptionTitle(option: EdmsMailOption): string {
  return (
    option.username +
    (option.host ? " (" + option.host + ")" : "") +
    (option.kind === "service" ? " · служебный" : " · личный") +
    (option.smtpReady ? "" : " — отправка не настроена")
  );
}

/**
 * Чем отправлять по умолчанию: свой выбор, затем предложение сервера
 * (личный рабочий → служебный внутренний), затем любой готовый к отправке.
 */
export function preferredEdmsAccountId(settings: EdmsMailSettings | null): string | null {
  if (!settings) return null;
  if (settings.accountId) return settings.accountId;
  if (settings.defaultAccountId) return settings.defaultAccountId;
  // Сначала готовые к отправке (личный, затем служебный), потом любой из allowed:
  // ящик без настроенной отправки выбрать можно — сервер ответит smtp_not_configured.
  const pick = (kind: "personal" | "service", readyOnly: boolean) =>
    settings.allowed.find((a) => a.kind === kind && (!readyOnly || a.smtpReady))?.id ?? null;
  return pick("personal", true) ?? pick("service", true) ?? pick("personal", false) ?? pick("service", false);
}

/**
 * Ящики для ДЕЙСТВИЙ СЭД (D-T55): ровно то, что сервер разрешает на отправку —
 * служебный внутренний и ЛИЧНЫЙ ВЫБРАННЫЙ работником. Выданные, но не выбранные ящики
 * в действии не показываем: они видны только в «Личных настройках», где их и выбирают.
 * Иначе интерфейс предлагал бы то, что сервер отвергает (403 account_not_allowed).
 */
export function edmsActionOptions(settings: EdmsMailSettings | null): EdmsMailOption[] {
  if (!settings) return [];
  const out: EdmsMailOption[] = [];
  const push = (option: EdmsMailOption | undefined) => {
    if (option && !out.some((o) => o.id === option.id)) out.push(option);
  };
  push(settings.allowed.find((a) => a.kind === "service"));
  push(settings.allowed.find((a) => a.id === settings.accountId));
  return out;
}

/** Предвыбранный ящик в действии: выбор сервера, иначе выбранный личный, иначе служебный. */
export function preferredActionAccountId(settings: EdmsMailSettings | null): string | null {
  const options = edmsActionOptions(settings);
  const has = (id: string | null | undefined) => !!id && options.some((o) => o.id === id);
  // Сначала ЯВНЫЙ выбор работника (личный выбранный), затем предложение сервера, затем служебный.
  if (has(settings?.accountId)) return settings!.accountId;
  if (has(settings?.defaultAccountId)) return settings!.defaultAccountId;
  return options[0]?.id ?? null;
}

/**
 * Почему отправить НЕЛЬЗЯ. Пустая строка — можно.
 * «Первого попавшегося» не берём: без выбора человек видит причину, а письмо не уходит.
 *
 * ⚠️ Ящик без настроенной отправки (smtpReady=false) отправку НЕ блокирует: по контракту T58
 * его можно выбрать, попытка уходит на сервер, а отказ приходит кодом smtp_not_configured.
 * Об этом предупреждаем отдельно (edmsMailWarning), но не мешаем попробовать.
 */
export function edmsMailProblem(settings: EdmsMailSettings | null): string {
  if (!settings) return "Не удалось получить список ящиков для СЭД";
  if (!settings.allowed.length) {
    return "Нет доступных ящиков: попросите администратора подключить ящик для писем СЭД";
  }
  // Отправляем только со служебного или с ЛИЧНОГО ВЫБРАННОГО. Если отправлять не с чего,
  // действие не выполняем: сервер такой запрос всё равно отвергнет, а заведомо провальную
  // попытку не делаем (D-T55).
  if (!edmsActionOptions(settings).length) {
    if (settings.accountId) {
      return "Выбранный ящик для СЭД больше не существует: выберите другой в «Личных настройках» → «Почта для СЭД»";
    }
    return "Не выбран ящик для писем СЭД. Задайте его в «Личных настройках» → «Почта для СЭД»";
  }
  return "";
}

/**
 * Предупреждение (не запрет): у выбранного ящика не настроена отправка.
 * Письмо, скорее всего, не уйдёт — говорим заранее, но отправить не запрещаем.
 */
export function edmsMailWarning(settings: EdmsMailSettings | null): string {
  if (!settings) return "";
  // Работник выбрал ящик, а ящика больше нет (его удалили): выбор остался, отправлять не с чего.
  if (settings.accountId && !settings.allowed.some((a) => a.id === settings.accountId)) {
    return "Выбранный ящик для СЭД больше не существует: выберите другой в «Личных настройках» → «Почта для СЭД»";
  }
  const id = preferredActionAccountId(settings);
  if (!id) return "";
  const option = edmsActionOptions(settings).find((a) => a.id === id);
  if (option && !option.smtpReady) {
    return "У выбранного ящика не настроена отправка: письмо, скорее всего, не уйдёт. Выберите другой ящик или попросите администратора";
  }
  return "";
}

/**
 * Понятный текст отказа отправки по коду сервера (T53/T55).
 *
 * Сервер отвечает 403 «account_not_allowed», когда ящик выбран, но прав на него нет.
 * Показываем, что делать, а не серверную формулировку; для остальных ошибок — обычный humanError.
 */
export function edmsSendErrorText(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  // Список кодов — ровно те, что шлёт сервер: account_not_allowed (403), not_configured
  // (не выбран ящик / служебный снят), no_account, smtp_not_configured, account_missing.
  // Выдуманных кодов не держим: неизвестный код — обычное объяснение сбоя.
  switch (code) {
    case "account_not_allowed":
      return "С этого ящика отправлять нельзя. Выберите другой ящик в «Личных настройках» → «Почта для СЭД»";
    case "not_configured":
    case "no_account":
      return "Не выбран ящик для писем СЭД: задайте его в «Личных настройках» → «Почта для СЭД»";
    case "smtp_not_configured":
      return "У выбранного ящика не настроена отправка: выберите другой ящик или попросите администратора";
    case "account_missing":
      return "Выбранный ящик для СЭД больше не существует. Выберите другой в «Личных настройках» → «Почта для СЭД»";
    default:
      return humanError(error);
  }
}

/** Отказ из-за выбранного ящика: человек чинит это в «Личных настройках → Почта для СЭД». */
export function isEdmsMailError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "smtp_not_configured" ||
    code === "account_missing" ||
    code === "account_not_allowed" ||
    code === "not_configured" ||
    code === "no_account"
  );
}

/** Понятный текст отказа при выдаче ящиков работнику (админский экран, T57). */
export function edmsAllowanceErrorText(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case "unknown_account":
      return "Такого ящика нет: возможно, его отключил администратор. Обновите список ящиков и попробуйте снова";
    case "bad_accounts":
      return "Список ящиков передан неверно. Обновите страницу и повторите";
    case "user_not_found":
      return "Работник не найден: возможно, запись удалили. Обновите список пользователей";
    default:
      return humanError(error);
  }
}

/** Загрузка личного выбора ящика: нужна и настройке, и действиям СЭД. */
export function useEdmsMail(enabled = true) {
  const [settings, setSettings] = useState<EdmsMailSettings | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSettings(await resolutionApi.myEdmsMail());
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { settings, loading, error, reload, setSettings };
}

/** Селектор ящика в действиях СЭД: показывает, откуда уйдёт письмо. */
export function EdmsMailSelect({
  value,
  onChange,
  settings,
  loading
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  settings: EdmsMailSettings | null;
  loading?: boolean;
}) {
  return (
    <div>
      <Typography.Text style={{ display: "block", marginBottom: 4 }}>Ящик для отправки</Typography.Text>
      <Select
        style={{ width: "100%" }}
        value={value ?? undefined}
        loading={loading}
        placeholder="Выберите ящик"
        aria-label="Ящик для отправки"
        onChange={(v) => onChange((v as string) ?? null)}
        options={[
          // Только служебный и выбранный личный (D-T55): выданное-но-не-выбранное сервер отвергнет.
          ...edmsActionOptions(settings).map((a) => ({ value: a.id, label: edmsMailOptionTitle(a) })),
          // Выбранного ящика больше нет в списке: показываем словами, а не идентификатором.
          ...(value && !edmsActionOptions(settings).some((a) => a.id === value)
            ? [{ value, label: "Выбранный ящик больше не существует" }]
            : [])
        ]}
      />
      {edmsMailWarning(settings) ? (
        <Typography.Text type="warning" style={{ fontSize: 12, display: "block" }}>
          {edmsMailWarning(settings)}
        </Typography.Text>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Письмо уйдёт с этого ящика. Ответ контрагенту всегда уходит с ящика, куда письмо пришло.
      </Typography.Text>
    </div>
  );
}
