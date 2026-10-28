/** @jest-environment jsdom */
import { configure, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installDomEnvironment } from "./dom";

const list = () => jest.fn().mockResolvedValue([]);
const obj = (v: Record<string, unknown>) => jest.fn().mockResolvedValue(v);

const DOC_AUDIT_ENTRY = {
  id: "a-2",
  userId: "u-1",
  userName: "Иванов И.И.",
  action: "journal.edit",
  // Объекта нет в карте подписей: интерфейс обязан сказать «Другой объект».
  entityType: "weird_entity",
  entityId: "doc-1",
  oldValue: JSON.stringify({ status: "new", docNumber: "17", isActive: true }),
  newValue: JSON.stringify({ status: "on_resolution", docNumber: "18", isActive: false }),
  createdAt: "2026-10-07T08:00:00.000Z"
};

const AUDIT_ENTRY = {
  id: "a-1",
  userId: "u-1",
  userName: "Иванов И.И.",
  // Действия нет в карте подписей: интерфейс обязан сказать «Прочее действие», а не ключ.
  action: "resolution.obscure_action",
  entityType: "resolution",
  entityId: "res-1",
  oldValue: null,
  // Значения-идентификаторы: в разметку они попадать не должны даже неразрешёнными.
  newValue: JSON.stringify({
    status: "new",
    dueSoonDays: 3,
    isActive: true,
    accountId: "6f7367f6-0fa6-4e93-b5ef-d359e59c5de6"
  }),
  createdAt: "2026-10-07T09:00:00.000Z"
};

jest.mock("../api", () => ({
  api: {
    accounts: jest.fn().mockResolvedValue([{ id: "acc-1", username: "post" }]),
    settings: jest.fn().mockResolvedValue({ auto_fetch: "true" }),
    saveSetting: jest.fn().mockResolvedValue({}),
    journal: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    journalStatusCounts: jest.fn().mockResolvedValue({}),
    audit: jest.fn().mockResolvedValue({ entries: [AUDIT_ENTRY, DOC_AUDIT_ENTRY], total: 2 }),
    document: jest.fn().mockResolvedValue({
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
      // Связанное письмо: идентификатор внутренний — в разметку попадать не должен.
      emails: [{ emailId: "3f1c2b8e-1111-4222-8333-444455556666", role: "source", linkedAt: "2026-10-06T10:00:00.000Z" }],
      createdByName: "Иванов И.И.",
      emailsCount: 1
    }),
    aiConfig: obj({ baseUrl: "", apiKey: "", model: "", multimodal: false, timeoutMs: 1000 }),
    promptConfig: obj({ system: "", userTemplate: "" }),
    templates: list(),
    directoryStatus: obj({ loggedIn: false, login: null, settings: {}, contacts: 0 }),
    roles: list(),
    users: list(),
    numbering: obj({ rules: [], openPeriod: null, archivedPeriods: [], reopenablePeriods: [], blockedReason: null }),
    cases: list(),
    searchContacts: list(),
    serviceAccount: obj({ configured: false, account: null, problem: null, problemCode: "not_configured" }),
    setServiceAccount: jest.fn().mockResolvedValue({ ok: true, accountId: null }),
    testAccount: obj({ ok: true }),
    testSmtp: obj({ ok: true }),
    updateAccount: obj({}),
    createAccount: obj({}),
    deleteAccount: obj({ ok: true }),
    fetchAccount: obj({ added: 0, skipped: 0 }),
    updateUser: obj({}),
    setUserRoles: obj({}),
    saveDocflowSettings: obj({}),
    saveNumbering: obj({}),
    saveCase: obj({}),
    saveAiConfig: obj({}),
    updateTemplate: obj({}),
    deleteTemplate: obj({ ok: true }),
    saveLdapSettings: obj({}),
    directoryLogin: obj({}),
    directoryLogout: obj({}),
    directoryRefresh: obj({ synced: 0 }),
    journalIncoming: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    journalExportUrl: () => "",
    auditExportUrl: () => "",
    journalArchiveUrl: () => ""
  },
  resolutionApi: {
    myTasks: list(),
    markReceived: obj({ ok: true }),
    report: obj({}),
    board: list(),
    forApproval: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    forConfirmation: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    executorCandidates: list(),
    deadlinePresets: jest.fn().mockResolvedValue({ items: [] }),
    byDocument: list(),
    replyContext: list(),
    suggestAssignees: obj({ ready: false, collected: 12, needed: 300, items: [] }),
    // Разрешение идентификаторов аудита: поручения добираются поштучно.
    get: obj({ documentNumber: "вх38" }),
    suggestFields: obj({ text: "", source: "none" }),
    confirmReport: obj({}),
    markApproval: obj({}),
    icsUrl: (id: string) => "/api/docflow/resolutions/" + id + "/ics"
  },
  notificationApi: {
    list: jest.fn().mockResolvedValue({ items: [], unread: 0, total: 0, enabled: true }),
    count: jest.fn().mockResolvedValue({ unread: 0, enabled: true }),
    markRead: obj({ ok: true, unread: 0 }),
    readAll: obj({ updated: 0, unread: 0 }),
    settings: obj({ enabled: true, dueSoonDays: 3, workdayDeadlines: true, holidays: [], variables: [], templates: [] }),
    saveSettings: obj({ ok: true }),
    sortRules: jest.fn().mockResolvedValue({ items: [] }),
    createSortRule: obj({ rule: {} }),
    updateSortRule: obj({ rule: {} }),
    deleteSortRule: obj({ ok: true }),
    previewSortRule: obj({ matched: 0, total: 0, samples: [] })
  }
}));

