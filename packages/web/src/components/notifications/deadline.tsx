import { Space, Tag } from "antd";
import dayjs from "dayjs";
import { SOON_STYLE } from "./colors";

export { SOON_STYLE };

/**
 * Срок задачи: склонения и единая плашка для «Моих задач» и канбана (stage5-ux.md §1.3, §3).
 *
 * Своих вычислений «сегодня» здесь нет: daysLeft/overdue/dueSoon приходят с сервера.
 * Иначе часовой пояс и рабочие дни разъедутся с тем, что считает сервер.
 */

/** Русская форма слова после числа: 1 день, 2 дня, 5 дней. */
export function dayWord(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "дней";
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}

/** «остался 1 день», «осталось 2 дня», «осталось 5 дней». */
export function daysLeftText(n: number): string {
  return (n === 1 ? "остался " : "осталось ") + n + " " + dayWord(n);
}

/** «просрочено на 1 день», «просрочено на 2 дня», «просрочено на 5 дней». */
export function overdueText(n: number): string {
  const d = Math.abs(n);
  return "просрочено на " + d + " " + dayWord(d);
}

export interface DeadlineTagProps {
  deadline: string | null;
  daysLeft: number | null;
  /** Серверный признак: срок близко по НАСТРОЕННОМУ порогу (§А5). */
  dueSoon?: boolean;
  /** Серверный признак просрочки; если не пришёл — считаем по daysLeft. */
  overdue?: boolean;
  variant: "table" | "card";
}

/**
 * Показывает срок и предупреждение одним способом на двух экранах.
 *
 * В таблице дата и плашка стоят рядом; в карточке канбана — одним тегом.
 */
export function DeadlineTag({ deadline, daysLeft, dueSoon, overdue, variant }: DeadlineTagProps) {
  const date = deadline ? dayjs(deadline).format("DD.MM.YYYY") : "";

  if (!deadline) {
    return variant === "card" ? <Tag style={SOON_STYLE}>без срока</Tag> : <span style={{ color: "#595959" }}>не указан</span>;
  }

  const left = daysLeft === null || daysLeft === undefined ? null : Math.trunc(daysLeft);
  // Серверный overdue=false означает «задача уже сдана»: отрицательный daysLeft
  // просрочкой для неё не является. Иначе выполненная в срок задача горела красным.
  const isOverdue = overdue !== undefined ? overdue : left !== null && left < 0;
  const isToday = !isOverdue && left === 0;
  // «Скоро» решает сервер (dueSoon — тот же порог, что у уведомления, §А5).
  const isSoon = !isOverdue && !isToday && dueSoon === true;

  if (isOverdue) {
    const text = overdueText(left ?? 0);
    const aria = "Срок просрочен на " + Math.abs(left ?? 0) + " " + dayWord(left ?? 0);
    if (variant === "card") {
      return <Tag color="red" aria-label={aria}>{date + " · " + text}</Tag>;
    }
    return (
      <Space size={4}>
        <span style={{ color: "#cf1322", fontWeight: 600 }}>{date}</span>
        <Tag color="red" aria-label={aria}>{text}</Tag>
      </Space>
    );
  }

  if (isToday) {
    if (variant === "card") {
      return <Tag style={SOON_STYLE} aria-label="Срок сегодня">{date + " · срок сегодня"}</Tag>;
    }
    return (
      <Space size={4}>
        <span style={{ fontWeight: 600 }}>{date}</span>
        <Tag style={SOON_STYLE} aria-label="Срок сегодня">срок сегодня</Tag>
      </Space>
    );
  }

  if (isSoon && left !== null) {
    if (variant === "card") {
      return <Tag style={SOON_STYLE}>{date + " · " + daysLeftText(left)}</Tag>;
    }
    return (
      <Space size={4}>
        <span>{date}</span>
        <Tag style={SOON_STYLE} aria-label={"До срока " + daysLeftText(left)}>{daysLeftText(left)}</Tag>
      </Space>
    );
  }

  // Дальний срок либо сервер не дал daysLeft/dueSoon: показываем только дату, не гадаем.
  return variant === "card" ? <Tag>{date}</Tag> : <span style={{ color: "#262626" }}>{date}</span>;
}
