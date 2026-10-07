import { DOCUMENT_STATUS_TITLES, type DocumentStatus } from "../../types";

/**
 * Единый источник русских подписей для СЭД (аудит ux-designer, §5).
 *
 * Раньше ACTION_TITLES лежала ДВАЖДЫ (AuditTab и DocumentCard) и расходилась: один и тот же
 * поступок назывался по-разному. Плюс fallback вида MAP[x] ?? x показывал человеку сырой ключ
 * (resolution.dispatch, number_rule, docNumber) — это и есть служебный текст в разметке.
 * Правило: неизвестное значение получает ЧЕЛОВЕЧЕСКИЙ fallback, а не сам ключ.
 */

export const ACTION_TITLES: Record<string, string> = {
  "journal.register": "Регистрация документа",
  "journal.edit": "Изменение документа",
  "journal.link_email": "Привязка письма",
  "journal.register_denied": "Отклонённая регистрация",
  "journal.numbering.save": "Смена правил нумерации",
  "journal.archive_period": "Выгрузка года в архив",
  "journal.reopen_period": "Отмена закрытия года",
  "journal.import_year": "Импорт года",
  "journal.case.save": "Изменение номенклатуры дел",
  "journal.correspondent.save": "Изменение корреспондента",
  "journal.correspondent.create": "Новый корреспондент",
  "docflow.service_account": "Смена служебного ящика",
  "directory.sync": "Синхронизация каталога",
  login: "Вход в систему",
  login_failed: "Неудачный вход",
  login_blocked: "Вход заблокирован",
  "user.create": "Создание пользователя",
  "user.update": "Изменение пользователя",
  "user.roles": "Смена ролей",
  "user.block": "Блокировка пользователя",
  "user.unblock": "Разблокировка пользователя",
  "settings.save": "Изменение настроек",
  "notifications.settings": "Настройки уведомлений",
  "sorting.rule.create": "Новое правило сортировки",
  "sorting.rule.update": "Изменение правила сортировки",
  "sorting.rule.delete": "Удаление правила сортировки",
  "resolution.create": "Подготовка резолюции",
  "resolution.edit": "Правка резолюции",
  "resolution.request_approval": "Отправка на утверждение",
  "resolution.request_email": "Утверждение письмом",
  "resolution.email_approval": "Ответ подписанта получен",
  "resolution.confirm_approval": "Утверждение подтверждено",
  "resolution.reject": "Возврат на доработку",
  "resolution.approve": "Резолюция утверждена",
  "resolution.approve_denied": "Отказ в утверждении",
  "resolution.assignees": "Смена исполнителей",
  "resolution.dispatch": "Отправка исполнителям",
  "resolution.dispatch_email": "Поручение отправлено письмом",
  "resolution.dispatch_failed": "Отправка поручения не удалась",
  "resolution.forward": "Пересылка руководителю",
  "resolution.received": "Расписка исполнителя",
  "resolution.report": "Отчёт исполнителя",
  "resolution.report_confirmed": "Отчёт подтверждён",
  "resolution.done": "Поручение закрыто",
  "resolution.cancel": "Поручение отменено"
};

export const ACTION_UNKNOWN = "Прочее действие";

export function actionTitle(action: string | null | undefined): string {
  if (!action) return ACTION_UNKNOWN;
  return ACTION_TITLES[action] ?? ACTION_UNKNOWN;
}

export const ENTITY_TITLES: Record<string, string> = {
  document: "Документ",
  resolution: "Поручение",
  notification: "Уведомление",
  sort_rule: "Правило сортировки",
  user: "Пользователь",
  number_rule: "Правило нумерации",
  case: "Дело",
  correspondent: "Корреспондент",
  settings: "Настройки",
  deadline_preset: "Типовой срок"
};

export const ENTITY_UNKNOWN = "Другой объект";

export function entityTitle(entity: string | null | undefined): string {
  if (!entity) return ENTITY_UNKNOWN;
  return ENTITY_TITLES[entity] ?? ENTITY_UNKNOWN;
}

