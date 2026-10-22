import { useCallback, useEffect, useState } from "react";
import { Button } from "antd";
import { FileAddOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useStore } from "../store";
import type { DocumentRecord } from "../types";
import RegisterModal from "./RegisterModal";

/**
 * Регистрация входящего документа — В САМОМ ПИСЬМЕ, рядом с его текстом.
 *
 * ⚠️ Именно в почте, а не во вкладке «СЭД». Все поля регистрации берутся из письма: номер
 * отправителя, дата, отправитель, число листов, краткое содержание. Заполнять их, не видя письма,
 * нельзя — поэтому форма открывается рядом с текстом, а не поверх него и не в соседней вкладке.
 *
 * ⚠️ Форма НЕ занимает место постоянно: пока её не позвали, видна только кнопка. Иначе она
 * отбирала бы половину ширины у писем, которые регистрировать не нужно.
 */
export function RegisterPanel({ emailId }: { emailId: string }) {
  const can = useStore((s) => s.can);
  const [doc, setDoc] = useState<DocumentRecord | null>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  // Просьба открыть форму, пришедшая из списка «На регистрацию».
  const intent = useStore((s) => s.registerIntent);
  const clearIntent = useStore((s) => s.clearRegisterIntent);

  const load = useCallback(async () => {
    try {
      setDoc(await api.documentByEmail(emailId));
    } catch {
      setDoc(null);
    } finally {
      setReady(true);
    }
  }, [emailId]);

  /**
   * Статус «зарегистрировано ли письмо» читается маршрутом с правом journal.view.
   * Без него запрос всё равно ответит 403 — не дёргаем сервер зря. Кнопка регистрации
   * при этом остаётся: право journal.register самостоятельное.
   */
  const canViewJournal = can("journal.view");

  useEffect(() => {
    setReady(false);
    // Перешли к другому письму — форма снова свёрнута.
    setOpen(false);
    if (!canViewJournal) {
      setDoc(null);
      setReady(true);
      return;
    }
    void load();
  }, [load, canViewJournal]);

  // Намерение из списка: открыть форму сразу. Снимаем его, чтобы оно не сработало повторно.
  useEffect(() => {
    if (intent && intent === emailId) {
      setOpen(true);
      clearIntent();
    }
  }, [intent, emailId, clearIntent]);

  // Нечего предлагать: нет права или письмо уже в журнале.
  if (!can("journal.register") || !ready || doc) return null;

  if (!open) {
    return (
      <div style={{ flexShrink: 0 }}>
        <Button type="primary" icon={<FileAddOutlined />} onClick={() => setOpen(true)}>
          Зарегистрировать
        </Button>
      </div>
    );
  }

  return (
    <div style={{ width: 520, flexShrink: 0 }}>
      <div style={{ textAlign: "right", marginBottom: 4 }}>
        <Button type="link" size="small" onClick={() => setOpen(false)}>
          Свернуть
        </Button>
      </div>
      <RegisterModal
        emailId={emailId}
        onRegistered={() => {
          setOpen(false);
          void load();
        }}
      />
    </div>
  );
}