import { useStore } from "../store";
import type { AuthStatus, AuthUser } from "../types";
import { MyTasks } from "../components/MyTasks";
import { ResolutionBoard } from "../components/ResolutionBoard";
import IncomingList from "../components/IncomingList";
import { ApprovalList } from "../components/ApprovalList";
import Journal from "../components/Journal";
import DocumentCard from "../components/DocumentCard";
import SettingsModal from "../components/SettingsModal";
import { NotificationsBell } from "../components/NotificationsBell";
import { SuggestedAssignees } from "../components/SuggestedAssignees";

configure({ asyncUtilTimeout: 8000 });

const initial = useStore.getState();

// Регулярки собраны через new RegExp, чтобы их было видно в тесте как есть.
const RE_SLASH = new RegExp("(^|[^:])//");
const RE_BLOCK = new RegExp("/\\*|\\*/");
const RE_TODO = new RegExp("\\b(TODO|FIXME|HACK|XXX)\\b");
const RE_CONSOLE = new RegExp("console\\.");
const RE_FIELD = new RegExp(
  "\\b(emailId|documentId|resolutionId|userId|entityId|accountId|messageId|linkedAt|docNumber|regNumber|entityType|sortOrder|isActive|dueSoonDays|fullName|oldValue|newValue|problemCode)\\b"
);
const RE_ACTION_KEY = new RegExp("\\b(journal|resolution|user|sorting|notifications|directory|auth|docflow|settings)\\.[a-z_]{2,}\\b");
const RE_SNAKE = new RegExp("\\b[a-z]{2,}_[a-z_]{2,}\\b");
const RE_STREAM = new RegExp("\\b(incoming|outgoing)\\b");
const RE_JSON_START = new RegExp("\\{\\s*\"");
const RE_UUID = new RegExp("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "i");
const RE_SERIALIZED = new RegExp("\\[object Object\\]");
const RE_UNDEFINED = new RegExp("\\b(undefined|NaN)\\b");

const FORBIDDEN: Array<[string, RegExp]> = [
  ["комментарий «//»", RE_SLASH],
  ["блочный комментарий", RE_BLOCK],
  ["метка задачи разработчика", RE_TODO],
  ["вызов console", RE_CONSOLE],
  ["имя внутреннего поля", RE_FIELD],
  ["ключ действия/настройки", RE_ACTION_KEY],
  ["snake_case-идентификатор", RE_SNAKE],
  ["сырой поток (incoming/outgoing)", RE_STREAM],
  ["JSON в разметке", RE_JSON_START],
  ["сырой идентификатор (UUID)", RE_UUID],
  ["мусор сериализации", RE_SERIALIZED],
  ["неопределённое значение", RE_UNDEFINED]
];

function expectClean(_container: HTMLElement, where: string) {
  // Drawer и Modal рисуются в портале на document.body, поэтому смотрим весь документ.
  const text = document.body.textContent ?? "";
  const problems: string[] = [];
  for (const [name, re] of FORBIDDEN) {
    const m = re.exec(text);
    if (m) {
      const at = m.index ?? 0;
      problems.push(name + " → «" + text.slice(Math.max(0, at - 40), at + 60).replace(/\s+/g, " ").trim() + "»");
    }
  }
  // where печатается в диффе: jest-expect принимает только один аргумент.
  expect({ where, problems }).toEqual({ where, problems: [] });
}

const ALL_PERMISSIONS = [
  "journal.view",
  "journal.register",
  "journal.edit",
  "resolution.create",
  "resolution.approve",
  "resolution.dispatch",
  "task.view",
  "task.report",
  "settings.manage",
  "users.manage",
  "audit.view",
  "notifications.view"
];

function asAdmin() {
  useStore.setState({
    ...initial,
    settingsOpen: false,
    docflowUnavailable: false,
    authStatus: { docflowEnabled: true } as unknown as AuthStatus,
    authUser: { permissions: ALL_PERMISSIONS, roles: ["admin"] } as unknown as AuthUser,
    accounts: []
  });
}

describe("в интерфейсе нет служебного текста разработчика", () => {
  beforeAll(installDomEnvironment);
  afterEach(() => {
    cleanup();
    useStore.setState({ settingsOpen: false });
  });
  beforeEach(asAdmin);

  it("«Мои задачи»", async () => {
    const { container } = render(<MyTasks />);
    await screen.findByText("Мои задачи");
    expectClean(container, "Мои задачи");
  });

  it("«Резолюции» (канбан)", async () => {
    const { container } = render(<ResolutionBoard />);
    await screen.findByText("Резолюции");
    expectClean(container, "Канбан резолюций");
  });

  it("«Входящие на регистрацию»", async () => {
    const { container } = render(<IncomingList />);
    await screen.findByText(/Входящие на регистрацию/);
    expectClean(container, "Входящие на регистрацию");
  });

  it("«На утверждении» (подписант)", async () => {
    const { container } = render(<ApprovalList />);
    await waitFor(() => expect(container.textContent).toContain("На утверждении"));
    expectClean(container, "На утверждении");
  });

  it("«Журнал регистрации»", async () => {
    const { container } = render(<Journal />);
    await waitFor(() => expect(container.textContent).toContain("Журнал"));
    expectClean(container, "Журнал регистрации");
  });

  it("карточка документа (что изменилось, история)", async () => {
    const { container } = render(<DocumentCard documentId="doc-1" onClose={() => {}} />);
    await screen.findAllByText(/вх38/);
    expectClean(container, "Карточка документа");
  });

  it("панель уведомлений", async () => {
    const { container } = render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole("button", { name: /Уведомления/ }));
    await screen.findByRole("dialog", { name: "Центр уведомлений" });
    expectClean(container, "Центр уведомлений");
  });

  /**
   * ⚠️ Разделы проверяем ОТДЕЛЬНЫМИ тестами: раньше восемь разделов шли в одном тесте,
   * и он перестал укладываться в таймаут jsdom (окно открывалось один раз, а разделы
   * копились в дереве). Так каждый тест монтирует окно заново, быстро укладывается
   * в свой таймаут и показывает, в КАКОМ разделе протёк служебный текст.
   */
  it.each([
    "Общие",
    "Служебные ящики",
    "Правила сортировки",
    "Уведомления",
    "Аудит",
    "Пользователи и роли",
    "Документооборот",
    "Нумерация"
  ])("настройки: раздел «%s» без служебного текста", async (tab) => {
    useStore.setState({ settingsOpen: true });
    const { container } = render(<SettingsModal />);

    fireEvent.click(await screen.findByRole("menuitem", { name: tab }));
    await waitFor(() => expect(document.body.textContent ?? "").not.toBe(""));
    expectClean(container, "Настройки → " + tab);
  }, 120000);
});

describe("задел под подсказку исполнителей подписан честно (Р14)", () => {
  beforeAll(installDomEnvironment);
  afterEach(cleanup);
  beforeEach(asAdmin);

  it("сказано «не работает», без обещаний и внутренних порогов", async () => {
    const { container } = render(<SuggestedAssignees documentId="doc-1" onPick={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("Накоплено резолюций"));

    const text = container.textContent ?? "";
    expect(text).toContain("не работает");
    expect(text).not.toMatch(/начн[её]т|скоро|после 300|в разработке|beta/i);
    expect(text).not.toContain("300");
  });
});