export const FIELD_TITLES: Record<string, string> = {
  docNumber: "Номер отправителя",
  docDate: "Дата отправителя",
  sender: "Отправитель",
  summary: "Краткое содержание",
  sheetsCount: "Листов",
  caseNumber: "Номер дела",
  documentName: "Наименование",
  status: "Состояние",
  regNumber: "Регистрационный номер",
  regDate: "Дата регистрации",
  priority: "Приоритет",
  deadline: "Срок",
  text: "Текст поручения",
  isActive: "Включено",
  name: "Название",
  label: "Метка",
  sortOrder: "Порядок",
  matchFrom: "Отправитель содержит",
  matchTo: "Получатель содержит",
  matchSubject: "Тема содержит",
  note: "Примечание",
  enabled: "Уведомления включены",
  dueSoonDays: "За дней до срока",
  holidays: "Праздничные дни",
  roles: "Роли",
  fullName: "ФИО",
  isBlocked: "Блокировка",
  // Поля-ссылки: их значения — идентификаторы, которые надо разрешать в человеческое.
  accountId: "Ящик",
  incomingAccountId: "Внешняя приёмная",
  userId: "Пользователь",
  executorId: "Исполнитель",
  responsibleId: "Ответственный",
  assignees: "Исполнители",
  documentId: "Документ",
  resolutionId: "Поручение",
  correspondentId: "Корреспондент",
  createdBy: "Автор",
  preparedBy: "Подготовил",
  approvedBy: "Утвердил",
  dispatchedBy: "Отправил",
  entityId: "Объект"
};

export const FIELD_UNKNOWN = "Поле";

export function fieldTitle(field: string | null | undefined): string {
  if (!field) return FIELD_UNKNOWN;
  return FIELD_TITLES[field] ?? FIELD_UNKNOWN;
}

export const SOURCE_TITLES: Record<string, string> = {
  ldap: "Каталог",
  local: "Локальная",
  manual: "Вручную"
};

export const SOURCE_UNKNOWN = "Неизвестный источник";

export function sourceTitle(source: string | null | undefined): string {
  if (!source) return SOURCE_UNKNOWN;
  return SOURCE_TITLES[source] ?? SOURCE_UNKNOWN;
}

/** Похоже ли значение на технический идентификатор (UUID). */
// Намеренно НЕ type guard: иначе в ветке «не идентификатор» TypeScript сузил бы строку до never.
export function looksLikeId(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Значение-идентификатор, который расшифровать не удалось: UUID в интерфейс не попадает. */
export const UNRESOLVED_VALUE = "изменено (не удалось расшифровать)";

/** Чем разрешать идентификаторы: id → человеческое имя. Источники подставляет вызывающий. */
export interface ValueRefs {
  resolve?: (field: string, id: string) => string | null;
}

/** Дата в виде ДД.ММ.ГГГГ, если строка похожа на дату. */
function looksLikeDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(s);
}

/**
 * Значение для «что изменилось» — без JSON и без технических слов.
 * true/false → да/нет, null/пусто → «—», массив → через запятую, объект → «изменено».
 */
export function formatValue(value: unknown, field?: string, refs?: ValueRefs): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Идентификатор разрешаем в человеческое; не удалось — нейтральный текст, но не UUID.
    if (looksLikeId(value)) {
      return refs?.resolve?.(field ?? "", value) ?? UNRESOLVED_VALUE;
    }
    if (field === "status" && value in DOCUMENT_STATUS_TITLES) {
      return DOCUMENT_STATUS_TITLES[value as DocumentStatus];
    }
    if (looksLikeDate(value)) {
      const iso = value.slice(0, 10);
      const [y, m, d] = iso.split("-");
      return d + "." + m + "." + y;
    }
    return value;
  }
  // Массив (например, список исполнителей) — через запятую, каждый элемент тоже разрешаем.
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => formatValue(v, field, refs)).join(", ") : "—";
  }
  return "изменено";
}
