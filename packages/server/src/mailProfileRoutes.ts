import type express from "express";
import { getMailProfile, setMailProfile, MailProfileInputError } from "@mailsense/core";
// Единый класс отказа для всего сервера: обработчик ошибок распознаёт именно его (isAppError).
import { AppError } from "@mailsense/docflow";

/**
 * Личный профиль почты работника (T34/T35, решение Р18).
 *
 * ⚠️ Это ЛИЧНОЕ: профиль живёт в локальной базе клиента и НА СЕРВЕР НЕ УЕЗЖАЕТ. Маршрут
 * обслуживается локально в обоих режимах — в клиентском он намеренно НЕ входит ни в
 * MAIL_PREFIXES, ни в DOCFLOW_PREFIXES (см. proxy.ts), иначе имя и подпись работника
 * оказались бы на общем сервере.
 *
 * Доступен ЛЮБОМУ вошедшему: своих данных достаточно, права settings.manage тут не нужны
 * (это не настройка предприятия). Работник берётся из подтверждённой сессии.
 *
 * ⚠️ Поля и правила проверяет ЯДРО (task-34) — один источник правды: маршрут передаёт патч
 * как есть и переводит MailProfileInputError в 400 с готовым русским текстом. Своей копии
 * правил здесь нет намеренно: две копии разошлись бы при первой же правке.
 */
export interface MailProfileDeps {
  asyncHandler: (
    fn: (req: express.Request, res: express.Response) => Promise<unknown>
  ) => express.RequestHandler;
}

function requireUser(req: express.Request): { id: string; ldapUid?: string | null } {
  if (!req.user) throw new AppError("Требуется вход в систему", 401, "unauthorized");
  return req.user as unknown as { id: string; ldapUid?: string | null };
}

/**
 * Ключ профиля — учётная запись работника (LDAP-логин), решение Р18/Т2: настройки личные,
 * а не «на ящик». Если учётки в каталоге нет (локальный администратор), берём id пользователя,
 * чтобы профиль всё равно остался личным.
 */
function profileKey(req: express.Request): string {
  const user = requireUser(req);
  const login = String(user.ldapUid ?? "").trim();
  return login || user.id;
}

export function mountMailProfileRoutes(app: express.Express, deps: MailProfileDeps): void {
  const { asyncHandler } = deps;

  /** Профиль текущего работника. Пустой профиль — норма: ядро вернёт значения по умолчанию. */
  app.get(
    "/api/mail-profile",
    asyncHandler(async (req, res) => {
      res.json(await getMailProfile(profileKey(req)));
    })
  );

  /** Частичное обновление: меняем ровно то, что прислали (неприсланные поля не затираются). */
  app.put(
    "/api/mail-profile",
    asyncHandler(async (req, res) => {
      const key = profileKey(req);
      const body = req.body ?? {};
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new AppError("Тело запроса должно быть объектом с полями профиля", 400, "bad_profile");
      }
      try {
        res.json(await setMailProfile(key, body as Record<string, never>));
      } catch (err) {
        // Данные профиля не годятся (длинное имя, перевод строки, чужое значение перечисления,
        // опечатка в имени поля): это 400 с текстом ядра. «Ошибка сервера» здесь соврала бы —
        // человеку нужно понять, что поправить в настройках.
        if (err instanceof MailProfileInputError) {
          throw new AppError(err.message, 400, "bad_profile");
        }
        throw err;
      }
    })
  );
}
