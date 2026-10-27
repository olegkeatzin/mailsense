import fs from "node:fs";
import path from "node:path";
import { getContext, listAttachments, logger } from "@mailsense/core";
import type { DocumentRecord } from "@mailsense/docflow";

/**
 * Вложения зарегистрированного документа на сервере.
 *
 * Файлы лежат не в PostgreSQL и не в почтовой базе, а в обычной папке mailDocs,
 * которую в Docker видно на хосте. Путь к папке карточки хранится в documents.doc_files_path.
 */

export interface DocumentFileInfo {
  name: string;
  size: number;
}

/** Корень mailDocs: MAIL_DOCS_DIR (Docker) или <dataDir>/mailDocs (локальный запуск). */
export function documentFilesRoot(): string {
  const env = (process.env.MAIL_DOCS_DIR ?? "").trim();
  return env ? path.resolve(env) : path.join(getContext().config.dataDir, "mailDocs");
}

/**
 * Имя папки карточки: {входящий номер}{год}_{дата}.
 * Пример: вх1 + 2026 + 27.10.2026 → «вх12026_27.10.2026».
 */
export function documentFilesFolderName(doc: Pick<DocumentRecord, "regNumber" | "regPeriod" | "regDate">): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(doc.regDate)
    ? doc.regDate.split("-").reverse().join(".")
    : doc.regDate;
  const safe = (value: string) => value.replace(/[\\/:*?"<>|]/g, "_").trim() || "без-номера";
  return safe(doc.regNumber + doc.regPeriod) + "_" + safe(date);
}

/** Свободное имя файла в папке: одинаковые вложения не затирают друг друга. */
function uniqueName(dir: string, filename: string, size: number): string {
  const base = path.basename(filename).trim() || "файл";
  let candidate = base;
  const parsed = path.parse(base);
  for (let n = 2; n < 1000; n++) {
    const full = path.join(dir, candidate);
    if (!fs.existsSync(full)) return candidate;
    try {
      if (fs.statSync(full).size === size) return candidate;
    } catch {
      /* проверяем следующее имя */
    }
    candidate = parsed.name + " (" + n + ")" + parsed.ext;
  }
  return Date.now() + "-" + base;
}

function listFiles(dir: string): DocumentFileInfo[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  } catch {
    return [];
  }
}

/**
 * Создаёт папку карточки и раскладывает в неё все вложения исходного письма.
 * Идемпотентно: повторный вызов не плодит копии.
 */
export async function ensureDocumentFiles(doc: DocumentRecord): Promise<{
  docFilesPath: string;
  files: DocumentFileInfo[];
}> {
  const root = documentFilesRoot();
  const dir = path.join(root, documentFilesFolderName(doc));
  fs.mkdirSync(dir, { recursive: true });

  if (doc.emailId) {
    for (const att of listAttachments(doc.emailId)) {
      if (!att.storagePath || !fs.existsSync(att.storagePath)) {
        logger.warn(
          { documentId: doc.id, emailId: doc.emailId, filename: att.filename },
          "Файл вложения письма не найден — не скопирован в mailDocs"
        );
        continue;
      }
      const name = uniqueName(dir, att.filename, att.size);
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(att.storagePath, target);
      }
    }
  }

  return { docFilesPath: dir, files: listFiles(dir) };
}

/** Безопасный путь к файлу внутри папки карточки (никаких ../ и чужих каталогов). */
export function documentFilePath(docFilesPath: string, name: string): string | null {
  if (!name || path.basename(name) !== name) return null;
  const dir = path.resolve(docFilesPath);
  const file = path.resolve(dir, name);
  return file.startsWith(dir + path.sep) ? file : null;
}
