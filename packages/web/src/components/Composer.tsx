import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Select, Space, Spin, Switch, Typography, message } from "antd";
import { DeleteOutlined, PaperClipOutlined, SaveOutlined, SendOutlined } from "@ant-design/icons";
import { useStore } from "../store";
import { api } from "../api";
import type { Account, ComposeTemplate, Draft, DraftAttachment, EmailAddress, EmailView, Template } from "../types";
import { escapeHtml, htmlToPlainText } from "../utils/text";
import RichTextEditor from "./RichTextEditor";

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
    attachments: d.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size, data: a.data }))
  };
}

function fmt(a: EmailAddress): string {
  return a.name ? a.name + " <" + a.address + ">" : a.address;
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
  const sigText = ((account?.settings?.signature as string) ?? "").trim();
  const sigRich = ((account?.settings?.signatureHtml as string) ?? "").trim();
  const delimiter = account?.settings?.signatureDelimiter !== false;
  const sigHead = '<div class="mailsense-signature">' + (delimiter ? '<div class="mailsense-signature-delim">-- </div>' : "");
  const sigHtml =
    sigRich && sigRich !== "<p></p>"
      ? sigHead + sigRich + "</div>"
      : sigText
        ? sigHead + escapeHtml(sigText).replace(/\n/g, "<br>") + "</div>"
        : "";
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
    const who = v.from ? v.from.name || v.from.address : "";
    const when = v.date ? new Date(v.date).toLocaleString("ru-RU") : "";
    const attr = (when ? when + ", " : "") + who + " пишет:";
    const quoted = v.bodyText.split(/\r?\n/).map((l) => "> " + l).join("\n");
    tpl.bodyText = "\n\n" + attr + "\n" + quoted + (sigText ? "\n\n" + (delimiter ? "-- \n" : "") + sigText : "");
    tpl.bodyHtml =
      "<p></p>" +
      '<p class="mailsense-attribution">' + escapeHtml(attr) + "</p>" +
      '<blockquote style="border-left:2px solid #d0d0d0;margin:8px 0;padding-left:10px;color:#555">' +
      (v.bodyHtml || "<pre>" + escapeHtml(v.bodyText) + "</pre>") +
      "</blockquote>" +
      sigHtml;
  } else {
    tpl.bodyText = sigText ? "\n\n" + (delimiter ? "-- \n" : "") + sigText : "";
    tpl.bodyHtml = "<p></p>" + sigHtml;
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

function ComposerForm({ template, draftId }: { template: ComposeTemplate; draftId?: string | null }) {
  const closeCompose = useStore((s) => s.closeCompose);
  const loadEmails = useStore((s) => s.loadEmails);
  const accounts = useStore((s) => s.accounts);
  const fileRef = useRef<HTMLInputElement>(null);

  const [accountId, setAccountId] = useState(template.accountId);
  const [to, setTo] = useState<string[]>(template.to.map(fmt));
  const [cc, setCc] = useState<string[]>(template.cc.map(fmt));
  const [bcc, setBcc] = useState<string[]>(template.bcc.map(fmt));
  const [subject, setSubject] = useState(template.subject);
  const [attachments, setAttachments] = useState<DraftAttachment[]>(
    template.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: Math.floor((a.data.length * 3) / 4),
      data: a.data
    }))
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

  const [bodyHtml, setBodyHtml] = useState(template.bodyHtml && template.bodyHtml.trim() ? template.bodyHtml : "<p></p>");

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
    const arr: DraftAttachment[] = [];
    for (const f of Array.from(files)) {
      arr.push({ filename: f.name, mimeType: f.type || "application/octet-stream", size: f.size, data: await readAsBase64(f) });
    }
    setAttachments((prev) => [...prev, ...arr]);
  };

  // Пустой редактор = только теги/пробелы.
  const isEmptyHtml = !bodyHtml || bodyHtml.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim() === "";

  const payload = () => ({
    accountId,
    to: parseEmails(to.join(",")),
    cc: cc.length ? parseEmails(cc.join(",")) : [],
    bcc: bcc.length ? parseEmails(bcc.join(",")) : [],
    subject: subject.trim() || "(без темы)",
    bodyText: htmlToPlainText(bodyHtml),
    bodyHtml: plainTextOnly || isEmptyHtml ? "" : bodyHtml,
    attachments,
    inReplyToEmailId: template.inReplyToEmailId,
    inReplyToMessageId: template.inReplyToMessageId,
    references: template.references
  });

  const payloadFnRef = useRef(payload);
  payloadFnRef.current = payload;

  // Автосохранение черновика: раз в 15 c, если что-то изменилось.
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = payloadFnRef.current();
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
          if (draftIdRef.current) await api.updateDraft(draftIdRef.current, p);
          else draftIdRef.current = (await api.createDraft(p)).id;
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
      message.error((e as Error).message);
    }
  };

  const send = async () => {
    if (!accountId) return message.warning("Выберите аккаунт");
    if (to.length === 0) return message.warning("Укажите получателя");
    setSending(true);
    try {
      await api.sendEmail(payload());
      if (draftIdRef.current) {
        try {
          await api.deleteDraft(draftIdRef.current);
        } catch {
          /* ignore */
        }
        draftIdRef.current = null;
      }
      message.success("Письмо отправлено");
      closeCompose();
      await loadEmails();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const saveDraft = async () => {
    if (!accountId) return message.warning("Выберите аккаунт");
    setSaving(true);
    try {
      if (draftIdRef.current) await api.updateDraft(draftIdRef.current, payload());
      else draftIdRef.current = (await api.createDraft(payload())).id;
      message.success("Черновик сохранён");
      closeCompose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Space direction="vertical" style={{ width: "100%" }} size="small">
        <Select
          value={accountId || undefined}
          placeholder="От имени (аккаунт)"
          style={{ width: "100%" }}
          onChange={(v) => setAccountId(v)}
          options={accounts.map((a) => ({ value: a.id, label: a.settings.displayName ? a.settings.displayName + " <" + a.username + ">" : a.username }))}
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
        <RichTextEditor value={bodyHtml} onChange={setBodyHtml} placeholder="Напишите письмо…" />
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
            {attachments.map((a, i) => (
              <Space key={i} style={{ display: "flex", marginBottom: 4 }}>
                <Typography.Text style={{ fontSize: 12 }}>{a.filename}</Typography.Text>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} />
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
          <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={() => void send()}>
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
    const accountId = accountFilter ?? accounts[0]?.id ?? "";
    let alive = true;
    setTemplate(null);
    const fb = () => {
      if (alive) setTemplate(fallbackTemplate(compose, emailView, accounts, accountFilter));
    };
    if (!accountId) {
      fb();
      return;
    }
    api
      .composeTemplate(accountId, compose.mode, compose.emailId)
      .then((t) => {
        if (alive) setTemplate(t);
      })
      .catch(fb);
    return () => {
      alive = false;
    };
    // Зависим только от открытия/режима/письма: опрос каждые 4с обновляет emailView,
    // и пересборка шаблона во время редактирования затирала бы текст.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose.open, compose.mode, compose.emailId, compose.draft]);

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
