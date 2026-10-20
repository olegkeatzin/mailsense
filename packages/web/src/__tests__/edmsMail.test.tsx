/** @jest-environment jsdom */
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

// Тяжёлый набор (antd-карточка документа + модалка направления). Под параллельным прогоном
// рендер под нагрузкой не укладывался в секунду ожидания по умолчанию — отсюда ложные
// «Unable to find role=button» при зелёном последовательном прогоне. Тот же запас, что
// в остальных тяжёлых наборах (ReplyMarker, NumberingTab, ui.noDebugText).
configure({ asyncUtilTimeout: 8000 });

jest.mock("../api", () => ({
  api: {
    document: jest.fn(),
    audit: jest.fn(),
    updateDocument: jest.fn(),
    saveSetting: jest.fn(),
    settings: jest.fn()
  },
  resolutionApi: {
    byDocument: jest.fn(),
    executorCandidates: jest.fn(),
    deadlinePresets: jest.fn(),
    forward: jest.fn(),
    dispatch: jest.fn(),
    report: jest.fn(),
    myEdmsMail: jest.fn(),
    saveMyEdmsMail: jest.fn(),
    icsUrl: () => ""
  },
  notificationApi: { list: jest.fn(), sortRules: jest.fn(), settings: jest.fn() }
}));

import { api, resolutionApi } from "../api";
import DocumentCard from "../components/DocumentCard";
import { EdmsMailSection } from "../components/EdmsMailSection";
import {
  EdmsMailSelect,
  edmsActionOptions,
  edmsMailProblem,
  edmsMailWarning,
  edmsSendErrorText,
  isEdmsMailError,
  preferredActionAccountId,
  preferredEdmsAccountId
} from "../components/edmsMail";
import { useStore } from "../store";
import type { AuthStatus, AuthUser, EdmsMailSettings } from "../types";

const initial = useStore.getState();

const personal: EdmsMailSettings["allowed"][number] = {
  id: "acc-1",
  username: "petrova@mail.test",
  host: "mail.test",
  smtpReady: true,
  kind: "personal"
};
const service: EdmsMailSettings["allowed"][number] = {
  id: "acc-srv",
  username: "docflow@mail.test",
  host: "mail.test",
  smtpReady: true,
  kind: "service"
};

function setPermissions(permissions: string[]) {
  useStore.setState({
    ...initial,
    authReady: true,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions, roles: ["secretary"], fullName: "Мария Петрова" } as unknown as AuthUser
  });
}

