import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Select, Space, Spin, Switch, Typography, message } from "antd";
import { DeleteOutlined, PaperClipOutlined, SaveOutlined, SendOutlined } from "@ant-design/icons";
import { useStore } from "../store";
import { withoutQuote } from "../utils/personalSignature";
import type { MailProfile } from "../types";
import { api, resolutionApi, attachmentBase64, materializeAttachments, type ComposerAttachment } from "../api";
import type {
  Account,
  ComposeInput,
  ComposeTemplate,
  ComposeTemplateAttachment,
  Draft,
  DraftAttachment,
  EmailAddress,
  EmailView,
  Template
} from "../types";
import { escapeHtml, htmlToPlainText } from "../utils/text";
import { edmsMarkerHeader } from "../utils/edmsMarker";
import RichTextEditor from "./RichTextEditor";
import { humanError } from "../utils/humanError";

type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** Разбирает строку адресов, НЕ разрывая «Иванов, И.И. <a@b>» по запятой внутри имени. */
/** Разбирает строку адресов в {name, address}.
 *  ВАЖНО: не рвёт «Иванов, И.И. <a@b>» по запятой внутри имени — вместо split
 *  ищутся готовые адреса («Имя» <a@b> / Имя <a@b> / a@b), а разделители игнорируются. */
function parseEmails(s: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  const re = /("([^"]*)"|[^<>"@]*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>|([^\s<>,;]+@[^\s<>,;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[3]) {
      const name = (m[2] ?? m[1] ?? "").replace(/^[,\s]+|[,\s]+$/g, "");
      out.push(name ? { name, address: m[3].trim() } : { address: m[3].trim() });
    } else if (m[4]) {
      out.push({ address: m[4].trim() });
    }
  }
  return out;
}

/** Черновик -> шаблон композера (для «Открыть» из списка черновиков). */
function draftToTemplate(d: Draft): ComposeTemplate {
  return {
    accountId: d.accountId,
    mode: "new",
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    bodyText: d.bodyText,
    bodyHtml: d.bodyHtml && d.bodyHtml.trim() ? d.bodyHtml : "<p></p>",
    inReplyToEmailId: d.inReplyToEmailId,
    inReplyToMessageId: d.inReplyToMessageId,
    references: d.references,
    // Вложения черновика передаются отдельно (draftAttachments): в шаблоне вложений
    // нет по определению — там только ссылки на файлы писем.
    attachments: []
  };
}

function fmt(a: EmailAddress): string {
  return a.name ? a.name + " <" + a.address + ">" : a.address;
}

/**
 * Вложение в композере: к данным добавлен стабильный ключ.
 *
 * Индекс как key врал при удалении вложения — React переиспользовал строки
 * не той позиции. Ключ присваивается один раз при добавлении.
 */
type AttachmentItem = ComposerAttachment & { key: string };

let attachmentSeq = 0;
function nextKey(): string {
  attachmentSeq += 1;
  return "att-" + attachmentSeq;
}

/**
 * Вложение из черновика или выбранное человеком.
 * Если сервер уже разложил файл, запоминаем ссылку и НЕ тащим содержимое в браузер:
 * отправка и автосохранение пойдут ссылками, файл прочитает сервер.
 */
function withAttachmentKey(a: DraftAttachment, draftId?: string): AttachmentItem {
  return {
    key: nextKey(),
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    data: a.data,
    draftRef: draftId && a.ref ? { draftId, file: a.ref } : undefined
  };
}

/** Вложение пересылки: в шаблоне только ссылка, файл тянется в момент отправки. */
function refAttachment(a: ComposeTemplateAttachment): AttachmentItem {
  return {
    key: nextKey(),
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    ref: { emailId: a.emailId, attachmentId: a.attachmentId }
  };
}



function readAsBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Не удалось прочитать файл"));
    r.readAsDataURL(f);
  });
}



