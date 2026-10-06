import { api } from "../api";
import { useStore } from "../store";
import type { Email, EmailView } from "../types";

jest.mock("../api", () => ({
  api: {
    emails: jest.fn(),
    email: jest.fn(),
    threads: jest.fn(),
    accounts: jest.fn(),
    aiConfig: jest.fn(),
    bulkAnalyze: jest.fn(),
    bulkFolder: jest.fn(),
    bulkDelete: jest.fn(),
    fetchAccount: jest.fn(),
    importEmails: jest.fn(),
    analyze: jest.fn()
  }
}));

const mockEmails = api.emails as unknown as jest.Mock;
const mockEmail = api.email as unknown as jest.Mock;
const mockThreads = api.threads as unknown as jest.Mock;
const mockBulkDelete = api.bulkDelete as unknown as jest.Mock;
const mockBulkFolder = api.bulkFolder as unknown as jest.Mock;
const mockBulkAnalyze = api.bulkAnalyze as unknown as jest.Mock;
const mockFetchAccount = api.fetchAccount as unknown as jest.Mock;
const mockImportEmails = api.importEmails as unknown as jest.Mock;
const mockAnalyze = api.analyze as unknown as jest.Mock;

function mail(id: string): Email {
  return { id, subject: "Письмо " + id, bodyText: "", analysisStatus: "pending" } as unknown as Email;
}

function view(id: string): EmailView {
  return { email: mail(id) } as unknown as EmailView;
}

/** Промис, которым тест управляет вручную: нужно проверить, какой ответ «победит». */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const initial = useStore.getState();

beforeEach(() => {
  useStore.setState({
    ...initial,
    emails: [],
    threads: [],
    threadView: false,
    selectedId: null,
    emailView: null,
    selectedIds: [],
    folder: "INBOX",
    accountFilter: null,
    q: "",
    loading: false
  });
  mockEmails.mockResolvedValue([]);
  mockThreads.mockResolvedValue([]);
});