describe("ящик для СЭД: правила выбора (T53)", () => {
  it("ничего не выбрано и служебный не настроен — говорим причину, а не берём первый", () => {
    expect(edmsMailProblem(null)).toMatch(/Не удалось получить список ящиков/);
    expect(edmsMailProblem({ accountId: null, account: null, allowed: [], defaultAccountId: null })).toMatch(
      /Нет подходящих ящиков/
    );
    // Ящик без настроенной отправки выбрать МОЖНО (T58): это не запрет, а предупреждение —
    // попытка уходит на сервер, отказ приходит кодом smtp_not_configured.
    const notReady = {
      accountId: "acc-1",
      account: null,
      allowed: [{ ...personal, smtpReady: false }],
      defaultAccountId: null
    };
    expect(edmsMailProblem(notReady)).toBe("");
    expect(edmsMailWarning(notReady)).toMatch(/не настроена отправка/);
    // Всё в порядке — ни запрета, ни предупреждения.
    expect(edmsMailProblem({ accountId: "acc-1", account: personal, allowed: [personal], defaultAccountId: null })).toBe("");
    expect(edmsMailWarning({ accountId: "acc-1", account: personal, allowed: [personal], defaultAccountId: null })).toBe("");
  });

  it("в действии предлагаются только служебный и ВЫБРАННЫЙ личный (D-T55)", () => {
    // petrova_ma выдан, но работник его не выбирал — сервер такую отправку отвергнет.
    const granted = { ...personal, id: "acc-granted", username: "petrova_ma@mail.test" };
    const chosen = { ...personal, id: "acc-chosen", username: "chosen@mail.test" };
    const settings: EdmsMailSettings = {
      accountId: "acc-chosen",
      account: { id: "acc-chosen", username: "chosen@mail.test", host: "mail.test", smtpReady: true },
      allowed: [service, granted, chosen],
      defaultAccountId: "acc-chosen"
    };

    expect(edmsActionOptions(settings).map((o) => o.id)).toEqual(["acc-srv", "acc-chosen"]);
    expect(preferredActionAccountId(settings)).toBe("acc-chosen");

    // Ничего не выбрано — остаётся только служебный.
    const noChoice: EdmsMailSettings = { ...settings, accountId: null, account: null, defaultAccountId: null };
    expect(edmsActionOptions(noChoice).map((o) => o.id)).toEqual(["acc-srv"]);
    expect(preferredActionAccountId(noChoice)).toBe("acc-srv");

    // Выбранного нет и служебного нет — отправлять не с чего, и это видно до запроса.
    const nothing: EdmsMailSettings = { accountId: null, account: null, allowed: [granted], defaultAccountId: null };
    expect(edmsActionOptions(nothing)).toEqual([]);
    expect(edmsMailProblem(nothing)).toMatch(/Не выбран ящик для писем СЭД/);

    // Выбранный личный совпал со служебным — один пункт, без дубля.
    const same: EdmsMailSettings = { ...settings, accountId: "acc-srv", allowed: [service] };
    expect(edmsActionOptions(same).map((o) => o.id)).toEqual(["acc-srv"]);
  });

  it("селектор действия не показывает выданный-но-не-выбранный ящик и меняется вслед за выбором", async () => {
    const granted = { ...personal, id: "acc-granted", username: "petrova_ma@mail.test" };
    const chosen = { ...personal, id: "acc-chosen", username: "chosen@mail.test" };
    const other = { ...personal, id: "acc-other", username: "other@mail.test" };
    const first: EdmsMailSettings = {
      accountId: "acc-chosen",
      account: null,
      allowed: [service, granted, chosen, other],
      defaultAccountId: "acc-chosen"
    };

    const view = render(<EdmsMailSelect value="acc-chosen" onChange={() => {}} settings={first} />);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Ящик для отправки" }));
    expect((await screen.findAllByText(/chosen@mail\.test/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/служебный/)).length).toBeGreaterThan(0);
    // Выданный, но не выбранный — в действии его быть не должно.
    expect(screen.queryByText(/petrova_ma@mail\.test/)).toBeNull();
    expect(screen.queryByText(/other@mail\.test/)).toBeNull();

    // Работник выбрал другой ящик — список действия поменялся.
    view.rerender(
      <EdmsMailSelect value="acc-other" onChange={() => {}} settings={{ ...first, accountId: "acc-other", defaultAccountId: "acc-other" }} />
    );
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Ящик для отправки" }));
    expect((await screen.findAllByText(/other@mail\.test/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/chosen@mail\.test/)).toBeNull();
    expect(screen.queryByText(/petrova_ma@mail\.test/)).toBeNull();
  });

  it("предвыбор: личный рабочий, затем служебный внутренний", () => {
    expect(preferredEdmsAccountId({ accountId: "acc-1", account: personal, allowed: [service, personal], defaultAccountId: "acc-srv" })).toBe(
      "acc-1"
    );
    expect(preferredEdmsAccountId({ accountId: null, account: null, allowed: [service, personal], defaultAccountId: "acc-srv" })).toBe(
      "acc-srv"
    );
    // Выбор остался, а ящика больше нет: говорим словами, а не показываем идентификатор.
    expect(
      edmsMailWarning({ accountId: "acc-gone", account: null, allowed: [personal], defaultAccountId: null })
    ).toMatch(/больше не существует/);
    // Единственный выданный ящик без отправки — всё равно предлагаем его (T58).
    expect(
      preferredEdmsAccountId({
        accountId: null,
        account: null,
        allowed: [{ ...personal, smtpReady: false }],
        defaultAccountId: null
      })
    ).toBe("acc-1");
    // Сервер ничего не предложил — берём готовый личный, а не служебный.
    expect(preferredEdmsAccountId({ accountId: null, account: null, allowed: [service, personal], defaultAccountId: null })).toBe(
      "acc-1"
    );
    expect(preferredEdmsAccountId(null)).toBeNull();
  });

  it("отказ сервера по ящику объясняется словами, а не кодом (T55)", () => {
    const withCode = (code: string, message = "403 Forbidden") => {
      const err = new Error(message) as Error & { code?: string };
      err.code = code;
      return err;
    };

    expect(edmsSendErrorText(withCode("account_not_allowed"))).toMatch(/С этого ящика отправлять нельзя/);
    // Коды «ящик не выбран»: сервер шлёт not_configured (не выбран / служебный снят) и no_account.
    expect(edmsSendErrorText(withCode("not_configured"))).toMatch(/Не выбран ящик для писем СЭД/);
    expect(edmsSendErrorText(withCode("no_account"))).toMatch(/Не выбран ящик для писем СЭД/);
    expect(edmsSendErrorText(withCode("smtp_not_configured"))).toMatch(/не настроена отправка/);
    expect(edmsSendErrorText(withCode("account_missing"))).toMatch(/больше не существует/);
    // Выдуманных кодов не держим: не серверный код — обычное объяснение сбоя.
    // Такого кода сервер не шлёт: подставлять ему свой текст мы не имеем права.
    expect(edmsSendErrorText(withCode("no_edms_mail"))).not.toMatch(/Не выбран ящик для писем СЭД/);
    // Ссылку «Выбрать другой ящик» даём только на отказы по ящику, не на любой сбой.
    expect(isEdmsMailError(withCode("smtp_not_configured"))).toBe(true);
    expect(isEdmsMailError(withCode("account_missing"))).toBe(true);
    expect(isEdmsMailError(withCode("account_not_allowed"))).toBe(true);
    expect(isEdmsMailError(withCode("not_configured"))).toBe(true);
    expect(isEdmsMailError(withCode("no_account"))).toBe(true);
    expect(isEdmsMailError(withCode("no_edms_mail"))).toBe(false);
    expect(isEdmsMailError(new Error("502 Bad Gateway"))).toBe(false);
    // Неизвестный код — обычное объяснение сбоя, без выдумок.
    expect(edmsSendErrorText(new Error("502 Bad Gateway"))).toMatch(/Сервер вернул ошибку/);
    // Русский текст сервера не переписываем.
    expect(edmsSendErrorText(new Error("Ящик недоступен"))).toBe("Ящик недоступен");
  });

  it("селектор помечает служебный ящик и неготовый к отправке", async () => {
    const settings: EdmsMailSettings = {
      accountId: null,
      account: null,
      allowed: [personal, { ...service, smtpReady: false }],
      defaultAccountId: null
    };
    render(<EdmsMailSelect value={null} onChange={() => {}} settings={settings} />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Ящик для отправки" }));
    expect((await screen.findAllByText(/служебный/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/отправка не настроена/)).length).toBeGreaterThan(0);
  });
});

describe("личные настройки: раздел «Почта для СЭД» (T53)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    (resolutionApi.myEdmsMail as jest.Mock).mockResolvedValue({
      accountId: null,
      account: null,
      allowed: [personal, service],
      defaultAccountId: "acc-srv"
    } as EdmsMailSettings);
    (resolutionApi.saveMyEdmsMail as jest.Mock).mockImplementation((id: string | null) =>
      Promise.resolve({ accountId: id, account: null, allowed: [personal, service], defaultAccountId: "acc-srv" })
    );
  });

  it("сохраняет выбранный ящик и объясняет, зачем выбор", async () => {
    render(<EdmsMailSection />);

    expect(await screen.findByText(/С этого ящика уходят письма руководителю и исполнителям/)).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Ящик для СЭД" }));
    fireEvent.click(await screen.findByText(/petrova@mail.test/));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить выбор" }));

    await waitFor(() => expect(resolutionApi.saveMyEdmsMail).toHaveBeenCalledWith("acc-1"));
  });

  it("можно снять выбор: сохраняем null, а не первый попавшийся ящик", async () => {
    (resolutionApi.myEdmsMail as jest.Mock).mockResolvedValue({
      accountId: "acc-1",
      account: personal,
      allowed: [personal, service],
      defaultAccountId: "acc-srv"
    } as EdmsMailSettings);
    render(<EdmsMailSection />);

    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Ящик для СЭД" }));
    fireEvent.click(await screen.findByText("Не выбран"));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить выбор" }));

    await waitFor(() => expect(resolutionApi.saveMyEdmsMail).toHaveBeenCalledWith(null));
  });

  it("доступных ящиков нет — честный текст вместо пустого списка", async () => {
    (resolutionApi.myEdmsMail as jest.Mock).mockResolvedValue({
      accountId: null,
      account: null,
      allowed: [],
      defaultAccountId: null
    } as EdmsMailSettings);
    render(<EdmsMailSection />);

    expect(await screen.findByText("Доступных ящиков нет")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить выбор" })).toBeNull();
  });
});

