/** Утилиты текста письма: общие для композера, шаблонов и подписи. */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export /**
 * HTML редактора -> plain text для части text/plain. Цитаты (blockquote) получают
 * префикс «> », как в Thunderbird, абзацы — перевод строки.
 */
function htmlToPlainText(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines: { text: string; quote: boolean }[] = [];
  let cur = "";
  let quote = false;
  const flush = () => {
    lines.push({ text: cur, quote });
    cur = "";
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      cur += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      flush();
      return;
    }
    const block = ["p", "div", "li", "h1", "h2", "h3", "blockquote", "tr", "ul", "ol"].includes(tag);
    if (block) flush();
    const prev = quote;
    if (tag === "blockquote") quote = true;
    el.childNodes.forEach(visit);
    quote = prev;
    if (block) flush();
  };
  visit(doc.body);
  if (cur) flush();
  while (lines.length && !lines[0].text.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].text.trim()) lines.pop();
  return lines.map((l) => (l.quote ? "> " : "") + l.text).join("\n");
}
