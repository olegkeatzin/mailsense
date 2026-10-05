// Минимальный парсер mbox (формат экспорта Thunderbird).
// Сообщения разделяются строками "From <отправитель> <дата>"; в теле такие строки
// экранированы как ">From ".

export function isMboxFilename(filename: string): boolean {
  return /\.mbox$/i.test(filename);
}

/** Определяет mbox по содержимому: начинается с разделителя "From <отправитель> " (не "From:"). */
export function isMboxData(data: Buffer): boolean {
  return /^\s*From \S/.test(data.toString("latin1").slice(0, 256));
}

export function splitMbox(data: Buffer): Buffer[] {
  const text = data.toString("latin1");
  const lines = text.split(/\r?\n/);
  const messages: Buffer[] = [];
  let current: string[] = [];
  // Всё до первого разделителя — не письмо, а «шапка» файла. Без этого флага
  // ведущие пустые строки превращались в фиктивное пустое письмо.
  let started = false;
  for (const line of lines) {
    if (/^From /.test(line)) {
      if (started && current.length > 0) messages.push(Buffer.from(current.join("\n"), "latin1"));
      started = true;
      current = [];
    } else if (started) {
      // убираем mbox-экранирование ">From "
      current.push(line.startsWith(">From ") ? line.slice(1) : line);
    }
  }
  if (started && current.length > 0) messages.push(Buffer.from(current.join("\n"), "latin1"));
  return messages;
}
