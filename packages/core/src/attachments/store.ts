import fs from "node:fs";
import path from "node:path";

/**
 * Приводит имя файла к безопасному виду, сохраняя его читаемым.
 *
 * ⚠️ Раньше здесь стоял класс \w (ASCII): «акт выполненных работ.pdf»
 * превращался в «____________.pdf». В списке вложение называется по-русски,
 * а на диске его не найти — при разборе инцидента файл не опознать, а ради
 * этого система и заведена. \p{L}/\p{N} с флагом u сохраняют кириллицу
 * (и любой другой алфавит), а всё опасное — слэши, обратные слэши,
 * управляющие символы, *?<>| — по-прежнему заменяется подчёркиванием.
 */
/**
 * Имена устройств Windows: файл с таким именем система создать не даёт,
 * причём расширение не спасает — «CON.txt» для Win32 всё то же устройство CON.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilename(name: string): string {
  // basename отсекает каталоги: «../../etc/passwd» → «passwd».
  const base = path.basename(name)
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .slice(0, 200);
  // Точки-обманки («.», «..») проходят basename и не содержат запрещённых
  // символов, но указывают на каталог — их отсекаем отдельно.
  const safe = /^\.+$/.test(base) ? "_" : base;
  if (!safe) return "attachment";
  // ⚠️ Имя устройства Windows не даст создать файл, а saveAttachmentFile
  // вызывается до try в prepareAttachment: падение уносит письмо целиком.
  // Уводим такое имя подчёркиванием — «CON» → «_CON».
  return WINDOWS_DEVICE.test(safe.split(".")[0]) ? "_" + safe : safe;
}

/**
 * Сохраняет вложение и возвращает путь к файлу.
 *
 * ⚠️ Имя вложения не уникально: в одном письме законно лежат два «акт.pdf»
 * (например, скан и подпись). Раньше путь был «каталог письма + имя», поэтому
 * второе вложение затирало первое — в базе две записи, а на диске один файл.
 * Теперь имя уникализируется суффиксом «-1», «-2»…, а запись идёт через
 * эксклюзивное создание (flag "wx"): существующий файл не перезаписывается
 * никогда, даже если он появился между проверкой и записью.
 */
export function saveAttachmentFile(
  dataDir: string,
  emailId: string,
  filename: string,
  content: Buffer
): string {
  const dir = path.join(dataDir, "attachments", emailId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = sanitizeFilename(filename);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;

  for (let n = 0; n < 1000; n++) {
    const full = path.join(dir, n === 0 ? safe : stem + "-" + n + ext);
    try {
      fs.writeFileSync(full, content, { flag: "wx" });
      return full;
    } catch (err) {
      // Файл уже занят — берём следующее имя. Любая другая ошибка (нет прав,
      // нет места) не должна превращаться в бесконечный перебор имён.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("Не удалось подобрать имя для вложения: " + safe);
}