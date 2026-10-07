import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Select, Skeleton, Switch, Typography, message } from "antd";
import { api } from "../api";
import { humanError } from "../utils/humanError";
import { isProfileEmpty } from "../utils/personalSignature";
import type { MailProfile } from "../types";

/**
 * Личные настройки почты работника (T36).
 *
 * Своё имя подписи и своя подпись. Подпись ЯЩИКА при этом не подставляется: шаблон
 * запрашивается с useAccountSignature=false, а тело письма дополняет клиент по этим настройкам.
 * Доступно любому вошедшему — это свои данные, право settings.manage здесь не нужно.
 */
export function MailProfileTab() {
  const [profile, setProfile] = useState<MailProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [signatureText, setSignatureText] = useState("");
  const [signatureEnabled, setSignatureEnabled] = useState(true);
  const [signaturePosition, setSignaturePosition] = useState<"above" | "below">("below");
  const [replyQuote, setReplyQuote] = useState(true);
  const [replyAttribution, setReplyAttribution] = useState<"ru" | "en">("ru");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const apply = useCallback((p: MailProfile) => {
    setProfile(p);
    setDisplayName(p.displayName ?? "");
    setSignatureText(p.signatureText ?? "");
    setSignatureEnabled(p.signatureEnabled !== false);
    setSignaturePosition(p.signaturePosition === "above" ? "above" : "below");
    setReplyQuote(p.replyQuote !== false);
    setReplyAttribution(p.replyAttribution === "en" ? "en" : "ru");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      apply(await api.mailProfile());
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      // Отправляем все поля, которые правит человек. Частичность сервер поддерживает,
      // но так состояние формы и сохранённый профиль не расходятся.
      const saved = await api.saveMailProfile({
        displayName: displayName.trim(),
        signatureText,
        signatureEnabled,
        signaturePosition,
        replyQuote,
        replyAttribution
      });
      apply(saved);
      message.success("Личные настройки сохранены");
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Skeleton active paragraph={{ rows: 4 }} />;

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Не удалось загрузить личные настройки"
        description={error}
        action={
          <Button size="small" onClick={() => void load()}>
            Повторить
          </Button>
        }
      />
    );
  }

  const empty = isProfileEmpty(profile);

  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
        Это ваши личные настройки: имя, которым вы подписываетесь, и ваша подпись. Подпись ящика не
        используется — в письмо попадает только то, что задано здесь.
      </Typography.Text>

      {empty ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Подпись не задана"
          description="Пока профиль пуст, в окне письма подпись не подставляется. Заполните имя подписи и текст — они появятся в новых письмах."
        />
      ) : null}

      <div style={{ marginBottom: 12 }}>
        <Typography.Text style={{ display: "block", marginBottom: 4 }}>Имя подписи</Typography.Text>
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={120}
          showCount
          placeholder="Петрова Мария"
          aria-label="Имя подписи"
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Имя уходит в письмо как имя отправителя; адрес остаётся адресом ящика.
        </Typography.Text>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Typography.Text style={{ display: "block", marginBottom: 4 }}>Текст подписи</Typography.Text>
        <Input.TextArea
          rows={4}
          value={signatureText}
          onChange={(e) => setSignatureText(e.target.value)}
          maxLength={4000}
          showCount
          placeholder="С уважением, Мария Петрова, отдел делопроизводства"
          aria-label="Текст подписи"
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <Switch checked={signatureEnabled} onChange={setSignatureEnabled} />{" "}
        <Typography.Text>Подставлять подпись в письма</Typography.Text>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Typography.Text style={{ display: "block", marginBottom: 4 }}>Положение подписи</Typography.Text>
        <Select
          style={{ width: 260 }}
          value={signaturePosition}
          onChange={(v) => setSignaturePosition(v === "above" ? "above" : "below")}
          aria-label="Положение подписи"
          options={[
            { value: "above", label: "До цитаты письма" },
            { value: "below", label: "После цитаты письма" }
          ]}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <Switch checked={replyQuote} onChange={setReplyQuote} />{" "}
        <Typography.Text>Включать цитату письма в ответ</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
          Если выключить, в ответе останется только ваш текст.
        </Typography.Text>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Typography.Text style={{ display: "block", marginBottom: 4 }}>Язык строки атрибуции</Typography.Text>
        <Select
          style={{ width: 260 }}
          value={replyAttribution}
          onChange={(v) => setReplyAttribution(v === "en" ? "en" : "ru")}
          aria-label="Язык строки атрибуции"
          options={[
            { value: "ru", label: "Русская: «… пишет:»" },
            { value: "en", label: "Английская: «… wrote:»" }
          ]}
        />
      </div>

      <Button type="primary" loading={saving} onClick={() => void save()}>
        Сохранить
      </Button>
    </div>
  );
}