describe("выбор писем не переживает смену вида списка", () => {
  it("смена фильтра очищает выбор: иначе массовое действие уйдёт на невидимые письма", () => {
    useStore.setState({ emails: [mail("a"), mail("b")], selectedIds: ["a", "b"] });

    useStore.getState().setFilter({ q: "отчёт" });

    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it("смена папки очищает выбор", () => {
    useStore.setState({ emails: [mail("a")], selectedIds: ["a"] });

    useStore.getState().setFolder("PROCESSED");

    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it("смена аккаунта очищает выбор", () => {
    useStore.setState({ emails: [mail("a")], selectedIds: ["a"] });

    useStore.getState().setAccountFilter("acc-2");

    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it("сброс фильтров очищает выбор", () => {
    useStore.setState({ emails: [mail("a")], selectedIds: ["a"] });

    useStore.getState().resetFilters();

    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it("периодическое обновление списка снимает выбор с писем, которых больше не видно", async () => {
    useStore.setState({ emails: [mail("a"), mail("b")], selectedIds: ["a", "b"] });
    mockEmails.mockResolvedValue([mail("a")]);

    await useStore.getState().loadEmails();

    expect(useStore.getState().selectedIds).toEqual(["a"]);
  });
});

describe("массовые действия не трогают невидимые письма", () => {
  it("удаление идёт только по письмам текущего списка", async () => {
    useStore.setState({ emails: [mail("a")], selectedIds: ["a", "b"] });

    await useStore.getState().bulkDelete();

    expect(mockBulkDelete).toHaveBeenCalledWith(["a"]);
  });

  it("перемещение идёт только по письмам текущего списка", async () => {
    useStore.setState({ emails: [mail("a")], selectedIds: ["a", "b"] });

    await useStore.getState().bulkMove("SPAM");

    expect(mockBulkFolder).toHaveBeenCalledWith(["a"], "SPAM");
  });

  it("анализ идёт только по письмам текущего списка", async () => {
    useStore.setState({ emails: [mail("a")], selectedIds: ["a", "b"] });

    await useStore.getState().bulkAnalyze();

    expect(mockBulkAnalyze).toHaveBeenCalledWith(["a"]);
  });

  it("пустой выбор — запроса нет вовсе", async () => {
    useStore.setState({ emails: [mail("a")], selectedIds: [] });

    await useStore.getState().bulkDelete();

    expect(mockBulkDelete).not.toHaveBeenCalled();
  });
});

describe("лавина запросов при поиске", () => {
  it("набор текста в поиске даёт один запрос, а не по одному на букву", () => {
    jest.useFakeTimers();
    try {
      const { setFilter } = useStore.getState();

      setFilter({ q: "о" });
      setFilter({ q: "от" });
      setFilter({ q: "отч" });
      expect(mockEmails).not.toHaveBeenCalled();

      jest.advanceTimersByTime(300);

      expect(mockEmails).toHaveBeenCalledTimes(1);
      expect(mockEmails.mock.calls[0][0]).toMatchObject({ q: "отч" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("смена папки не ждёт паузы: это не поиск по буквам", () => {
    jest.useFakeTimers();
    try {
      useStore.getState().setFolder("PROCESSED");
      expect(mockEmails).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("гонки запросов", () => {
  it("устаревший ответ списка не перетирает свежий", async () => {
    const first = deferred<Email[]>();
    const second = deferred<Email[]>();
    mockEmails.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const p1 = useStore.getState().loadEmails();
    const p2 = useStore.getState().loadEmails();

    second.resolve([mail("fresh")]);
    await p2;
    first.resolve([mail("stale")]);
    await p1;

    expect(useStore.getState().emails.map((e) => e.id)).toEqual(["fresh"]);
  });

  it("устаревший запрос отменяется, а не просто игнорируется", async () => {
    const first = deferred<Email[]>();
    const second = deferred<Email[]>();
    mockEmails.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const p1 = useStore.getState().loadEmails();
    const signal = mockEmails.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    const p2 = useStore.getState().loadEmails();
    expect(signal.aborted).toBe(true);

    second.resolve([]);
    await p2;
    first.resolve([]);
    await p1;
  });

  it("устаревший ответ открытия письма не подменяет открытое", async () => {
    const slow = deferred<EmailView>();
    const fast = deferred<EmailView>();
    mockEmail.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    const p1 = useStore.getState().select("a");
    const p2 = useStore.getState().select("b");

    fast.resolve(view("b"));
    await p2;
    slow.resolve(view("a"));
    await p1;

    expect(useStore.getState().selectedId).toBe("b");
    expect((useStore.getState().emailView as unknown as { email: Email }).email.id).toBe("b");
  });
});

/**
 * Регрессия: опрос очереди останавливался в простое и возобновлялся только по
 * analysisEpoch. Но скан ящика и импорт ставят письма в анализ на сервере
 * (core: auto_analyze → enqueue), поэтому без этих действий плашка прогресса
 * и кнопка «Стоп» не появлялись вовсе.
 */
describe("индикатор анализа не слепнет к скану и импорту", () => {
  it("«Проверить почту» (скан ящика) возобновляет опрос очереди", async () => {
    const before = useStore.getState().analysisEpoch;
    mockFetchAccount.mockResolvedValue({ added: 3, skipped: 0 });

    await useStore.getState().fetchAccount("acc-1");

    expect(useStore.getState().analysisEpoch).toBeGreaterThan(before);
  });

  it("скан по нескольким ящикам возобновляет опрос очереди", async () => {
    const before = useStore.getState().analysisEpoch;
    mockFetchAccount.mockResolvedValue({ added: 0, skipped: 0 });

    await useStore.getState().fetchAccounts(["acc-1", "acc-2"]);

    expect(useStore.getState().analysisEpoch).toBeGreaterThan(before);
  });

  it("скан за период возобновляет опрос очереди", async () => {
    const before = useStore.getState().analysisEpoch;
    mockFetchAccount.mockResolvedValue({ added: 1, skipped: 0 });

    await useStore.getState().fetchAccountRange("acc-1", "2025-01-01", "2025-02-01");

    expect(useStore.getState().analysisEpoch).toBeGreaterThan(before);
  });

  it("импорт .eml возобновляет опрос очереди: импортированные письма уходят в анализ", async () => {
    const before = useStore.getState().analysisEpoch;
    mockImportEmails.mockResolvedValue({ added: 2, skipped: 1 });

    await useStore.getState().importEmails("acc-1", "INBOX", [{ filename: "a.eml", data: "x" }]);

    expect(useStore.getState().analysisEpoch).toBeGreaterThan(before);
  });

  it("ручной анализ по-прежнему поднимает счётчик", async () => {
    const before = useStore.getState().analysisEpoch;
    mockAnalyze.mockResolvedValue({ ok: true });

    await useStore.getState().analyze("mail-1");

    expect(useStore.getState().analysisEpoch).toBeGreaterThan(before);
  });
});
