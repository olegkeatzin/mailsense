import type express from "express";
import { getAnalysis, logger } from "@mailsense/core";
import {
  AppError,
  listUserActivityStats,
  recomputeUserStats,
  setUserStatsMailFactsProvider,
  type MailFacts,
  type Permission
} from "@mailsense/docflow";
import { intParam } from "./params.js";

/**
 * Служебный доступ к агрегату «профиль исполнителя» (task-18).
 *
 * ⚠️ Подсказка исполнителей НЕ реализована: граф знаний — после 0.1.4. Здесь только
 * сбор производных данных и возможность увидеть, что они копятся. Читает только
 * администратор (settings.manage): это данные о людях, никаких рассылок из них нет.
 */
export interface StatsDeps {
  requireDocflowDb: express.RequestHandler;
  requirePermission: (permission: Permission) => express.RequestHandler;
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

export function mountStatsRoutes(app: express.Express, deps: StatsDeps): void {
  const { requireDocflowDb, requirePermission, asyncHandler } = deps;
  const manage = [requireDocflowDb, requirePermission("settings.manage")];

  /**
   * Провайдер фактов почты регистрирует КОМПОЗИЦИОННЫЙ КОРЕНЬ, а не docflow: docflow в core
   * не ходит (зависимость строго односторонняя). Теги и категории живут в почтовой базе,
   * поэтому их отдаёт сервер. Провайдер read-only: только чтение анализа по списку писем.
   */
  setUserStatsMailFactsProvider((emailIds) => {
    const facts = new Map<string, MailFacts>();
    for (const emailId of emailIds) {
      try {
        const analysis = getAnalysis(emailId);
        if (!analysis) continue;
        facts.set(emailId, {
          tags: Array.isArray(analysis.tags) ? analysis.tags : [],
          categories: analysis.category ? [String(analysis.category)] : []
        });
      } catch (err) {
        // Одно битое письмо не должно ронять весь пересчёт: помечаем в лог и идём дальше.
        logger.warn(
          { err: (err as Error).message, emailId },
          "Не удалось прочитать анализ письма для агрегата профиля исполнителя"
        );
      }
    }
    return facts;
  });

  app.get(
    "/api/docflow/stats",
    ...manage,
    asyncHandler(async (req, res) => {
      const userId = typeof req.query.userId === "string" && req.query.userId ? req.query.userId : undefined;
      const limit = intParam(req.query.limit, "limit", { fallback: 200, min: 1, max: 1000 });
      res.json(await listUserActivityStats({ userId, limit }));
    })
  );

  app.post(
    "/api/docflow/stats/recompute",
    ...manage,
    asyncHandler(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.userIds !== undefined && !Array.isArray(b.userIds)) {
        throw new AppError("userIds — список идентификаторов пользователей", 400, "bad_user_ids");
      }
      const userIds = Array.isArray(b.userIds)
        ? b.userIds.map((v) => String(v ?? "").trim()).filter(Boolean)
        : undefined;
      // Без списка (или с пустым) пересчитываем всех, у кого есть активность.
      res.json(await recomputeUserStats(userIds && userIds.length ? { userIds } : {}));
    })
  );
}
