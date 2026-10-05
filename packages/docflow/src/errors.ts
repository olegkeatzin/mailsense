/**
 * Ошибки приложения с HTTP-статусом.
 *
 * Смысл: ожидаемые отказы (неверный пароль, нет прав, каталог не настроен)
 * должны отдаваться клиенту понятным текстом и правильным кодом, а не 500
 * с внутренним дампом LDAP.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "bad_request") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

/** Неверные учётные данные или истёкшая сессия. */
export class AuthError extends AppError {
  constructor(message = "Неверный логин или пароль") {
    super(message, 401, "unauthorized");
    this.name = "AuthError";
  }
}

/** Вошёл, но прав на действие нет. */
export class ForbiddenError extends AppError {
  constructor(message = "Недостаточно прав для этого действия") {
    super(message, 403, "forbidden");
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Не найдено") {
    super(message, 404, "not_found");
    this.name = "NotFoundError";
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
