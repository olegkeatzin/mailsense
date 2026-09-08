import { useRef, useState, type ReactNode } from "react";
import { Button, Input, Modal, Select, Space, Typography, message } from "antd";
import {
  BoldOutlined,
  DeleteOutlined,
  ItalicOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PaperClipOutlined,
  SaveOutlined,
  SendOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UnorderedListOutlined
} from "@ant-design/icons";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useStore } from "../store";
import { api } from "../api";
import type { Account, DraftAttachment, EmailAddress, EmailView } from "../types";

function parseEmails(s: string): EmailAddress[] {
  return s
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const m = t.match(/^(.*)<([^>]+)>$/);
      if (m) return { name: m[1].trim() || undefined, address: m[2].trim() };
      return { address: t };
    });
}

function fmt(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readAsBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Не удалось прочитать файл"));
    r.readAsDataURL(f);
  });
}

function quoteHtml(v: { date: string | null; from: EmailAddress | null; bodyHtml: string | null; bodyText: string }): string {
  const who = v.from ? v.from.name || v.from.address : "(неизвестен)";
  const when = v.date ? new Date(v.date).toLocaleString("ru-RU") : "";
  const inner = v.bodyHtml || "<pre>" + escapeHtml(v.bodyText) + "</pre>";
  return (
    '<blockquote style="border-left:2px solid #d0d0d0;padding-left:10px;margin:12px 0;color:#555">' +
    "<div>" + escapeHtml(who) + (when ? " · " + escapeHtml(when) : "") + ":</div>" +
    inner +
    "</blockquote>"
  );
}

interface Prefill {
  accountId: string;
  to: string[];
  cc: string[];
  subject: string;
  inReply: { emailId: string | null; messageId: string | null; references: string[] };
  html: string;
}

function buildPrefill(
  compose: { mode: string; emailId: string | null },
  emailView: EmailView | null,
  accounts: Account[],
  accountFilter: string | null
): Prefill {
  const defAccount = accountFilter ?? accounts[0]?.id ?? "";
  const self = accounts.find((a) => a.id === defAccount)?.username ?? "";
  const res: Prefill = {
    accountId: defAccount,
    to: [],
    cc: [],
    subject: "",
    inReply: { emailId: null, messageId: null, references: [] },
    html: ""
  };
  const mode = compose.mode;
  if ((mode === "reply" || mode === "replyAll" || mode === "forward") && emailView) {
    const v = emailView;
    const replyTo = v.replyTo.length ? v.replyTo : v.from ? [v.from] : [];
    const base = v.subject.replace(/^\s*(re|fw|fwd)\s*:\s*/i, "");
    if (mode === "reply") {
      res.to = replyTo.map(fmt);
      res.subject = "Re: " + base;
    } else if (mode === "replyAll") {
      const toAddr = new Set(replyTo.map((a) => a.address.toLowerCase()));
      const seen = new Set<string>();
      const ccList: EmailAddress[] = [];
      for (const a of [...v.to, ...(v.cc ?? [])]) {
        const key = a.address.toLowerCase();
        if (seen.has(key) || toAddr.has(key)) continue;
        if (self && key === self.toLowerCase()) continue;
        seen.add(key);
        ccList.push(a);
      }
      res.to = replyTo.map(fmt);
      res.cc = ccList.map(fmt);
      res.subject = "Re: " + base;
    } else {
      res.subject = "Fwd: " + base;
    }
    res.inReply = { emailId: v.id, messageId: v.messageId, references: [v.messageId, ...(v.references ?? [])] };
    res.html = quoteHtml(v) + "<p></p>";
  }
  return res;
}

const TITLE_BY_MODE: Record<string, string> = {
  new: "Новое письмо",
  reply: "Ответ",
  replyAll: "Ответ всем",
  forward: "Переслать"
};

