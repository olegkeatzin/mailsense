/**
 * Сколько занимают вложения года — оценка для отчётов и интерфейса.
 *
 * ⚠️ Предела в 4 ГБ БОЛЬШЕ НЕТ: архив журнала поддерживает Zip64 (см. zipStream.ts),
 * поэтому ни файл, ни архив целиком размером не ограничены. Предупреждение о «пределе»
 * было бы враньём, и его сняли вместе с пределом.
 *
 * ⚠️ Правило подсчёта: размеры берём из МЕТАДАННЫХ вложений (поле size), файлы не
 * открываем — память O(1) и никакого чтения с диска. Если размер хотя бы у одного
 * вложения неизвестен, сумма помечается как неизвестная (bytes = null): выдуманная
 * цифра хуже отсутствующей.
 *
 * Модуль намеренно не знает ни про БД, ни про конкретный источник вложений: ему дают
 * итератор ссылок и источник с размерами. Так его можно проверять без базы.
 */

/**
 * «3,2 ГБ». Без ICU: запятая ставится вручную, чтобы текст не зависел от локали процесса.
 * Оставлено для отчётов: предел снят, а показывать объём по-прежнему полезно.
 */
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
  /** true — обход прекращён досрочно: переданный вызывающим предел уже превышен. */
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
  // Предела по умолчанию нет: он был нужен только предупреждению о 4 ГБ, которого больше нет.
  // Явно переданный предел по-прежнему останавливает обход досрочно (нужно отчётам).
  const limit = input.limitBytes ?? Number.POSITIVE_INFINITY;
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