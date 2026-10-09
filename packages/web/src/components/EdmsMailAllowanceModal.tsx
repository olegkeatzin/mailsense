import { useEffect, useState } from "react";
import { Alert, Button, Modal, Select, Skeleton, Typography, message } from "antd";
import { api, resolutionApi } from "../api";
import { edmsAllowanceErrorText, edmsMailOptionTitle } from "./edmsMail";
import type { Account, EdmsMailAllowance } from "../types";

/**
 * Выдача ящиков работнику для СЭД (T57).
 *
 * Здесь администратор решает, какие ящики работник вправе выбрать в «Личных настройках → Почта для СЭД».
 * Если отозвать уже выбранный ящик, сервер сбрасывает выбор работника — об этом администратору
 * сообщаем прямо здесь, иначе непонятно, почему у человека пропала настройка.
 */
export function EdmsMailAllowanceModal({
  user,
  onClose
}: {
  user: { id: string; fullName: string } | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<EdmsMailAllowance | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [value, setValue] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [resetNotice, setResetNotice] = useState("");

  useEffect(() => {
    if (!user) return;
    let alive = true;
    setLoading(true);
    setError("");
    setResetNotice("");
    setState(null);
    void Promise.allSettled([resolutionApi.userEdmsMailAllowance(user.id), api.accounts()]).then(([allowance, all]) => {
      if (!alive) return;
      if (allowance.status === "fulfilled") {
        setState(allowance.value);
        setValue(allowance.value.accountIds);
      } else {
        setError(edmsAllowanceErrorText(allowance.reason));
      }
      // Список всех ящиков нужен, чтобы выдать новый; без права на почту его не будет —
      // тогда показываем уже выданные и честно об этом говорим.
      setAccounts(all.status === "fulfilled" ? all.value : []);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [user]);

  const options = (() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(a.id, a.username);
    for (const a of state?.allowed ?? []) map.set(a.id, edmsMailOptionTitle(a));
    return [...map.entries()].map(([v, label]) => ({ value: v, label }));
  })();

  const listUnavailable = !accounts.length && !loading;

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const res = await resolutionApi.saveUserEdmsMailAllowance(user.id, value);
      setState(res);
      setValue(res.accountIds);
      if (res.resetChoice) {
        // Выбор работника сброшен: называем ящик по-человечески. Если сервер уже не отдаёт
        // его в allowed, берём имя из того, что было до сохранения; идентификатор не показываем.
        const title =
          res.allowed.find((a) => a.id === res.resetChoice)?.username ??
          state?.allowed.find((a) => a.id === res.resetChoice)?.username ??
          "";
        setResetNotice(
          "Выбор работника сброшен: " +
            (title ? "ящик «" + title + "» больше не выдан." : "выбранный ящик больше не выдан.") +
            " Работник выберет другой в «Личных настройках» → «Почта для СЭД»."
        );
      } else {
        message.success("Выданные ящики сохранены");
      }
    } catch (e) {
      message.error(edmsAllowanceErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!user}
      title={"Ящики для СЭД: " + (user?.fullName ?? "")}
      onCancel={onClose}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={saving}
      onOk={() => void save()}
      width={620}
    >
      {loading ? <Skeleton active paragraph={{ rows: 2 }} /> : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="Не удалось получить выданные ящики"
          description={error}
        />
      ) : null}

      {!loading && !error ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
            Работник сможет выбрать для писем СЭД только отмеченные здесь ящики. Пустой список — отозвать всё.
          </Typography.Text>
          <Select
            mode="multiple"
            style={{ width: "100%" }}
            aria-label="Выданные ящики"
            placeholder="Ящики не выданы"
            value={value}
            onChange={(v) => setValue(v as string[])}
            options={options}
            notFoundContent={listUnavailable ? "Список ящиков недоступен без права на почту" : "Ящиков нет"}
          />
          {listUnavailable ? (
            <Typography.Text type="warning" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              Полный список ящиков недоступен: нет права на почту. Показаны только уже выданные.
            </Typography.Text>
          ) : null}
          {resetNotice ? (
            <Alert type="warning" showIcon style={{ marginTop: 12 }} message={resetNotice} />
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