/** Клиентский запасной шаблон, если сервер не ответил. */
function fallbackTemplate(
  compose: { mode: string; emailId: string | null },
  emailView: EmailView | null,
  accounts: Account[],
  accountFilter: string | null
): ComposeTemplate {
  const accountId = accountFilter ?? accounts[0]?.id ?? "";
  const account = accounts.find((a) => a.id === accountId);
  // Подпись ЯЩИКА здесь НЕ собирается (T36): шаблон запрашивается с useAccountSignature=false,
  // а личную подпись работника добавляет клиент по профилю.
  const tpl: ComposeTemplate = {
    accountId,
    mode: compose.mode as ComposeMode,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    bodyText: "",
    bodyHtml: "<p></p>",
    inReplyToEmailId: null,
    inReplyToMessageId: null,
    references: [],
    attachments: []
  };

  if (compose.mode !== "new" && emailView) {
    const v = emailView;
    const replyTo = v.replyTo.length ? v.replyTo : v.from ? [v.from] : [];
    const base = v.subject.replace(/^\s*(re|fw|fwd)\s*:\s*/i, "");
    if (compose.mode === "reply") {
      tpl.to = replyTo;
      tpl.subject = "Re: " + base;
    } else if (compose.mode === "replyAll") {
      const toKeys = new Set(replyTo.map((a) => a.address.toLowerCase()));
      const self = (account?.username ?? "").toLowerCase();
      const ccMap = new Map<string, EmailAddress>();
      for (const a of [...v.to, ...(v.cc ?? [])]) {
        const key = a.address.toLowerCase();
        if (!key || toKeys.has(key) || key === self) continue;
        if (!ccMap.has(key)) ccMap.set(key, a);
      }
      tpl.to = replyTo;
      tpl.cc = [...ccMap.values()];
      tpl.subject = "Re: " + base;
    } else {
      tpl.subject = "Fwd: " + base;
    }
    tpl.inReplyToEmailId = v.id;
    tpl.inReplyToMessageId = v.messageId;
    tpl.references = [...(v.references ?? []), v.messageId];
    // Пересылка несёт вложения оригинала. Здесь они тоже ссылками: иначе при сбое
    // запроса шаблона вложение молча пропало бы из окна.
    if (compose.mode === "forward" && account?.settings?.forwardAttachments !== false) {
      tpl.attachments = v.attachments
        .filter((a) => a.storagePath)
        .map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          attachmentId: a.id,
          emailId: v.id
        }));
    }
    const who = v.from ? v.from.name || v.from.address : "";
    const when = v.date ? new Date(v.date).toLocaleString("ru-RU") : "";
    const attr = (when ? when + ", " : "") + who + " пишет:";
    const quoted = v.bodyText.split(/\r?\n/).map((l) => "> " + l).join("\n");
    tpl.bodyText = "\n\n" + attr + "\n" + quoted;
    tpl.bodyHtml =
      "<p></p>" +
      '<p class="mailsense-attribution">' + escapeHtml(attr) + "</p>" +
      '<blockquote style="border-left:2px solid #d0d0d0;margin:8px 0;padding-left:10px;color:#555">' +
      (v.bodyHtml || "<pre>" + escapeHtml(v.bodyText) + "</pre>") +
      "</blockquote>";
  } else {
    tpl.bodyText = "";
    tpl.bodyHtml = "<p></p>";
  }
  return tpl;
}