function ComposerForm() {
  const compose = useStore((s) => s.compose);
  const closeCompose = useStore((s) => s.closeCompose);
  const emailView = useStore((s) => s.emailView);
  const accounts = useStore((s) => s.accounts);
  const accountFilter = useStore((s) => s.accountFilter);
  const loadEmails = useStore((s) => s.loadEmails);

  const [prefill] = useState(() => buildPrefill(compose, emailView, accounts, accountFilter));
  const fileRef = useRef<HTMLInputElement>(null);

  const [accountId, setAccountId] = useState(prefill.accountId);
  const [to, setTo] = useState<string[]>(prefill.to);
  const [cc, setCc] = useState<string[]>(prefill.cc);
  const [bcc, setBcc] = useState<string[]>([]);
  const [subject, setSubject] = useState(prefill.subject);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [inReply] = useState(prefill.inReply);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: "Напишите письмо…" })
    ],
    content: prefill.html,
    editorProps: { attributes: { class: "mailsense-editor" } }
  });

  const btns: { key: string; icon: ReactNode; title: string; onClick: () => void; active?: boolean }[] = [
    { key: "bold", icon: <BoldOutlined />, title: "Жирный", active: !!editor?.isActive("bold"), onClick: () => editor?.chain().focus().toggleBold().run() },
    { key: "italic", icon: <ItalicOutlined />, title: "Курсив", active: !!editor?.isActive("italic"), onClick: () => editor?.chain().focus().toggleItalic().run() },
    { key: "underline", icon: <UnderlineOutlined />, title: "Подчёркнутый", active: !!editor?.isActive("underline"), onClick: () => editor?.chain().focus().toggleUnderline().run() },
    { key: "strike", icon: <StrikethroughOutlined />, title: "Зачёркнутый", active: !!editor?.isActive("strike"), onClick: () => editor?.chain().focus().toggleStrike().run() },
    { key: "bulletList", icon: <UnorderedListOutlined />, title: "Список", active: !!editor?.isActive("bulletList"), onClick: () => editor?.chain().focus().toggleBulletList().run() },
    { key: "orderedList", icon: <OrderedListOutlined />, title: "Нумерованный список", active: !!editor?.isActive("orderedList"), onClick: () => editor?.chain().focus().toggleOrderedList().run() },
    { key: "blockquote", icon: <span style={{ fontSize: 13 }}>❝</span>, title: "Цитата", active: !!editor?.isActive("blockquote"), onClick: () => editor?.chain().focus().toggleBlockquote().run() }
  ];

  const setLink = () => {
    if (editor?.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt("Ссылка (URL):");
    if (url) editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const clearFormat = () => editor?.chain().focus().unsetAllMarks().clearNodes().run();

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const arr: DraftAttachment[] = [];
    for (const f of Array.from(files)) {
      arr.push({ filename: f.name, mimeType: f.type || "application/octet-stream", size: f.size, data: await readAsBase64(f) });
    }
    setAttachments((prev) => [...prev, ...arr]);
  };

  const payload = () => ({
    accountId,
    to: parseEmails(to.join(",")),
    cc: cc.length ? parseEmails(cc.join(",")) : [],
    bcc: bcc.length ? parseEmails(bcc.join(",")) : [],
    subject: subject.trim() || "(без темы)",
    bodyText: editor?.getText() ?? "",
    bodyHtml: editor?.isEmpty ? "" : editor?.getHTML() ?? "",
    attachments,
    inReplyToEmailId: inReply.emailId,
    inReplyToMessageId: inReply.messageId,
    references: inReply.references
  });

  const send = async () => {
    if (!accountId) return message.warning("Выберите аккаунт");
    if (to.length === 0) return message.warning("Укажите получателя");
    setSending(true);
    try {
      await api.sendEmail(payload());
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
      await api.createDraft(payload());
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
          options={accounts.map((a) => ({ value: a.id, label: a.username }))}
        />
        <Select mode="tags" placeholder="Кому (Enter — добавить)" value={to} onChange={(v) => setTo((v as string[]) ?? [])} open={false} tokenSeparators={[",", ";"]} style={{ width: "100%" }} />
        <Select mode="tags" placeholder="Копия (Cc)" value={cc} onChange={(v) => setCc((v as string[]) ?? [])} open={false} tokenSeparators={[",", ";"]} style={{ width: "100%" }} />
        <Select mode="tags" placeholder="Скрытая копия (Bcc)" value={bcc} onChange={(v) => setBcc((v as string[]) ?? [])} open={false} tokenSeparators={[",", ";"]} style={{ width: "100%" }} />
        <Input placeholder="Тема" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <div style={{ border: "1px solid #d9d9d9", borderRadius: 6 }}>
          <Space size={2} style={{ padding: "4px 8px", borderBottom: "1px solid #f0f0f0", display: "flex", flexWrap: "wrap" }}>
            {btns.map((b) => (
              <Button key={b.key} size="small" type={b.active ? "primary" : "text"} title={b.title} icon={b.icon} onMouseDown={(e) => e.preventDefault()} onClick={b.onClick} />
            ))}
            <Button key="link" size="small" type="text" title="Ссылка" icon={<LinkOutlined />} onMouseDown={(e) => e.preventDefault()} onClick={setLink} />
            <Button key="clear" size="small" type="text" title="Очистить формат" onMouseDown={(e) => e.preventDefault()} onClick={clearFormat}>
              <span style={{ fontSize: 12 }}>Tx</span>
            </Button>
          </Space>
          <EditorContent editor={editor} />
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
    </div>
  );
}

const EDITOR_CSS = `
.mailsense-editor { min-height: 200px; max-height: 420px; overflow: auto; padding: 12px; outline: none; }
.mailsense-editor p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; height: 0; pointer-events: none; color: #bfbfbf; }
`;

export default function Composer() {
  const compose = useStore((s) => s.compose);
  const closeCompose = useStore((s) => s.closeCompose);

  return (
    <>
      <style>{EDITOR_CSS}</style>
      <Modal
        open={compose.open}
        onCancel={closeCompose}
        footer={null}
        width={720}
        destroyOnClose
        title={TITLE_BY_MODE[compose.mode] ?? "Новое письмо"}
      >
        {compose.open ? <ComposerForm /> : null}
      </Modal>
    </>
  );
}