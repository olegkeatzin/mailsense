import type { MailProfile, MailProfilePatch } from "../types.js";
import { getMailProfileRow, upsertMailProfileRow } from "../repos.js";

/**
 * Личный профиль почты работника (решение Р18).
 *
 * ⚠️ Это ЧИСТО ЛОКАЛЬНЫЕ данные: ни сети, ни docflow. Пользователи живут на сервере,
 * поэтому ключ — просто строка (LDAP-логин), без внешнего ключа на локальную таблицу.
 *
 * Профиль задаёт то, чего не может дать общий служебный ящик: имя подписи, свою подпись
 * и предпочтения ответа. Пока работник ничего не сохранял, профиль отдаётся со значениями
 * по умолчанию — как у настроек ящика, чтобы поведение не менялось молча.
 *
 * Тексты отказов читает ЧЕЛОВЕК в настройках: ни английских имён полей, ни проводных
 * значений перечислений («above», «ru»). Машинные признаки живут в code и field и в текст
 * не попадают — на них опираются маршрут и интерфейс.
 */

/**
 * Отказ по данным профиля: это 400-класс, а не сбой сервера.
 * Поля нельзя «почистить молча» — иначе в письме окажется не то, что человек написал.
 */
export class MailProfileInputError extends Error {
  /** Машинный признак отказа (маршрут и фронт могут на него опираться). */
  readonly code: string;
  /** Имя поля, из-за которого отказ, — для журнала разработчика, а не для человека. */
  readonly field: string | null;

  constructor(message: string, code = "profile.invalid", field: string | null = null) {
    super(message);
    this.name = "MailProfileInputError";
    this.code = code;
    this.field = field;
  }
}

/** Границы из постановки: имя в заголовке From короче, подпись — длиннее. */
const DISPLAY_NAME_MAX = 120;
const SIGNATURE_TEXT_MAX = 4000;

/** Разрешённые поля патча (машинные имена): неизвестное поле — ошибка, а не тихий no-op. */
const PATCH_FIELDS = [
  "displayName",
  "signatureText",
  "signatureEnabled",
  "signaturePosition",
  "replyQuote",
  "replyAttribution"
] as const;

/** Человеческие названия полей — для текста отказа (в интерфейс идут именно они). */
const FIELD_TITLES =
  "имя в письме, подпись, подпись включена, положение подписи, цитата в ответе, язык цитаты";

/** Профиль по умолчанию: значения как у настроек ящика (подпись и цитата включены). */
const DEFAULTS = {
  displayName: "",
  signatureText: "",
  signatureEnabled: true,
  signaturePosition: "below" as const,
  replyQuote: true,
  replyAttribution: "ru" as const
};

/** Ключ — учётная запись работника: непустая строка (края обрезаем, регистр сохраняем). */
function readUserId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new MailProfileInputError(
      "Не указан работник, для которого сохраняется профиль",
      "profile.user_missing"
    );
  }
  return raw.trim();
}

/** Имя для From: не длиннее 120 и без переводов строк — заголовок иначе ломается. */
function readDisplayName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MailProfileInputError("Имя в письме: ожидается текст", "profile.display_name_type", "displayName");
  }
  if (raw.length > DISPLAY_NAME_MAX) {
    throw new MailProfileInputError(
      "Имя в письме: не длиннее " + DISPLAY_NAME_MAX + " символов",
      "profile.display_name_too_long",
      "displayName"
    );
  }
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new MailProfileInputError(
        "Имя в письме не может содержать перевод строки или непечатаемый символ",
        "profile.display_name_control",
        "displayName"
      );
    }
  }
  return raw;
}

function readSignatureText(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MailProfileInputError("Подпись: ожидается текст", "profile.signature_text_type", "signatureText");
  }
  if (raw.length > SIGNATURE_TEXT_MAX) {
    throw new MailProfileInputError(
      "Подпись: не длиннее " + SIGNATURE_TEXT_MAX + " символов",
      "profile.signature_text_too_long",
      "signatureText"
    );
  }
  return raw;
}

/** Да/нет — с человеческим названием переключателя. */
function readBoolean(raw: unknown, message: string, code: string, field: string): boolean {
  if (typeof raw !== "boolean") throw new MailProfileInputError(message, code, field);
  return raw;
}

function readPosition(raw: unknown): "above" | "below" {
  if (raw !== "above" && raw !== "below") {
    throw new MailProfileInputError(
      "Положение подписи: выберите «до цитаты» или «после цитаты»",
      "profile.position_invalid",
      "signaturePosition"
    );
  }
  return raw;
}

function readAttribution(raw: unknown): "ru" | "en" {
  if (raw !== "ru" && raw !== "en") {
    throw new MailProfileInputError(
      "Язык подписи в цитате: русский или английский",
      "profile.attribution_invalid",
      "replyAttribution"
    );
  }
  return raw;
}

/** Текущий профиль работника; если строки нет — значения по умолчанию, а не ошибка. */
export function getMailProfile(userId: string): MailProfile {
  const key = readUserId(userId);
  return getMailProfileRow(key) ?? { userId: key, ...DEFAULTS, updatedAt: null };
}

/**
 * Частичное обновление профиля: переданные поля меняются, остальные остаются.
 * Пустая строка — допустимое значение («не задано»), undefined — «поле не передавали».
 * Валидация идёт ДО записи: после отказа в базе ничего не меняется.
 */
export function setMailProfile(userId: string, patch: MailProfilePatch): MailProfile {
  const key = readUserId(userId);
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new MailProfileInputError("Настройки профиля: ожидается набор полей", "profile.patch_type");
  }

  const current = getMailProfile(key);
  const raw = patch as Record<string, unknown>;

  for (const field of Object.keys(raw)) {
    if (!(PATCH_FIELDS as readonly string[]).includes(field)) {
      // Имя поля в текст не попадает: это опечатка разработчика, а не то, что читает человек.
      // Для разбора в журнале оно есть в err.field.
      throw new MailProfileInputError(
        "Неизвестное поле настроек профиля. Допустимые: " + FIELD_TITLES,
        "profile.unknown_field",
        field
      );
    }
  }

  const next: MailProfile = { ...current, userId: key };
  if (raw.displayName !== undefined) next.displayName = readDisplayName(raw.displayName);
  if (raw.signatureText !== undefined) next.signatureText = readSignatureText(raw.signatureText);
  if (raw.signatureEnabled !== undefined) {
    next.signatureEnabled = readBoolean(
      raw.signatureEnabled,
      "Подпись включена: ожидается да или нет",
      "profile.signature_enabled_type",
      "signatureEnabled"
    );
  }
  if (raw.signaturePosition !== undefined) next.signaturePosition = readPosition(raw.signaturePosition);
  if (raw.replyQuote !== undefined) {
    next.replyQuote = readBoolean(
      raw.replyQuote,
      "Цитата в ответе: ожидается да или нет",
      "profile.reply_quote_type",
      "replyQuote"
    );
  }
  if (raw.replyAttribution !== undefined) next.replyAttribution = readAttribution(raw.replyAttribution);

  next.updatedAt = new Date().toISOString();
  upsertMailProfileRow(next);
  return next;
}
