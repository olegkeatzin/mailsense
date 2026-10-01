import { useEffect } from "react";
import { Button, Select, Space, Tooltip } from "antd";
import {
  BoldOutlined,
  ItalicOutlined,
  LinkOutlined,
  MinusOutlined,
  OrderedListOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined
} from "@ant-design/icons";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";

export const EDITOR_CSS = `
.mailsense-editor { min-height: 200px; max-height: 420px; overflow: auto; padding: 12px; outline: none; }
.mailsense-editor p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; height: 0; pointer-events: none; color: #bfbfbf; }
.mailsense-editor p { margin: 0 0 8px; }
.mailsense-editor ul, .mailsense-editor ol { padding-left: 22px; margin: 0 0 8px; }
.mailsense-editor blockquote { border-left: 2px solid #d0d0d0; margin: 8px 0; padding-left: 10px; color: #555; }
.mailsense-editor a { color: #1677ff; text-decoration: underline; }
.mailsense-editor .mailsense-signature { color: #555; }
.mailsense-editor .mailsense-attribution { color: #777; font-size: 12px; }
`;

let cssInjected = false;

/** CSS редактора добавляется в <head> один раз: рендерить <style> в разметке нельзя —
 *  его текст попадает в innerText модалок и ломает тексты/тесты. */
function useEditorCss() {
  useEffect(() => {
    if (cssInjected || typeof document === "undefined") return;
    const el = document.createElement("style");
    el.textContent = EDITOR_CSS;
    document.head.appendChild(el);
    cssInjected = true;
  }, []);
}

/**
 * Единый WYSIWYG-редактор письма (TipTap StarterKit + Placeholder).
 * Используется в композере, шаблонах и подписи — один код на всё приложение.
 */
export default function RichTextEditor({
  value = "",
  onChange,
  placeholder = "Напишите текст…"
}: {
  // Необязательные: их же подставляет antd Form.Item, когда редактор — поле формы.
  value?: string;
  onChange?: (html: string) => void;
  placeholder?: string;
}) {
  useEditorCss();
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder })
    ],
    content: value && value.trim() ? value : "<p></p>",
    editorProps: { attributes: { class: "mailsense-editor" } },
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor }) => onChange?.(editor.getHTML())
  });

  // Внешнее значение (применение шаблона и т.п.) -> в редактор. Сравнение защищает от цикла.
  useEffect(() => {
    if (!editor) return;
    const next = value && value.trim() ? value : "<p></p>";
    if (editor.getHTML() !== next) editor.commands.setContent(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  const setLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt("Ссылка (URL):");
    if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const btns: { key: string; icon: JSX.Element; title: string; onClick: () => void; active?: boolean }[] = [
    { key: "undo", icon: <UndoOutlined />, title: "Отменить", onClick: () => editor?.chain().focus().undo().run() },
    { key: "redo", icon: <RedoOutlined />, title: "Повторить", onClick: () => editor?.chain().focus().redo().run() },
    { key: "bold", icon: <BoldOutlined />, title: "Жирный", active: !!editor?.isActive("bold"), onClick: () => editor?.chain().focus().toggleBold().run() },
    { key: "italic", icon: <ItalicOutlined />, title: "Курсив", active: !!editor?.isActive("italic"), onClick: () => editor?.chain().focus().toggleItalic().run() },
    { key: "underline", icon: <UnderlineOutlined />, title: "Подчёркнутый", active: !!editor?.isActive("underline"), onClick: () => editor?.chain().focus().toggleUnderline().run() },
    { key: "strike", icon: <StrikethroughOutlined />, title: "Зачёркнутый", active: !!editor?.isActive("strike"), onClick: () => editor?.chain().focus().toggleStrike().run() },
    { key: "bulletList", icon: <UnorderedListOutlined />, title: "Список", active: !!editor?.isActive("bulletList"), onClick: () => editor?.chain().focus().toggleBulletList().run() },
    { key: "orderedList", icon: <OrderedListOutlined />, title: "Нумерованный список", active: !!editor?.isActive("orderedList"), onClick: () => editor?.chain().focus().toggleOrderedList().run() },
    { key: "blockquote", icon: <span style={{ fontSize: 13 }}>❝</span>, title: "Цитата", active: !!editor?.isActive("blockquote"), onClick: () => editor?.chain().focus().toggleBlockquote().run() },
    { key: "hr", icon: <MinusOutlined />, title: "Разделитель", onClick: () => editor?.chain().focus().setHorizontalRule().run() }
  ];

  const heading = editor?.isActive("heading", { level: 1 })
    ? "1"
    : editor?.isActive("heading", { level: 2 })
      ? "2"
      : editor?.isActive("heading", { level: 3 })
        ? "3"
        : "p";

  return (
    <div style={{ border: "1px solid #d9d9d9", borderRadius: 6, background: "#fff" }}>
      <Space size={2} style={{ padding: "4px 8px", borderBottom: "1px solid #f0f0f0", display: "flex", flexWrap: "wrap" }}>
        <Select
          size="small"
          style={{ width: 122 }}
          value={heading}
          onChange={(v) => {
            if (!editor) return;
            if (v === "p") editor.chain().focus().setParagraph().run();
            else editor.chain().focus().toggleHeading({ level: Number(v) as 1 | 2 | 3 }).run();
          }}
          options={[
            { value: "p", label: "Текст" },
            { value: "1", label: "Заголовок 1" },
            { value: "2", label: "Заголовок 2" },
            { value: "3", label: "Заголовок 3" }
          ]}
        />
        {btns.map((b) => (
          <Button key={b.key} size="small" type={b.active ? "primary" : "text"} title={b.title} icon={b.icon} onMouseDown={(e) => e.preventDefault()} onClick={b.onClick} />
        ))}
        <Button key="link" size="small" type="text" title="Ссылка" icon={<LinkOutlined />} onMouseDown={(e) => e.preventDefault()} onClick={setLink} />
        <Button
          key="clear"
          size="small"
          type="text"
          title="Очистить формат"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <span style={{ fontSize: 12 }}>Tx</span>
        </Button>
      </Space>
      <EditorContent editor={editor} />
    </div>
  );
}
