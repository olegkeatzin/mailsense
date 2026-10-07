/**
 * Типовые сроки исполнения (этап 5, приложение А9).
 *
 * Справочник нужен, чтобы срок поручения ставился «в три рабочих дня», а не считался
 * человеком в голове. Полный CRUD справочника — вне этапа 5 (ручной ввод срока остаётся),
 * здесь только чтение активных записей в порядке отображения.
 */
import { asc, eq } from "drizzle-orm";
import { getDocflowDb } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";

const { deadlinePresets } = docflowSchema;

export interface DeadlinePresetRecord {
  id: string;
  title: string;
  days: number;
  /** Считать дни рабочими (выходные и праздники пропускаются) — приложение А9. */
  isWorkday: boolean;
  sortOrder: number;
}

export async function listDeadlinePresets(): Promise<DeadlinePresetRecord[]> {
  const rows = await getDocflowDb()
    .select()
    .from(deadlinePresets)
    .where(eq(deadlinePresets.isActive, true))
    .orderBy(asc(deadlinePresets.sortOrder));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    days: r.days,
    isWorkday: r.isWorkday,
    sortOrder: r.sortOrder
  }));
}