/** Поле адреса с автокомплитом по каталогу (LDAP) + свободный ввод. */
function AddressSelect({
  value,
  onChange,
  placeholder
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const timer = useRef<number | null>(null);

  // Отложенный поиск по каталогу снимаем при закрытии окна: иначе таймер
  // срабатывает уже после размонтирования и пишет в состояние мёртвого компонента.
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  const onSearch = (q: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    const needle = (q ?? "").trim();
    if (needle.length < 2) {
      setOptions([]);
      return;
    }
    timer.current = window.setTimeout(() => {
      api
        .searchContacts(needle, 15)
        .then((list) =>
          setOptions(
            list
              .filter((c) => c.mail || c.displayName)
              .map((c) => ({
                value: c.mail ? (c.displayName ? c.displayName + " <" + c.mail + ">" : c.mail) : c.displayName,
                label:
                  (c.displayName || c.mail) +
                  (c.mail ? " <" + c.mail + ">" : "") +
                  (c.department ? " · " + c.department : "") +
                  (c.title ? " — " + c.title : "")
              }))
          )
        )
        .catch(() => setOptions([]));
    }, 250);
  };

  return (
    <Select
      mode="tags"
      style={{ width: "100%" }}
      placeholder={placeholder}
      value={value}
      onChange={(v) => onChange((v as string[]) ?? [])}
      onSearch={onSearch}
      filterOption={false}
      notFoundContent={null}
      // Запятая НЕ разделитель: «Иванов, И.И. <a@b>» должно остаться одним адресом.
      // Разбор строки делает parseEmails (учитывает <...> и кавычки).
      tokenSeparators={[";"]}
      options={options}
    />
  );
}

const TITLE_BY_MODE: Record<string, string> = {
  new: "Новое письмо",
  reply: "Ответ",
  replyAll: "Ответ всем",
  forward: "Переслать"
};

function ComposerForm({
  template,
  draftId,
  draftAttachments
}: {
  template: ComposeTemplate;
  draftId?: string | null;
  /** Вложения открываемого черновика: данные в них уже есть. */
  draftAttachments?: DraftAttachment[];
}) {
  const closeCompose = useStore((s) => s.closeCompose);
  /** Письмо по документу СЭД: к нему добавляется техническая метка. */
  const edms = useStore((s) => s.compose.edms);
  const loadEmails = useStore((s) => s.loadEmails);
  const accounts = useStore((s) => s.accounts);
  /** Право на отправку (T39/T44): без него кнопка недоступна и есть понятный текст. */
  const canSendMail = useStore((s) => s.canSendMail());
  const fileRef = useRef<HTMLInputElement>(null);

  const [accountId, setAccountId] = useState(() =>
    accounts.some((a) => a.id === template.accountId) ? template.accountId : accounts[0]?.id ?? template.accountId
  );
  const [to, setTo] = useState<string[]>(template.to.map(fmt));
  const [cc, setCc] = useState<string[]>(template.cc.map(fmt));
  const [bcc, setBcc] = useState<string[]>(template.bcc.map(fmt));
  const [subject, setSubject] = useState(template.subject);
  const [attachments, setAttachments] = useState<AttachmentItem[]>(() =>
    draftAttachments
      ? draftAttachments.map((a) => withAttachmentKey(a, draftId ?? undefined))
      : template.attachments.map(refAttachment)
  );
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [plainTextOnly, setPlainTextOnly] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const draftIdRef = useRef<string | null>(draftId ?? null);
  const lastSnapRef = useRef<string>("");

  // Список ящиков мог догрузиться после открытия окна: не оставляем в поле чужой UUID.
  useEffect(() => {
    if (!accounts.length) return;
    if (!accounts.some((a) => a.id === accountId)) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  /** Тело из шаблона: цитата ответа уже внутри, личную подпись добавляем поверх. */
  const baseBodyHtml = (t: ComposeTemplate) => (t.bodyHtml && t.bodyHtml.trim() ? t.bodyHtml : "<p></p>");

  const [bodyHtml, setBodyHtml] = useState(() => baseBodyHtml(template));
  /**
   * Человек правил тело вручную — тогда подпись насильно не дописываем.
   * Флаг, а не сравнение строк: редактор нормализует HTML цитаты, и сравнение
   * «текущее тело равно телу шаблона» ложно срабатывало — из-за этого в ОТВЕТЕ
   * подпись не появлялась вовсе (гонка D12).
   */
  const bodyTouched = useRef(false);
  /** Для какого шаблона тело уже собрано: повторно не пересобираем. */
  const composedFor = useRef("");
  /** Тело собрано хотя бы раз: до этого события редактора — его собственный эхо-ответ. */
  const composedOnce = useRef(false);
  /** Что мы сами записали в редактор последним: по нему отличаем эхо от правки человека. */
  const lastWritten = useRef("");
  /** Профиль прочитан (успешно или нет) — можно собирать тело. */
  const [profileReady, setProfileReady] = useState(false);
  /** Личные настройки работника: имя подписи и сама подпись. */
  const [profile, setProfile] = useState<MailProfile | null>(null);

  useEffect(() => {
    let alive = true;
    // Профиль — вспомогательные данные. Если метод недоступен или запрос не прошёл,
    // окно письма обязано работать как раньше: ничего не подставляем и не падаем.
    // Promise.resolve() переводит возможную синхронную ошибку в отказ, который ловит catch.
    Promise.resolve()
      .then(() => api.mailProfile())
      .then((p) => {
        if (alive) setProfile(p);
      })
      .catch(() => {
        if (alive) setProfile(null);
      })
      .finally(() => {
        if (alive) setProfileReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Тело собирается ОДИН раз для текущего шаблона и ТОЛЬКО когда известен профиль:
   * сначала тело с цитатой (оно приходит из шаблона), затем личная подпись по положению.
   * Так подпись не может быть затёрта шаблоном ответа и наоборот — «кто последний» не решает.
   */
  useEffect(() => {
    const base = baseBodyHtml(template);
    const key = template.mode + "|" + (template.inReplyToEmailId ?? "") + "|" + (template.subject ?? "");
    if (composedFor.current !== key) {
      // Другой шаблон — другой контекст письма: считаем тело нетронутым.
      composedFor.current = key;
      bodyTouched.current = false;
    }
    if (!profileReady || bodyTouched.current) return;
    // ⚠️ Подпись в письмо приходит ОТ ЯЩИКА (шаблон запрашивается с useAccountSignature=true):
    // заказчик решил, что подпись настраивается в ящике, а не второй раз в личных настройках.
    const next = withoutQuote(base, profile);
    lastWritten.current = next;
    composedOnce.current = true;
    // Идемпотентно: то же значение не вызовет лишний рендер.
    setBodyHtml(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileReady, profile, template]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    api
      .templates(accountId)
      .then((list) => {
        if (alive) setTemplates(list);
      })
      .catch(() => {
        /* шаблоны недоступны — не мешаем */
      });
    return () => {
      alive = false;
    };
  }, [accountId]);

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const arr: AttachmentItem[] = [];
    for (const f of Array.from(files)) {
      arr.push(
        withAttachmentKey({
          filename: f.name,
          mimeType: f.type || "application/octet-stream",
          size: f.size,
          data: await readAsBase64(f)
        })
      );
    }
    setAttachments((prev) => [...prev, ...arr]);
  };

  // Пустой редактор = только теги/пробелы.
  const isEmptyHtml = !bodyHtml || bodyHtml.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim() === "";

  /**
   * Адрес ящика, куда пришло письмо: он же replyTo для ответа (Р19).
   * Логин ящика может быть не адресом — тогда replyTo не выдумываем.
   */
  const sourceMailbox = (() => {
    // В форме доступен только сам шаблон: его accountId и есть ящик письма (Р19).
    if (template.mode === "new" || !template.accountId) return "";
    const account = accounts.find((a) => a.id === template.accountId);
    const address = (account?.username ?? "").trim();
    return address.includes("@") ? address : "";
  })();

  /** Поля формы: данных вложений здесь нет — они подставляются в момент отправки. */
  const formState = (): Omit<ComposeInput, "attachments"> => ({
    accountId,
    to: parseEmails(to.join(",")),
    cc: cc.length ? parseEmails(cc.join(",")) : [],
    bcc: bcc.length ? parseEmails(bcc.join(",")) : [],
    subject: subject.trim() || "(без темы)",
    bodyText: htmlToPlainText(bodyHtml),
    bodyHtml: plainTextOnly || isEmptyHtml ? "" : bodyHtml,
    inReplyToEmailId: template.inReplyToEmailId,
    inReplyToMessageId: template.inReplyToMessageId,
    references: template.references,
    // Имя подписи работника: адрес остаётся адресом ящика, человек подписывается своим именем.
    fromName: (profile?.displayName ?? "").trim() || undefined,
    // Ответ возвращается в тот ящик, куда письмо пришло (Р19).
    replyTo: sourceMailbox || undefined
  });

  /**
   * Данные уже загруженных вложений. Пересылка несёт только ссылки, и без кэша
   * автосохранение тянуло бы один и тот же файл на каждое изменение текста.
   */
  const loadedRef = useRef(new Map<string, string>());
  const loadAttachment = async (emailId: string, attachmentId: string): Promise<string> => {
    const cached = loadedRef.current.get(attachmentId);
    if (cached !== undefined) return cached;
    const data = await attachmentBase64(emailId, attachmentId);
    loadedRef.current.set(attachmentId, data);
    return data;
  };

  /**
   * Вложения с данными: файл тянется из письма именно сейчас — при отправке или
   * сохранении черновика. Если файл не пришёл, materializeAttachments бросает
   * ошибку, и письмо НЕ уходит: вложение, которое человек видит, обязано уйти.
   */
  const outgoingAttachments = () => materializeAttachments(attachments, loadAttachment);

  /**
   * Тело запроса для черновика. У разложенных вложений уходит ССЫЛКА, а не base64:
   * файлы уже лежат на сервере, и автосохранение не гоняет десятки мегабайт каждые
   * 15 секунд. Данные отправляются один раз — при первой раскладке файла, а вложение
   * пересылки сервер копирует сам по ссылке на письмо.
   */
  const draftState = () => ({
    ...formState(),
    // Ключ списка — деталь интерфейса, на сервер он не уходит.
    attachments: attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      ...(a.draftRef ? { ref: a.draftRef.file } : a.ref ? { emailRef: a.ref } : { data: a.data })
    }))
  });

  /**
   * После сохранения сервер отдаёт ссылки на файлы черновика. Запоминаем их для
   * автосохранения, но base64 оставляем до отправки: если файл черновика пропадёт,
   * письмо всё равно уйдёт с вложением, которое человек видит.
   */
  const adoptSavedAttachments = (saved: Draft) => {
    setAttachments((prev) =>
      prev.map((item, i) => {
        const att = saved.attachments?.[i];
        // Порядок вложений сохраняется; если сервер вернул другое вложение — не трогаем.
        if (!att?.ref || att.filename !== item.filename || att.size !== item.size) return item;
        return { ...item, draftRef: { draftId: saved.id, file: att.ref } };
      })
    );
  };

  /** Тело запроса с данными вложений — то, что уходит на сервер. */
  const outgoing = async () => ({
    ...formState(),
    attachments: await outgoingAttachments(),
    // Метка СЭД: по ней система на другом конце узнаёт письмо (даже если тред переслали).
    ...(edms ? { headers: edmsMarkerHeader(edms) } : {})
  });

  // Автосохранение живёт в интервале с пустыми зависимостями: состояние берём через ref.
  const draftStateRef = useRef(draftState);
  draftStateRef.current = draftState;
  const adoptSavedRef = useRef(adoptSavedAttachments);
  adoptSavedRef.current = adoptSavedAttachments;

  // Автосохранение черновика: раз в 15 c, если что-то изменилось.
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = draftStateRef.current();
      if (!p.accountId) return;
      const hasContent =
        p.to.length > 0 || p.subject.trim().length > 0 || p.bodyText.trim().length > 0 || p.attachments.length > 0;
      if (!hasContent) return;
      const snap = JSON.stringify({
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        subject: p.subject,
        bodyText: p.bodyText,
        attachments: p.attachments.map((a) => a.filename + ":" + a.size)
      });
      if (snap === lastSnapRef.current) return;
      void (async () => {
        try {
          // ⚠️ Вложения уходят ССЫЛКАМИ (p собран draftState): файлы уже разложены
          // на сервере. Раньше здесь висел base64, и каждые 15 секунд по сети
          // уходили десятки мегабайт.
          const saved = draftIdRef.current
            ? await api.updateDraft(draftIdRef.current, p)
            : await api.createDraft(p);
          draftIdRef.current = saved.id;
          adoptSavedRef.current(saved);
          lastSnapRef.current = snap;
          setDraftSavedAt(new Date());
        } catch {
          /* тихо: черновик не критичен */
        }
      })();
    }, 15000);
    return () => window.clearInterval(id);
  }, []);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSubject(t.subject);
    const html = t.bodyHtml && t.bodyHtml.trim() ? t.bodyHtml : t.bodyText.split(/\r?\n/).map((l) => escapeHtml(l)).join("<br>");
    setBodyHtml("<p></p>" + html);
  };

  const openSaveTemplate = () => {
    setTplName(subject.trim() || "Шаблон");
    setSaveTplOpen(true);
  };

  const confirmSaveTemplate = async () => {
    const name = tplName.trim();
    if (!name) return;
    try {
      const t = await api.createTemplate({
        accountId,
        name,
        subject: subject.trim(),
        bodyText: htmlToPlainText(bodyHtml),
        bodyHtml: bodyHtml && bodyHtml.trim() ? bodyHtml : null
      });
      setTemplates((prev) => [...prev, t].sort((a, b) => a.name.localeCompare(b.name, "ru")));
      setTemplateId(t.id);
      setSaveTplOpen(false);
      message.success("Шаблон сохранён");
    } catch (e) {
      message.error(humanError(e));
    }
  };

  const send = async () => {
    // Отправка закрыта правом mail.send (T39/T44): объясняем, а не молча не отправляем.
    if (!canSendMail) return message.warning("Недостаточно прав для отправки");
    if (!accountId || !accounts.some((a) => a.id === accountId)) {
      // Нет ни одного ящика — человеку нужно не «выберите аккаунт», а что именно сделать.
      return message.warning(
        accounts.length
          ? "Выберите почтовый ящик, с которого отправлять письмо"
          : "У вас нет почтового ящика: добавьте его в «Настройки → Почта» — тогда сможете писать письма"
      );
    }
    if (to.length === 0) return message.warning("Укажите получателя");
    setSending(true);
    try {
      const sent = await api.sendEmail(await outgoing());
      if (draftIdRef.current) {
        try {
          await api.deleteDraft(draftIdRef.current);
        } catch {
          /* ignore */
        }
        draftIdRef.current = null;
      }
      // Письмо по документу: связываем его с поручением, чтобы ответ руководителя нашёлся
      // по треду, а в истории был реальный emailId.
      const edms = useStore.getState().compose.edms;
      if (edms) {
        try {
          if (edms.kind === "dispatch" && edms.resolutionId) {
            // Поручение исполнителям: письмо отправлено человеком, сервер только фиксирует
            // переход и связь — второй раз не шлёт.
            await resolutionApi.dispatch(edms.resolutionId, accountId, { emailId: sent.emailId });
            message.success("Письмо отправлено, поручение передано исполнителям");
          } else if (edms.kind === "report" && edms.resolutionId) {
            // Письмо с отчётом уже отправлено человеком; фиксируем отчёт и связь,
            // автоотправку отключаем, иначе руководитель получит два письма.
            await resolutionApi.report(
              edms.resolutionId,
              htmlToPlainText(bodyHtml),
              sent.emailId,
              accountId,
              true
            );
            message.success("Письмо с отчётом отправлено, отчёт зарегистрирован");
          } else {
            // В «Кому» адрес хранится в формате «Имя <a@b>». Серверу нужен чистый адрес:
            // раньше сюда уходила строка с угловыми скобками, и связь падала с bad_email.
            const recipient = parseEmails(to.join(","))[0] ?? edms.to?.[0];
            const recipientEmail = recipient?.address ?? edms.toEmail;
            const sameAsChosen =
              !!recipientEmail &&
              !!edms.toEmail &&
              recipientEmail.toLowerCase() === edms.toEmail.toLowerCase();
            await resolutionApi.forward(
              edms.documentId,
              sameAsChosen ? (edms.toUserId ?? "") : "",
              undefined,
              {
                emailId: sent.emailId,
                ...(recipientEmail ? { toEmail: recipientEmail } : {})
              }
            );
            message.success("Письмо отправлено и связано с поручением");
          }
        } catch (e) {
          message.warning("Письмо ушло, но поручение не связалось: " + humanError(e));
        }
      } else {
        message.success("Письмо отправлено");
      }
      closeCompose();
      await loadEmails();
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setSending(false);
    }
  };

  const saveDraft = async () => {
    if (!accountId) return message.warning("Выберите аккаунт");
    setSaving(true);
    try {
      // Ручное сохранение: вложения уходят ссылками, как и в автосохранении.
      const saved = draftIdRef.current
        ? await api.updateDraft(draftIdRef.current, draftState())
        : await api.createDraft(draftState());
      draftIdRef.current = saved.id;
      adoptSavedRef.current(saved);
      message.success("Черновик сохранён");
      closeCompose();
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Space direction="vertical" style={{ width: "100%" }} size="small">
        <Select
          // Показываем только существующий ящик: иначе AntD рисует голый UUID.
          value={accounts.some((a) => a.id === accountId) ? accountId : undefined}
          placeholder={accounts.length ? "Выберите ящик" : "Загрузка ящиков…"}
          style={{ width: "100%" }}
          onChange={(v) => setAccountId(v)}
          options={accounts.map((a) => ({
            value: a.id,
            label: a.settings.displayName ? a.settings.displayName + " <" + a.username + ">" : a.username
          }))}
        />
        <Space.Compact style={{ width: "100%" }}>
          <Select
            allowClear
            value={templateId}
            placeholder="Шаблон письма (вставить)"
            style={{ flex: 1 }}
            onChange={(v) => {
              if (v) applyTemplate(v);
              else setTemplateId(undefined);
            }}
            options={templates.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Button onClick={openSaveTemplate}>Сохранить как шаблон</Button>
        </Space.Compact>
        <AddressSelect value={to} onChange={setTo} placeholder="Кому (поиск по каталогу или адрес + Enter)" />
        <AddressSelect value={cc} onChange={setCc} placeholder="Копия (Cc) — поиск по каталогу" />
        <AddressSelect value={bcc} onChange={setBcc} placeholder="Скрытая копия (Bcc) — поиск по каталогу" />
        <Input placeholder="Тема" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <RichTextEditor
          value={bodyHtml}
          onChange={(html) => {
            // Редактор на монтировании отдаёт собственную нормализацию тела (tiptap меняет
            // разметку цитаты) — это не правка человека. Правкой считаем только то,
            // что отличается от последнего записанного нами тела и приходит ПОСЛЕ сборки.
            const isEcho = !composedOnce.current || html === lastWritten.current;
            if (!isEcho) bodyTouched.current = true;
            setBodyHtml(html);
          }}
          placeholder="Напишите письмо…"
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Письмо уходит как HTML с обычной текстовой копией (цитаты — с «&gt;»).
          </Typography.Text>
          <Space size={4}>
            <Typography.Text style={{ fontSize: 12 }}>Только обычный текст</Typography.Text>
            <Switch size="small" checked={plainTextOnly} onChange={setPlainTextOnly} />
          </Space>
        </div>
        <div>
          <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(e) => void onFiles(e.target.files)} />
          <Button icon={<PaperClipOutlined />} onClick={() => fileRef.current?.click()}>
            Прикрепить файлы
          </Button>
        </div>
        {attachments.length > 0 ? (
          <div>
            {attachments.map((a) => (
              <Space key={a.key} style={{ display: "flex", marginBottom: 4 }}>
                <Typography.Text style={{ fontSize: 12 }}>{a.filename}</Typography.Text>
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={"Убрать вложение " + a.filename}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
                />
              </Space>
            ))}
          </div>
        ) : null}
        {draftSavedAt ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Черновик сохранён в {draftSavedAt.toLocaleTimeString("ru-RU")}
          </Typography.Text>
        ) : null}
        <Space style={{ marginTop: 8 }}>
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={sending}
            disabled={!canSendMail}
            title={canSendMail ? undefined : "Недостаточно прав для отправки"}
            onClick={() => void send()}
          >
            Отправить
          </Button>
          <Button icon={<SaveOutlined />} loading={saving} onClick={() => void saveDraft()}>
            Сохранить черновик
          </Button>
          <Button onClick={closeCompose}>Отмена</Button>
        </Space>
      </Space>
      <Modal
        open={saveTplOpen}
        title="Сохранить как шаблон"
        okText="Сохранить"
        cancelText="Отмена"
        onOk={() => void confirmSaveTemplate()}
        onCancel={() => setSaveTplOpen(false)}
      >
        <Input
          autoFocus
          placeholder="Название шаблона"
          value={tplName}
          onChange={(e) => setTplName(e.target.value)}
          onPressEnter={() => void confirmSaveTemplate()}
        />
      </Modal>
    </div>
  );
}


