import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Личный профиль почты работника (Р18) — ЛОКАЛЬНЫЕ данные: ни сети, ни docflow.
 * Ключ — учётная запись работника (LDAP-логин), а не ящик: за общим служебным ящиком
 * сидят разные люди, и подпись у каждого своя.
 */
import { initApp } from "../init.js";
import { closeDb, getDb } from "../db/index.js";
import { mailProfile } from "../db/schema.js";
import { MailProfileInputError, getMailProfile, setMailProfile } from "./mailProfileService.js";

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-profile-"));
  initApp({ dataDir: dir });
});

afterAll(() => {
  closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

const rowCount = (): number => getDb().select().from(mailProfile).all().length;

describe("профиль по умолчанию", () => {
  test("неизвестный пользователь даёт пустой профиль, а не ошибку", () => {
    const p = getMailProfile("no-such-user");

    expect(p).toEqual({
      userId: "no-such-user",
      displayName: "",
      signatureText: "",
      signatureEnabled: true,
      signaturePosition: "below",
      replyQuote: true,
      replyAttribution: "ru",
      updatedAt: null
    });
  });

  test("чтение не создаёт строку в базе", () => {
    getMailProfile("reader-only");
    expect(rowCount()).toBe(0);
  });
});

describe("создание и обновление", () => {
  test("создание: все поля сохраняются и читаются обратно", () => {
    const saved = setMailProfile("ivanov", {
      displayName: "Иванов И.И.",
      signatureText: "С уважением,\nИванов И.И.",
      signatureEnabled: false,
      signaturePosition: "above",
      replyQuote: false,
      replyAttribution: "en"
    });

    expect(saved.displayName).toBe("Иванов И.И.");
    expect(saved.signatureText).toBe("С уважением,\nИванов И.И.");
    expect(saved.signatureEnabled).toBe(false);
    expect(saved.signaturePosition).toBe("above");
    expect(saved.replyQuote).toBe(false);
    expect(saved.replyAttribution).toBe("en");
    expect(saved.updatedAt).toBeTruthy();
    expect(getMailProfile("ivanov")).toEqual(saved);
  });

  test("частичное обновление не затирает остальные поля", () => {
    setMailProfile("petrov", { displayName: "Петров П.П.", signatureText: "Петров" });
    const patched = setMailProfile("petrov", { signaturePosition: "above" });

    expect(patched.displayName).toBe("Петров П.П.");
    expect(patched.signatureText).toBe("Петров");
    expect(patched.signaturePosition).toBe("above");
    expect(patched.replyQuote).toBe(true); // не трогали — осталось значение по умолчанию
  });

  test("пустая строка допустима и означает «не задано»", () => {
    setMailProfile("sidorov", { displayName: "Сидоров", signatureText: "текст" });
    const cleared = setMailProfile("sidorov", { displayName: "", signatureText: "" });

    expect(cleared.displayName).toBe("");
    expect(cleared.signatureText).toBe("");
  });

  test("идемпотентность: повторная запись не плодит строки", () => {
    const first = setMailProfile("idem", { displayName: "Идемпотентов" });
    const second = setMailProfile("idem", { displayName: "Идемпотентов" });

    expect(second.displayName).toBe(first.displayName);
    expect(getDb().select().from(mailProfile).all().filter((r) => r.userId === "idem")).toHaveLength(1);
  });

  test("профили разных пользователей независимы", () => {
    setMailProfile("user-a", { displayName: "Работник А", signatureText: "А" });
    setMailProfile("user-b", { displayName: "Работник Б", signatureText: "Б" });

    expect(getMailProfile("user-a").displayName).toBe("Работник А");
    expect(getMailProfile("user-a").signatureText).toBe("А");
    expect(getMailProfile("user-b").displayName).toBe("Работник Б");
    expect(getMailProfile("user-b").signatureText).toBe("Б");
  });

  test("границы длин принимаются ровно на пределе", () => {
    const p = setMailProfile("limits", { displayName: "н".repeat(120), signatureText: "с".repeat(4000) });
    expect(p.displayName).toHaveLength(120);
    expect(p.signatureText).toHaveLength(4000);
  });
});

describe("валидация (единый источник, отказ — а не тихая чистка)", () => {
  test("слишком длинное имя и перевод строки отвергаются", () => {
    expect(() => setMailProfile("v1", { displayName: "я".repeat(121) })).toThrow(MailProfileInputError);
    expect(() => setMailProfile("v1", { displayName: "Иванов\nBcc: evil@test.local" })).toThrow(MailProfileInputError);
    expect(() => setMailProfile("v1", { displayName: "Иванов\r\nBcc: evil@test.local" })).toThrow(MailProfileInputError);
  });

  test("слишком длинная подпись отвергается", () => {
    expect(() => setMailProfile("v2", { signatureText: "с".repeat(4001) })).toThrow(MailProfileInputError);
  });

  test("перечисления проверяются", () => {
    expect(() => setMailProfile("v3", { signaturePosition: "before" as never })).toThrow(MailProfileInputError);
    expect(() => setMailProfile("v3", { replyAttribution: "de" as never })).toThrow(MailProfileInputError);
  });

  test("неверные типы отвергаются, а не приводятся молча", () => {
    expect(() => setMailProfile("v4", { signatureEnabled: "yes" as never })).toThrow(MailProfileInputError);
    expect(() => setMailProfile("v4", { replyQuote: 1 as never })).toThrow(MailProfileInputError);
    expect(() => setMailProfile("v4", { displayName: 42 as never })).toThrow(MailProfileInputError);
  });

  test("неизвестное поле — ошибка, а не тихий no-op", () => {
    // Иначе опечатка клиента (signature_text вместо signatureText) не сохраняла бы ничего.
    expect(() => setMailProfile("v5", { signature_text: "x" } as never)).toThrow(MailProfileInputError);
  });

  test("пустой пользователь и не-объект отвергаются", () => {
    expect(() => getMailProfile("")).toThrow(MailProfileInputError);
    expect(() => setMailProfile("", { displayName: "X" })).toThrow(MailProfileInputError);
    expect(() => setMailProfile("v6", null as never)).toThrow(MailProfileInputError);
  });

  test("после отказа в базе ничего не меняется", () => {
    setMailProfile("v7", { displayName: "Как было" });
    expect(() => setMailProfile("v7", { signatureText: "с".repeat(4001) })).toThrow(MailProfileInputError);
    expect(getMailProfile("v7").displayName).toBe("Как было");
  });
});

/**
 * Отказы профиля читает ЧЕЛОВЕК в настройках: английское имя поля или проводное
 * значение перечисления в тексте — это дефект, а не «техническая подробность».
 * Машинный признак живёт отдельно, в поле code.
 */
const FAILURES: Array<{ name: string; run: () => unknown; message: string; code: string }> = [
  {
    name: "имя длиннее 120",
    run: () => setMailProfile("h1", { displayName: "я".repeat(121) }),
    message: "Имя в письме: не длиннее 120 символов",
    code: "profile.display_name_too_long"
  },
  {
    name: "перевод строки в имени",
    run: () => setMailProfile("h2", { displayName: "Иванов\nBcc: evil@test.local" }),
    message: "Имя в письме не может содержать перевод строки или непечатаемый символ",
    code: "profile.display_name_control"
  },
  {
    name: "имя не текст",
    run: () => setMailProfile("h3", { displayName: 42 as never }),
    message: "Имя в письме: ожидается текст",
    code: "profile.display_name_type"
  },
  {
    name: "подпись длиннее 4000",
    run: () => setMailProfile("h4", { signatureText: "с".repeat(4001) }),
    message: "Подпись: не длиннее 4000 символов",
    code: "profile.signature_text_too_long"
  },
  {
    name: "подпись не текст",
    run: () => setMailProfile("h5", { signatureText: 7 as never }),
    message: "Подпись: ожидается текст",
    code: "profile.signature_text_type"
  },
  {
    name: "переключатель подписи не да/нет",
    run: () => setMailProfile("h6", { signatureEnabled: "yes" as never }),
    message: "Подпись включена: ожидается да или нет",
    code: "profile.signature_enabled_type"
  },
  {
    name: "чужое положение подписи",
    run: () => setMailProfile("h7", { signaturePosition: "before" as never }),
    message: "Положение подписи: выберите «до цитаты» или «после цитаты»",
    code: "profile.position_invalid"
  },
  {
    name: "цитата не да/нет",
    run: () => setMailProfile("h8", { replyQuote: 1 as never }),
    message: "Цитата в ответе: ожидается да или нет",
    code: "profile.reply_quote_type"
  },
  {
    name: "чужой язык цитаты",
    run: () => setMailProfile("h9", { replyAttribution: "de" as never }),
    message: "Язык подписи в цитате: русский или английский",
    code: "profile.attribution_invalid"
  },
  {
    name: "неизвестное поле",
    run: () => setMailProfile("h10", { signature_text: "x" } as never),
    message:
      "Неизвестное поле настроек профиля. Допустимые: имя в письме, подпись, подпись включена, " +
      "положение подписи, цитата в ответе, язык цитаты",
    code: "profile.unknown_field"
  },
  {
    name: "патч не объект",
    run: () => setMailProfile("h11", null as never),
    message: "Настройки профиля: ожидается набор полей",
    code: "profile.patch_type"
  },
  {
    name: "не указан работник",
    run: () => setMailProfile("", { displayName: "Кто-то" }),
    message: "Не указан работник, для которого сохраняется профиль",
    code: "profile.user_missing"
  }
];

/** Ловит отказ профиля; если отказа не было — тест обязан это заметить. */
function catchFailure(run: () => unknown): MailProfileInputError {
  try {
    run();
  } catch (err) {
    if (err instanceof MailProfileInputError) return err;
    throw err;
  }
  throw new Error("Ожидался отказ профиля, но его не было");
}

describe("человеческие тексты отказов профиля", () => {
  test.each(FAILURES)("$name: текст по-русски и машинный код", ({ run, message, code }) => {
    const err = catchFailure(run);
    expect(err.message).toBe(message);
    expect(err.code).toBe(code);
  });

  test("в текстах нет camelCase-имён полей и проводных значений", () => {
    for (const f of FAILURES) {
      const text = catchFailure(f.run).message;
      // Английское имя поля (displayName) или проводное значение (above | below | ru | en)
      // в настройках увидит человек — это и есть защита от возврата технического текста.
      expect(text).not.toMatch(/[a-z][A-Z]/);
      expect(text).not.toMatch(/\b(above|below|ru|en)\b/);
    }
  });

  test("машинный код не подмешивается в текст отказа", () => {
    for (const f of FAILURES) {
      const err = catchFailure(f.run);
      expect(err.message).not.toContain(err.code);
    }
  });
});
