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

export function priorityColor(p: number): string {
  if (p >= 5) return "#f5222d";
  if (p === 4) return "#fa8c16";
  if (p === 3) return "#fadb14";
  if (p === 2) return "#1890ff";
  return "#52c41a";
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

export function statusColor(s: AnalysisStatus): string {
  switch (s) {
    case "ready": return "#52c41a";
    case "error": return "#f5222d";
    case "processing": return "#1677ff";
    case "queued": return "#faad14";
    default: return "#999999";
  }
}
