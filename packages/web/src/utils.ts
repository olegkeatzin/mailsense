import type { AnalysisStatus, Category } from "./types";

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + " Б";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " КБ";
  return (n / 1024 / 1024).toFixed(1) + " МБ";
}

/**
 * Цвет приоритета.
 *
 * Оттенки — из палитры Ant Design (red-7, volcano-7, gold-9, blue-7, green-7) и все
 * проходят AA на белом. Прежние #f5222d/#fa8c16/#fadb14/#1890ff/#52c41a давали
 * 3.9 / 2.4 / 1.4 / 3.2 / 2.3 : 1 — точка приоритета на белом фоне была почти не видна.
 * Значения проверяются contrast.test.ts.
 */
export function priorityColor(p: number): string {
  if (p >= 5) return "#cf1322";
  if (p === 4) return "#d4380d";
  if (p === 3) return "#874d00";
  if (p === 2) return "#0958d9";
  return "#237804";
}

export function priorityLabel(p: number): string {
  if (p >= 5) return "Очень высокий";
  if (p === 4) return "Высокий";
  if (p === 3) return "Средний";
  if (p === 2) return "Низкий";
  return "Очень низкий";
}

export function categoryLabel(c: Category): string {
  if (c === "work") return "Рабочее";
  if (c === "personal") return "Личное";
  return "Спам";
}

export function categoryColor(c: Category): string {
  if (c === "work") return "#1677ff";
  if (c === "personal") return "#52c41a";
  return "#999999";
}

/**
 * Список исполнителей одной строкой.
 *
 * Учётка может быть без ФИО (каталог не отдал имя) — тогда берём адрес, а если и его
 * нет, честную подпись. Простой join(", ") на пустых именах давал «Исполнители: ,» —
 * человек видел мусор вместо ответа на вопрос «кто исполняет».
 */
export function formatAssignees(
  assignees: Array<{ fullName?: string | null; email?: string | null }>
): string {
  const names = assignees
    .map((a) => (a.fullName ?? "").trim() || (a.email ?? "").trim() || "исполнитель без имени")
    .filter(Boolean);
  return names.length ? names.join(", ") : "—";
}

export function statusLabel(s: AnalysisStatus): string {
  switch (s) {
    case "pending": return "Ожидает";
    case "queued": return "В очереди";
    case "processing": return "Обрабатывается";
    case "ready": return "Готово";
    case "error": return "Ошибка";
    default: return s;
  }
}

/**
 * Цвет статуса анализа.
 *
 * Оттенки взяты темнее «фирменных» antd: светло-зелёный #52c41a на белом давал
 * контраст 2.06:1 при норме 4.5:1 (WCAG AA для мелкого текста), и подпись статуса
 * в списке писем было трудно прочитать. Значения проверяются тестом contrast.test.ts.
 */
export function statusColor(s: AnalysisStatus): string {
  switch (s) {
    case "ready": return "#237804";
    case "error": return "#cf1322";
    case "processing": return "#0958d9";
    case "queued": return "#874d00";
    default: return "#595959";
  }
}
