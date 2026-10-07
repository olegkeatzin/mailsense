/**
 * Тексты центра уведомлений и правило относительного времени.
 *
 * Строки скопированы из docs/design/stage5-ux.md §2.1/§5.2 — интерфейс не сочиняет
 * тексты сам: их правит дизайнер, а не разработчик по ходу дела.
 */

export const NOTIFY_TEXTS = {
  bellAriaNone: "Уведомления, непрочитанных нет",
  bellAria: "Уведомления, непрочитанных: ",
  bellAriaMany: "Уведомления, непрочитанных больше 99",
  bellTooltip: "Уведомления",
  bellTooltipCount: "Уведомления (",
  bellTooltipMany: "Уведомления (больше 99)",
  panelTitle: "Уведомления",
  panelAria: "Центр уведомлений",
  markAll: "Прочитать все",
  unreadOnly: "Только непрочитанные",
  loading: "Загрузка уведомлений",
  emptyTitle: "Уведомлений пока нет",
  emptyText: "Здесь появятся поручения, сроки и решения по вашим документам.",
  emptyUnreadTitle: "Непрочитанных нет",
  emptyUnreadText: "Все уведомления прочитаны.",
  showAll: "Показать все уведомления",
  errorTitle: "Не удалось загрузить уведомления",
  retry: "Повторить",
  showMore: "Показать ещё",
  shownOf: "Показаны ",
  shownOfMid: " из ",
  retentionNote: "Хранятся последние 500 уведомлений: прочитанные старше удаляются автоматически.",
  markRead: "Отметить прочитанным",
  unreadSr: "непрочитано",
  readAllDone: "Все уведомления прочитаны",
  readFailed: "Не удалось отметить уведомление прочитанным: ",
  liveRegion: "Непрочитанных уведомлений: ",
  /** Честный текст вместо пустого списка, когда уведомления выключены админом (А4). */
  disabled: "Уведомления отключены администратором"
} as const;

/** Расшифровка kind → русская подпись (только интерфейс, kind заморожен §3 контракта). */
export const NOTIFICATION_KIND_TITLES: Record<string, string> = {
  "resolution.assigned": "Вам поручение",
  "resolution.approved": "Резолюция утверждена",
  "resolution.reported": "По поручению отчитались",
  "resolution.closed": "Поручение закрыто",
  "resolution.due_soon": "Приближается срок",
  "resolution.due_today": "Срок сегодня",
  "resolution.overdue": "Срок просрочен",
  "resolution.overdue_escalation": "Просрочка у исполнителя"
};

/**
 * «1 минуту», «2 минуты», «5 минут».
 *
 * В stage5-ux.md §1.4 стояло `n % 10 === 1 ? "минуту" : "минуты"` — это давало
 * «5 минуты назад», хотя таблица проверок та же §1.4 требует «5 минут назад».
 * Чиним по правилам русского языка (и по §1.4-таблице), о находке сообщено дизайнеру.
 */
function minuteWord(n: number): string {
  const last = n % 10;
  const abs = n % 100;
  if (abs > 10 && abs < 20) return "минут";
  if (last === 1) return "минуту";
  if (last >= 2 && last <= 4) return "минуты";
  return "минут";
}

function hourWord(n: number): string {
  const l = n % 10;
  const a = n % 100;
  if (a > 10 && a < 20) return "часов";
  if (l === 1) return "час";
  if (l >= 2 && l <= 4) return "часа";
  return "часов";
}

/**
 * «только что», «5 минут назад», «2 часа назад», «вчера, 14:05», «07.10.2026, 14:05».
 *
 * Относительное время — до суток, дальше абсолютное. Часовой пояс системный, как везде в SPA.
 * Возвращаем и label (видимая подпись), и exact (полное время — в Tooltip/title).
 */
export function notificationTime(iso: string, now: Date = new Date()): { label: string; exact: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { label: "", exact: "" };
  const exact = d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return { label: "только что", exact };
  if (diffMin < 60) return { label: diffMin + " " + minuteWord(diffMin) + " назад", exact };
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return { label: diffH + " " + hourWord(diffH) + " назад", exact };
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, yesterday)) {
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return { label: "вчера, " + time, exact };
  }
  return { label: exact, exact };
}
