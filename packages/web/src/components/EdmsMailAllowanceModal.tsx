import { useEffect, useRef, useState } from "react";
import { Alert, Modal, Select, Skeleton, Typography, message } from "antd";
import { api, resolutionApi } from "../api";
import { edmsAllowanceErrorText, edmsMailOptionTitle } from "./edmsMail";
import type { EdmsMailAllowance } from "../types";

/**
 * Выдача работнику адресов «почты для СЭД» (T57, docs/design/mail-ownership.md).
 *
 * Администратор назначает АДРЕС — обычно выбрав человека в каталоге, — и пароля не вводит:
 * ящик с этим адресом работник заводит сам, своим паролем. Поэтому список ящиков сервера
 * здесь и не нужен: он ничего не говорит о том, что работник сможет подключить, а чужие
 * ящики показывать администратору незачем.
 *
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
  const [value, setValue] = useState<string[]>([]);
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [resetNotice, setResetNotice] = useState("");
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    setLoading(true);
    setError("");
    setResetNotice("");
    setState(null);
    setOptions([]);
    void resolutionApi.userEdmsMailAllowance(user.id).then(
      (allowance) => {
        if (!alive) return;
        setState(allowance);
        // Источник правды — адреса: их и назначает администратор.
        setValue(allowance.addresses ?? []);
        setLoading(false);
      },
      (reason) => {
        if (!alive) return;
        setError(edmsAllowanceErrorText(reason));
        setLoading(false);
      }
    );
    return () => {
      alive = false;
    };
  }, [user]);

  /**
   * Подсказки — из каталога LDAP: администратор называет адрес человека, а не ящик на сервере.
   * Вписать адрес руками можно всегда: ящик работник заведёт сам.
   */
  const search = (query: string) => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q) {
      setOptions([]);
      return;
    }
    searchTimer.current = window.setTimeout(() => {
      void api.searchContacts(q, 20).then(
        (found) =>
          setOptions(
            found
              .filter((c) => !!c.mail)
              .map((c) => ({
                value: c.mail,
                label: c.displayName ? c.displayName + " <" + c.mail + ">" : c.mail
              }))
          ),
        () => setOptions([])
      );
    }, 300);
  };

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const res = await resolutionApi.saveUserEdmsMailAllowance(user.id, value);
      setState(res);
      setValue(res.addresses ?? []);
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
        message.success("Выданные адреса сохранены");
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
          message="Не удалось получить выданные адреса"
          description={error}
        />
      ) : null}

      {!loading && !error ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
            Работник сможет выбрать для писем СЭД только ящики с этими адресами. Пароль от ящика он вводит
            сам — администратору он не нужен. Пустой список — отозвать всё.
          </Typography.Text>
          <Select
            mode="tags"
            style={{ width: "100%" }}
            aria-label="Адреса ящиков для СЭД"
            placeholder="Начните вводить фамилию или адрес"
            value={value}
            onChange={(v) => setValue(v as string[])}
            onSearch={search}
            options={options}
            tokenSeparators={[",", ";"]}
            notFoundContent="Впишите адрес вручную, если его нет в подсказках"
          />
          {state && state.allowed.length ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              У работника уже подключены: {state.allowed.map((a) => edmsMailOptionTitle(a)).join(", ")}
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
