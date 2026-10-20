import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Select, Skeleton, Switch, Typography, message } from "antd";
import { api } from "../api";
import { humanError } from "../utils/humanError";
import { isProfileEmpty } from "../utils/personalSignature";
import { EdmsMailSection } from "./EdmsMailSection";
import type { MailProfile } from "../types";

/**
 * Личные настройки почты работника (T36).
 *
 * Имя отправителя и правила ответа. Подпись здесь НЕ редактируется — она живёт у ящика:
 * заказчик решил «подпись настраивается в ящике, а в личных настройках выбирается из почты для СЭД».
 * Доступно любому вошедшему — это свои данные, право settings.manage здесь не нужно.
 */
export function MailProfileTab() {
  const [profile, setProfile] = useState<MailProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [replyQuote, setReplyQuote] = useState(true);
  const [replyAttribution, setReplyAttribution] = useState<"ru" | "en">("ru");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const apply = useCallback((p: MailProfile) => {
    setProfile(p);
    setDisplayName(p.displayName ?? "");
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
        Это личные настройки отправки: имя, которым вы подписываетесь, и правила ответа.
        Подпись письма задаётся у самого ящика («Настройки → Почта» → ящик → подпись) — здесь
        второй раз её не спрашиваем, иначе подписи расходились бы.
      </Typography.Text>

      {empty ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Имя отправителя не задано"
          description="Пока имя не заполнено, письма уходят от имени ящика. Задайте имя — оно попадёт в поле «от кого»."
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

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Подпись задаётся в настройках ящика"
        description="В письмо подставляется подпись того ящика, с которого оно уходит: «Настройки → Почта» → выберите ящик → «Подпись». Для писем СЭД берётся подпись ящика, выбранного в разделе «Почта для СЭД» ниже."
      />

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

      {/* Выбор ящика для писем СЭД — тоже личная настройка (T53). */}
      <EdmsMailSection />
    </div>
  );
}