describe("действия СЭД передают выбранный ящик (T53)", () => {
  beforeAll(installDomEnvironment);

  beforeEach(() => {
    jest.clearAllMocks();
    setPermissions(["resolution.dispatch", "resolution.create", "journal.view"]);
    (api.document as jest.Mock).mockResolvedValue({
      id: "doc-1",
      regNumber: "вх38",
      regNumberNumeric: 38,
      regPeriod: "2026",
      regDate: "2026-10-06",
      docNumber: "17",
      docDate: "2026-10-05",
      sender: "Прокуратура",
      summary: "Обращение",
      sheetsCount: 2,
      caseNumber: "12-4",
      documentName: "Обращение",
      status: "new",
      emailId: null,
      correspondentId: null,
      createdBy: null,
      createdAt: "2026-10-06T10:00:00.000Z",
      updatedAt: "2026-10-06T10:00:00.000Z",
      archivedAt: null,
      emails: [],
      createdByName: "Иванов И.И.",
      emailsCount: 0
    });
    (api.audit as jest.Mock).mockResolvedValue({ entries: [], total: 0 });
    (resolutionApi.byDocument as jest.Mock).mockResolvedValue([]);
    (resolutionApi.executorCandidates as jest.Mock).mockResolvedValue([{ id: "u-signer", fullName: "Мария Петрова", email: "p@mail.test" }]);
    (resolutionApi.deadlinePresets as jest.Mock).mockResolvedValue({ items: [] });
    (resolutionApi.forward as jest.Mock).mockResolvedValue({ sentTo: "Мария Петрова" });
    (resolutionApi.myEdmsMail as jest.Mock).mockResolvedValue({
      accountId: "acc-1",
      account: personal,
      allowed: [personal, service],
      defaultAccountId: "acc-srv"
    } as EdmsMailSettings);
    useStore.setState({ docflowUnavailable: false });
  });

  it("«Направить руководителю» уходит с выбранного ящика", async () => {
    render(<DocumentCard documentId="doc-1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Направить руководителю" }));
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Кому направить" }));
    fireEvent.click(await screen.findByText("Мария Петрова"));
    fireEvent.click(await screen.findByRole("button", { name: "Направить" }));

    await waitFor(() => expect(resolutionApi.forward).toHaveBeenCalledWith("doc-1", "u-signer", "acc-1"));
  });

  it("ящик без настроенной отправки не блокирует попытку: предупреждаем, но отправляем (T58)", async () => {
    (resolutionApi.myEdmsMail as jest.Mock).mockResolvedValue({
      accountId: "acc-1",
      account: null,
      allowed: [{ ...personal, smtpReady: false }],
      defaultAccountId: "acc-1"
    } as EdmsMailSettings);
    render(<DocumentCard documentId="doc-1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Направить руководителю" }));
    // Предупреждение видно в окне направления, но кнопка не заблокирована.
    expect(await screen.findByText(/не настроена отправка/)).not.toBeNull();
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Кому направить" }));
    fireEvent.click(await screen.findByText("Мария Петрова"));
    fireEvent.click(await screen.findByRole("button", { name: "Направить" }));

    await waitFor(() => expect(resolutionApi.forward).toHaveBeenCalledWith("doc-1", "u-signer", "acc-1"));
  });

  it("в отказе есть ссылка «Выбрать другой ящик», и она открывает личные настройки", async () => {
    const err = new Error("400 Bad Request") as Error & { code?: string };
    err.code = "smtp_not_configured";
    (resolutionApi.forward as jest.Mock).mockRejectedValue(err);
    useStore.setState({ settingsOpen: false, settingsTab: null });
    render(<DocumentCard documentId="doc-1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Направить руководителю" }));
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Кому направить" }));
    fireEvent.click(await screen.findByText("Мария Петрова"));
    fireEvent.click(await screen.findByRole("button", { name: "Направить" }));

    await waitFor(() => expect(resolutionApi.forward).toHaveBeenCalled());
    // Отказ объяснён, и рядом предложено починить в один клик.
    // Явный timeout: окно письма в jsdom тяжёлое, сообщение может появиться не сразу.
    const fix = await screen.findByRole("button", { name: "Выбрать другой ящик" }, { timeout: 8000 });
    expect((document.body.textContent ?? "").match(/не настроена отправка/)).not.toBeNull();

    fireEvent.click(fix);
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useStore.getState().settingsTab).toBe("profile");
  });

  it("обычный сбой отправки объясняется без ссылки «Выбрать другой ящик»", async () => {
    (resolutionApi.forward as jest.Mock).mockRejectedValue(new Error("502 Bad Gateway"));
    render(<DocumentCard documentId="doc-1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Направить руководителю" }));
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Кому направить" }));
    fireEvent.click(await screen.findByText("Мария Петрова"));
    fireEvent.click(await screen.findByRole("button", { name: "Направить" }));

    await waitFor(() => expect(resolutionApi.forward).toHaveBeenCalled());
    await waitFor(() => expect((document.body.textContent ?? "").match(/Сервер вернул ошибку/)).not.toBeNull());
    // Дело не в ящике — ссылку на личные настройки не подсовываем.
    expect(screen.queryByRole("button", { name: "Выбрать другой ящик" })).toBeNull();
  });

  it("выбранный ящик удалили: действие не выполняется, текст понятный, идентификатор не светится (T58/D-T55)", async () => {
    (resolutionApi.myEdmsMail as jest.Mock).mockResolvedValue({
      accountId: "acc-gone",
      account: null,
      allowed: [personal],
      defaultAccountId: null
    } as EdmsMailSettings);
    render(<DocumentCard documentId="doc-1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Направить руководителю" }));
    // В списке действия такого ящика нет — показываем словами, а не идентификатором.
    expect(await screen.findByText(/Выбранный ящик больше не существует/)).not.toBeNull();
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Кому направить" }));
    fireEvent.click(await screen.findByText("Мария Петрова"));
    fireEvent.click(await screen.findByRole("button", { name: "Направить" }));

    // Заведомо провальную попытку не делаем: сервер такой ящик не разрешит (D-T55).
    await waitFor(() =>
      expect((document.body.textContent ?? "").match(/Выбранный ящик для СЭД больше не существует/)).not.toBeNull()
    );
    expect(resolutionApi.forward).not.toHaveBeenCalled();
    expect((document.body.textContent ?? "").match(/acc-gone/)).toBeNull();
  });

  it("403 account_not_allowed в действии показывается понятным текстом", async () => {
    const err = new Error("403 Forbidden") as Error & { code?: string };
    err.code = "account_not_allowed";
    (resolutionApi.forward as jest.Mock).mockRejectedValue(err);
    render(<DocumentCard documentId="doc-1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Направить руководителю" }));
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Кому направить" }));
    fireEvent.click(await screen.findByText("Мария Петрова"));
    fireEvent.click(await screen.findByRole("button", { name: "Направить" }));

    await waitFor(() =>
      expect((document.body.textContent ?? "").match(/С этого ящика отправлять нельзя/)).not.toBeNull()
    );
    // Сырую серверную формулировку не показываем.
    expect((document.body.textContent ?? "").match(/403 Forbidden/)).toBeNull();
  });

  it("без доступного ящика письмо не уходит — показываем причину", async () => {
    (resolutionApi.myEdmsMail as jest.Mock).mockResolvedValue({
      accountId: null,
      account: null,
      allowed: [],
      defaultAccountId: null
    } as EdmsMailSettings);
    render(<DocumentCard documentId="doc-1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Направить руководителю" }));
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Кому направить" }));
    fireEvent.click(await screen.findByText("Мария Петрова"));
    fireEvent.click(await screen.findByRole("button", { name: "Направить" }));

    await waitFor(() => expect((document.body.textContent ?? "").match(/Нет подходящих ящиков/)).not.toBeNull());
    expect(resolutionApi.forward).not.toHaveBeenCalled();
  });

});