export default function Composer() {
  const compose = useStore((s) => s.compose);
  const closeCompose = useStore((s) => s.closeCompose);
  const emailView = useStore((s) => s.emailView);
  const accounts = useStore((s) => s.accounts);
  const accountFilter = useStore((s) => s.accountFilter);
  const [template, setTemplate] = useState<ComposeTemplate | null>(null);

  useEffect(() => {
    if (!compose.open) {
      setTemplate(null);
      return;
    }
    // Открытие сохранённого черновика: шаблон берём из него, а не с сервера.
    if (compose.draft) {
      setTemplate(draftToTemplate(compose.draft));
      return;
    }
    // Письмо по документу СЭД: текст готовит аппарат-человек, поэтому берём его как есть,
    // а не шаблон с сервера (там был бы жёстко зашитый текст «от аппарата»).
    // Ящик из фильтра мог исчезнуть или быть чужим: подставляем только известный ящик.
    const validFilter = accountFilter && accounts.some((a) => a.id === accountFilter) ? accountFilter : null;
    if (compose.edms) {
      setTemplate({
        accountId: compose.edms.accountId || validFilter || accounts[0]?.id || "",
        mode: "new",
        inReplyToEmailId: null,
        subject: compose.edms.subject,
        bodyHtml: "<p>" + escapeHtml(compose.edms.bodyText).replace(/\n/g, "<br>") + "</p>",
        bodyText: compose.edms.bodyText,
        // Получатель, выбранный в окне «Направить руководителю», не теряется при правке письма.
        to: compose.edms.to ?? [],
        cc: [],
        bcc: [],
        attachments: compose.edms.attachments ?? []
      } as unknown as ComposeTemplate);
      return;
    }
    /**
     * Р19: в ответе ящик берётся из САМОГО письма — ответ внешнему контрагенту уходит
     * с внешней приёмной, ответ руководителю — с внутренней. Выбранный в списке ящик
     * для ответа не подставляем: иначе ответ уйдёт не с того адреса.
     */
    const sourceAccountId = compose.mode !== "new" && emailView?.accountId ? emailView.accountId : "";
    // Ответ должен уходить с ящика получения, но только если этот ящик есть в списке
    // доступных. Иначе Select показывал UUID вместо адреса и шаблон падал без подписи.
    const knownSource = sourceAccountId && accounts.some((a) => a.id === sourceAccountId) ? sourceAccountId : "";
    const accountId = knownSource || validFilter || accounts[0]?.id || "";
    let alive = true;
    setTemplate(null);
    const fb = () => {
      if (alive) setTemplate(fallbackTemplate(compose, emailView, accounts, validFilter));
    };
    if (!accountId) {
      fb();
      return;
    }
    api
      // Подпись берём у ЯЩИКА: одно место настройки, без двойной подписи (решение заказчика).
      .composeTemplate(accountId, compose.mode, compose.emailId, { useAccountSignature: true })
      .then((t) => {
        if (alive) setTemplate(t);
      })
      .catch(fb);
    return () => {
      alive = false;
    };
    // Зависим от открытия/режима/письма и списка ящиков. emailView намеренно не в
    // зависимостях: опрос каждые 4с затирал бы текст. Когда список ящиков догружается,
    // шаблон запрашивается заново уже с настоящим адресом и подписью.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose.open, compose.mode, compose.emailId, compose.draft, accounts.length, accountFilter]);

  return (
    <>
      <Modal
        open={compose.open}
        onCancel={closeCompose}
        footer={null}
        width={720}
        destroyOnClose
        title={TITLE_BY_MODE[compose.mode] ?? "Новое письмо"}
      >
        {compose.open ? (
          template ? (
            <ComposerForm
              key={(compose.draft?.id ?? compose.emailId ?? "new") + ":" + compose.mode}
              template={template}
              draftId={compose.draft?.id ?? null}
              draftAttachments={compose.draft?.attachments}
            />
          ) : (
            <div style={{ padding: 40, textAlign: "center" }}>
              <Spin />
            </div>
          )
        ) : null}
      </Modal>
    </>
  );
}
