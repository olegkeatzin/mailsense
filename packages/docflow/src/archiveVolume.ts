/**
 * Сколько занимают вложения года — известно ДО закрытия года.
 *
 * Зачем: архив журнала не поддерживает Zip64 (см. zipStream.ts), поэтому и каждый файл,
 * и архив целиком обязаны быть меньше 4 ГБ. Если вложений за год больше, выгрузка не
 * соберётся — а по правилу «снимок не сделан, значит и год не закрыт» закрытие не пройдёт.
 * Человек должен узнать об этом ДО нажатия кнопки, а не после.
 *
 * ⚠️ Два правила, без которых предупреждение вредно:
 *   1) считаем ТЕМ ЖЕ обходом, что и выгрузка (итератор ссылок передаёт вызывающий) —
 *      иначе цифра разойдётся с фактом;
 *   2) размеры берём из МЕТАДАННЫХ вложений (поле size), файлы не открываем: память O(1),
 *      на диск не ходим. Если размер хотя бы у одного вложения неизвестен — возвращаем null
 *      и предупреждения не показываем: неверное предупреждение хуже отсутствующего.
 *
 * Модуль намеренно не знает ни про БД, ни про конкретный источник вложений: ему дают
 * итератор ссылок и источник с размерами. Так его можно проверять без базы.
 */

/**
 * Предел архива: Zip64 не поддержан, поэтому 4 ГБ — жёсткий предел и для файла, и для архива.
 * Единица — 1024^3 (как считает zipStream).
 */
export const ARCHIVE_LIMIT_BYTES = 4 * 1024 ** 3;

/** Предупреждаем заранее: помимо вложений в архив идут JSONL журнала и сам контейнер. */
export const ARCHIVE_WARN_BYTES = 3 * 1024 ** 3;

/** Здесь уже «почти наверняка не пройдёт»: запас до предела меньше 0,5 ГБ. */
export const ARCHIVE_DANGER_BYTES = 3.5 * 1024 ** 3;

export type ArchiveVolumeLevel = "ok" | "near" | "over";

export interface ArchiveVolumeWarning {
  level: ArchiveVolumeLevel;
  /** Готовый текст для формы закрытия; null — предупреждать не о чем. */
  text: string | null;
}

/** «3,2 ГБ». Без ICU: запятая ставится вручную, чтобы текст не зависел от локали процесса. */
export function formatArchiveSize(bytes: number): string {
  const gb = Math.max(0, bytes) / 1024 ** 3;
  return gb.toFixed(1).replace(".", ",") + " ГБ";
}

/**
 * Предупреждение для формы закрытия года.
 *
 * Границы: 3 ГБ — «приближается», 3,5 ГБ — «скорее всего, не удастся». Тексты согласованы
 * с Lead; менять их формулировки без согласования не нужно — в них есть обязательная часть
 * «год останется открытым / данные не изменятся».
 */
export function archiveVolumeWarning(
  bytes: number,
  year?: string | null,
  opts?: { truncated?: boolean }
): ArchiveVolumeWarning {
  // При досрочном выходе сумма — НИЖНЯЯ граница: показать «≈4,0 ГБ», когда вложений на 10 ГБ,
  // значит соврать в меньшую сторону. Пишем «не менее».
  const size = (opts?.truncated ? "не менее " : "≈") + formatArchiveSize(bytes);
  const yearSuffix = year ? " " + year : "";
  if (bytes >= ARCHIVE_DANGER_BYTES) {
    return {
      level: "over",
      text:
        "⛔ Закрыть" + yearSuffix + " год, скорее всего, не удастся: вложения занимают " + size +
        ", а архив не поддерживает файлы больше 4 ГБ. Если выгрузка не соберётся, год останется открытым — " +
        "данные журнала не изменятся. Освободите объём или обратитесь к администратору."
    };
  }
  if (bytes >= ARCHIVE_WARN_BYTES) {
    return {
      level: "near",
      text:
        "⚠️ Вложения за" + yearSuffix + " год занимают " + size +
        ". Архив не поддерживает файлы больше 4 ГБ: если объём превысит предел, выгрузка не соберётся, " +
        "и год останется открытым. Освободите объём до закрытия — удалите ненужные вложения или " +
        "выгрузите год частями."
    };
  }
  return { level: "ok", text: null };
}

/**
 * Отказ закрытия после нажатия: снимок не сделан, значит год не закрыт.
 * Формулировка обязательная: человек должен видеть, что состояние журнала прежнее.
 */
export function archiveFailureText(reason: string): string {
  const why = (reason ?? "").trim() || "выгрузка архива не удалась";
  return "Снимок года не сделан — год НЕ закрыт. Причина: " + why + ". Данные журнала не изменялись.";
}

/** Вложение так, как его видит расчёт: имя и размер из метаданных (без чтения файла). */
export interface SizedAttachment {
  name: string;
  size?: number;
}

/** Источник вложений: то же, что регистрирует композиционный корень для выгрузки. */
export interface AttachmentSizeSource {
  list(emailId: string): Promise<SizedAttachment[]>;
}

export interface AttachmentSizeSummary {
  /** Сумма размеров; null — у части вложений размер неизвестен (предупреждать нечем). */
  bytes: number | null;
  /** Сколько вложений насчитали (для диагностики и сверки со счётчиком архива). */
  files: number;
  /** Сколько вложений пришло без размера. */
  unknownSizes: number;
  /** true — обход прекращён досрочно: предел уже превышен, точная сумма не нужна. */
  truncated: boolean;
}

/**
 * Считает объём вложений года, не открывая файлы.
 *
 * @param links тот же обход ссылок, что у выгрузки (год → письма документов);
 * @param store источник вложений (в проде — зарегистрированный для архива);
 * @param limitBytes порог досрочной остановки (по умолчанию предел архива).
 */
export async function sumAttachmentBytes(input: {
  links: AsyncIterable<{ emailId: string }>;
  store: AttachmentSizeSource;
  limitBytes?: number;
}): Promise<AttachmentSizeSummary> {
  const limit = input.limitBytes ?? ARCHIVE_LIMIT_BYTES;
  let bytes = 0;
  let files = 0;
  let unknownSizes = 0;

  for await (const link of input.links) {
    let list: SizedAttachment[] = [];
    try {
      list = await input.store.list(link.emailId);
    } catch {
      // Как и в выгрузке: недоступное письмо не роняет подсчёт, но и не считается.
      continue;
    }
    for (const att of list) {
      files += 1;
      if (typeof att.size !== "number" || !Number.isFinite(att.size) || att.size < 0) {
        unknownSizes += 1;
        continue;
      }
      bytes += att.size;
      if (bytes >= limit) {
        // Дальше читать незачем: предел уже превышен, вывод предупреждения не изменится.
        return { bytes, files, unknownSizes, truncated: true };
      }
    }
  }

  return { bytes: unknownSizes > 0 ? null : bytes, files, unknownSizes, truncated: false };
}