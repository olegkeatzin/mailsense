/**
 * Правила автосортировки (этап 5, §2/§6 контракта).
 *
 * ⚠️ Правило НЕ создаёт документ и не трогает нумерацию: оно помечает письмо меткой,
 * приоритетом и подсказкой аппарату и поднимает его в очереди. Документ по-прежнему
 * создаёт человек (rules §6.1, docs/docflow.md «Письмо размечает аппарат»).
 *
 * Матчинг здесь НЕ реализуется: его делает `matchSortRules` из @mailsense/core (§5).
 * Двух реализаций матчинга быть не должно — иначе правило будет срабатывать по-разному
 * в предпросмотре и в списке писем.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { getDocflowDb } from "./db/index.js";
import { docflowSchema } from "./db/schema.js";
import { auditInTx } from "./audit.js";
import { AppError } from "./errors.js";
import type { Actor } from "./journal.js";
import type { MailSortRuleRecord } from "./types.js";

const { mailSortRules } = docflowSchema;

/**
 * Проверка правила, которую регистрирует владелец core (тот же приём, что setLdapSettingsStore):
 * вторая реализация границ §5 разошлась бы с матчингом, а импортировать весь barrel core
 * в docflow нельзя — он тянет почту, ИИ и нативные модули.
 *
 * Зарегистрирована — правило любой ценой проходит через неё; нет — проверяет вызывающий
 * (маршрут), и хранилище остаётся работоспособным модулем без core.
 */
export type SortRuleValidator = (rule: Partial<MailSortRuleRecord>) => { ok: boolean; errors: string[] };

let sortRuleValidator: SortRuleValidator | null = null;

export function setSortRuleValidator(validator: SortRuleValidator | null): void {
  sortRuleValidator = validator;
}

/** Последняя линия защиты перед записью: имя, длины, пустые матчеры, приоритет. */
function assertRuleAllowed(rule: Partial<MailSortRuleRecord>): void {
  if (!sortRuleValidator) return;
  const check = sortRuleValidator(rule);
  if (!check.ok) {
    throw new AppError("Правило не сохранено: " + check.errors.join("; "), 400, "bad_rule");
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function mapRule(row: typeof mailSortRules.$inferSelect): MailSortRuleRecord {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    matchFrom: row.matchFrom,
    matchTo: row.matchTo,
    matchSubject: row.matchSubject,
    label: row.label,
    priority: row.priority,
    note: row.note
  };
}

/** Правила в порядке применения: sortOrder ASC, затем id (§5). */
export async function listSortRules(): Promise<MailSortRuleRecord[]> {
  const rows = await getDocflowDb()
    .select()
    .from(mailSortRules)
    .orderBy(asc(mailSortRules.sortOrder), asc(mailSortRules.id));
  return rows.map(mapRule);
}

export async function getSortRule(id: string): Promise<MailSortRuleRecord | null> {
  const rows = await getDocflowDb().select().from(mailSortRules).where(eq(mailSortRules.id, id)).limit(1);
  return rows[0] ? mapRule(rows[0]) : null;
}

export interface SortRuleInput {
  id?: string;
  name?: string;
  isActive?: boolean;
  sortOrder?: number;
  matchFrom?: string;
  matchTo?: string;
  matchSubject?: string;
  label?: string;
  priority?: number | null;
  note?: string;
}

/**
 * Создание (без id) или правка (с id) правила.
 *
 * Мутация и след аудита — ОДНА транзакция (AGENTS.md, п. 4): иначе правило менялось бы
 * без следа, а «кто поменял маршрутизацию почты» — ровно тот вопрос, ради которого
 * система и заведена.
 *
 * Поля без id трактуются как частичная правка: не переданное поле сохраняется, иначе
 * PATCH «только название» молча включал бы выключенное правило.
 */
export async function saveSortRule(input: SortRuleInput, actor: Actor): Promise<MailSortRuleRecord> {
  const id = input.id ?? randomUUID();
  const ts = new Date();

  return getDocflowDb().transaction(async (tx) => {
    const existing = (
      await tx.select().from(mailSortRules).where(eq(mailSortRules.id, id)).limit(1)
    )[0];
    if (input.id && !existing) throw new AppError("Правило не найдено", 404, "not_found");

    const name = String(input.name !== undefined ? input.name : (existing?.name ?? "")).trim();
    if (!name) throw new AppError("Укажите название правила", 400, "bad_name");
    if (input.priority !== undefined && input.priority !== null && !Number.isInteger(input.priority)) {
      throw new AppError("Приоритет — целое число от 1 до 5 или пусто", 400, "bad_priority");
    }

    const values = {
      name,
      isActive: input.isActive !== undefined ? input.isActive : (existing?.isActive ?? true),
      sortOrder:
        input.sortOrder !== undefined && Number.isInteger(input.sortOrder)
          ? input.sortOrder
          : (existing?.sortOrder ?? 0),
      matchFrom: input.matchFrom !== undefined ? String(input.matchFrom) : (existing?.matchFrom ?? ""),
      matchTo: input.matchTo !== undefined ? String(input.matchTo) : (existing?.matchTo ?? ""),
      matchSubject:
        input.matchSubject !== undefined ? String(input.matchSubject) : (existing?.matchSubject ?? ""),
      label: input.label !== undefined ? String(input.label) : (existing?.label ?? ""),
      priority: input.priority !== undefined ? input.priority : (existing?.priority ?? null),
      note: input.note !== undefined ? String(input.note) : (existing?.note ?? ""),
      updatedAt: ts
    };

    // Проверяем ИТОГ правки, а не патч: иначе снятие последнего матчера прошло бы
    // проверку присланных полей и правило начало бы ловить всю почту.
    assertRuleAllowed({ id, ...values });

    if (existing) {
      await tx.update(mailSortRules).set(values).where(eq(mailSortRules.id, id));
    } else {
      await tx.insert(mailSortRules).values({ id, ...values, createdBy: actor.id, createdAt: ts });
    }

    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: existing ? "sorting.rule.update" : "sorting.rule.create",
      entityType: "mail_sort_rule",
      entityId: id,
      oldValue: existing ? stringify(mapRule(existing)) : null,
      newValue: stringify(values)
    });

    const after = (await tx.select().from(mailSortRules).where(eq(mailSortRules.id, id)).limit(1))[0];
    return mapRule(after);
  });
}

/** Удаление правила. false — правила нет (маршрут отвечает 404), следа при этом не пишем. */
export async function deleteSortRule(id: string, actor: Actor): Promise<boolean> {
  return getDocflowDb().transaction(async (tx) => {
    const existing = (await tx.select().from(mailSortRules).where(eq(mailSortRules.id, id)).limit(1))[0];
    if (!existing) return false;
    await tx.delete(mailSortRules).where(eq(mailSortRules.id, id));
    await auditInTx(tx, {
      userId: actor.id,
      userName: actor.name,
      action: "sorting.rule.delete",
      entityType: "mail_sort_rule",
      entityId: id,
      oldValue: stringify(mapRule(existing)),
      newValue: null
    });
    return true;
  });
}
