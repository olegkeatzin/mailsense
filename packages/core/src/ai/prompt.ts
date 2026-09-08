export interface PromptInput {
  subject: string;
  from: string;
  date: string | null;
  bodyText: string;
  attachmentTexts: string[];
  attachmentNotes: string[];
  imageCount: number;
  attachmentNames: string[];
}

export const DEFAULT_SYSTEM_PROMPT = [
  "Ты — ассистент, который анализирует входящие деловые и личные письма.",
  "Отвечай ТОЛЬКО валидным JSON-объектом без markdown-разметки и без пояснений.",
  "Схема ответа:",
  "{",
  '  "summary": "краткая суть письма одним абзацем на языке письма",',
  '  "tags": ["метка1", "метка2"],',
  '  "priority": 3,',
  '  "urgent": false,',
  '  "event_date": "2026-01-15" или null,',
  '  "external_number": "номер документа (например «Исх-123/45») или null",',
  '  "external_number_source": {"filename": "точное имя файла из списка «Вложения»", "page": 1} или null,',
  '  "send_date": "2026-01-15" или null,',
  '  "category": "work" | "personal" | "spam"',
  '  "attachments": [{"name": "файл.pdf", "description": "что на нём/в нём важного"}],',
  "}",
  "",
  "Правила:",
  "- summary: 1-3 предложения, передай главное и ожидаемое действие.",
  "- tags: 1-5 коротких меток на русском (например: счёт, договор, жалоба, срочно, встреча, рассылка).",
  "- priority: целое число 1..5 (5 = максимально важно).",
  "- urgent: true, если письмо требует немедленного ответа или действия.",
  "- event_date: дата встречи/дедлайна/события в ISO-8601 (YYYY-MM-DD), иначе null.",
  "- external_number: в ПЕРВУЮ очередь ищи номер в ИМЕНИ файла вложения (например «3175 от 31.08.2026.pdf» → «3175», «Вх. №1575_РТ от 24.07.2026.pdf» → «1575/РТ»). Если в имени файла номера нет — ищи в тексте документа (шапка). ТОЛЬКО сам номер (цифры и буквы), БЕЗ даты и БЕЗ слов «исх.», «вх.», «№», «от». Если номера нет — null.",
  "- external_number_source: укажи, из какого вложения взят номер — точное имя файла из списка «Вложения» и номер страницы (маркер «--- стр. N ---»). Если вложение без страниц (docx/xlsx/txt) — page=1. Если номер из темы/тела письма или вложения нет — null.",
  "- send_date: дата ОТПРАВКИ письма (из шапки документа, обычно после «от» рядом с номером: «Исх. № 123 от 01.02.2026» → «2026-02-01»). Может быть и в имени файла («3175 от 31.08.2026.pdf» → «2026-08-31»). В ISO-8601 (YYYY-MM-DD). Если даты нет — null. Это НЕ дата события и НЕ дата получения письма.",
  "- category: work (рабочее), personal (личное), spam (спам/реклама).",
  "- attachments: для КАЖДОГО вложения (изображение, PDF, документ) дай краткое описание (1 предложение) того, что на нём изображено или написано. name — точное имя файла из списка «Вложения». Без вложений — пустой массив.",
  "- Анализируй вложения: изображения и страницы PDF рассматривай как часть письма; извлечённый текст документов и таблиц учитывай в summary и tags."
].join("\n");

export const DEFAULT_USER_TEMPLATE = [
  "Метаданные письма:",
  "- Отправитель: {{from}}",
  "- Тема: {{subject}}",
  "- Дата: {{date}}",
  "",
  "Текст письма:",
  "{{body}}",
  "{{attachment_list}}",
  "{{attachments}}",
  "{{notes}}",
  "",
  "Верни результат строго в формате JSON согласно схеме."
].join("\n");

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

export interface PromptOptions {
  system?: string;
  userTemplate?: string;
}

export function buildPrompt(input: PromptInput, opts: PromptOptions = {}): string {
  const attachmentsBlock = input.attachmentTexts
    .map((t, i) => ({ name: input.attachmentNames[i] ?? "вложение #" + (i + 1), text: t }))
    .filter((x) => x.text && x.text.trim().length > 0)
    .map((x) => "=== " + x.name + " ===\n" + x.text)
    .join("\n\n");

  let notesBlock = "";
  if (input.imageCount > 0) {
    notesBlock +=
      "К письму приложены изображения/страницы документов (" + input.imageCount + " шт.) — они переданы отдельно.";
  }
  if (input.attachmentNotes.length > 0) {
    if (notesBlock) notesBlock += "\n";
    notesBlock += "Примечания по вложениям:\n" + input.attachmentNotes.map((n) => "- " + n).join("\n");
  }

  const attachmentList =
    input.attachmentNames.length > 0
      ? "Вложения:\n" + input.attachmentNames.map((n) => "- " + n).join("\n")
      : "";

  const vars: Record<string, string> = {
    from: input.from || "(неизвестен)",
    subject: input.subject,
    date: input.date || "(неизвестна)",
    body: input.bodyText || "(пусто)",
    attachment_list: attachmentList,
    attachments: attachmentsBlock,
    notes: notesBlock
  };

  const system = opts.system ?? DEFAULT_SYSTEM_PROMPT;
  const user = renderTemplate(opts.userTemplate ?? DEFAULT_USER_TEMPLATE, vars);
  return system + "\n\n" + user;
}
