// Минимальный парсер mbox (формат экспорта Thunderbird).
// Сообщения разделяются строками "From <отправитель> <дата>"; в теле такие строки
// экранированы как ">From ".

export function isMboxFilename(filename: string): boolean {
  return /\.mbox$/i.test(filename);
}

export function splitMbox(data: Buffer): Buffer[] {
  const text = data.toString("latin1");
  const lines = text.split(/\r?\n/);
  const messages: Buffer[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^From /.test(line)) {
      if (current.length > 0) messages.push(Buffer.from(current.join("\n"), "latin1"));
      current = [];
    } else {
      // убираем mbox-экранирование ">From "
      current.push(line.startsWith(">From ") ? line.slice(1) : line);
    }
  }
  if (current.length > 0) messages.push(Buffer.from(current.join("\n"), "latin1"));
  return messages;
}
