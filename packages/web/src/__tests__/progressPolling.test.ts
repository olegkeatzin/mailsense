import {
  BUSY_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  createProgressPoller,
  isBusy
} from "../utils/progressPolling";

const idle = { stage: "idle", queueLength: 0, done: 0, total: 0 };
const busy = { stage: "analysis", queueLength: 2, done: 1, total: 3 };

/** Даёт разрешиться микрозадачам после сработавшего таймера. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("опрос очереди анализа", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("в простое НЕ опрашивает раз в секунду — иначе жжём сеть и батарею", async () => {
    const fetchProgress = jest.fn().mockResolvedValue(idle);
    const poller = createProgressPoller({ fetchProgress, onProgress: jest.fn() });

    poller.start();
    await flush();
    expect(fetchProgress).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10_000);
    await flush();
    expect(fetchProgress).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it("в простое всё же подаёт редкий «пульс»: анализ может запустить планировщик", async () => {
    const fetchProgress = jest.fn().mockResolvedValue(idle);
    const poller = createProgressPoller({ fetchProgress, onProgress: jest.fn() });

    poller.start();
    await flush();
    jest.advanceTimersByTime(IDLE_INTERVAL_MS);
    await flush();

    expect(fetchProgress).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("пока идёт анализ — опрашивает раз в секунду", async () => {
    const fetchProgress = jest.fn().mockResolvedValue(busy);
    const poller = createProgressPoller({ fetchProgress, onProgress: jest.fn() });

    poller.start();
    await flush();
    // Шагаем по секунде с «прокруткой» микрозадач: иначе следующая проверка
    // не успевает запланироваться внутри одного advanceTimersByTime.
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(BUSY_INTERVAL_MS);
      await flush();
    }

    expect(fetchProgress.mock.calls.length).toBeGreaterThanOrEqual(4);
    poller.stop();
  });

  it("«разбуди» после скана или импорта проверяет очередь немедленно, не дожидаясь пульса", async () => {
    const fetchProgress = jest.fn().mockResolvedValue(idle);
    const poller = createProgressPoller({ fetchProgress, onProgress: jest.fn() });

    poller.start();
    await flush();
    expect(fetchProgress).toHaveBeenCalledTimes(1);

    // Скан/импорт: сервер мог поставить письма в анализ прямо сейчас.
    poller.poke();
    await flush();
    expect(fetchProgress).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("после «разбуди» плашка появляется, как только сервер ответил «в работе»", async () => {
    const onProgress = jest.fn();
    const fetchProgress = jest.fn().mockResolvedValueOnce(idle).mockResolvedValue(busy);
    const poller = createProgressPoller({ fetchProgress, onProgress });

    poller.start();
    await flush();
    expect(onProgress).toHaveBeenLastCalledWith(idle);

    poller.poke();
    await flush();
    expect(onProgress).toHaveBeenLastCalledWith(busy);
    expect(isBusy(busy)).toBe(true);

    poller.stop();
  });

  it("свёрнутое окно не опрашивается", async () => {
    const fetchProgress = jest.fn().mockResolvedValue(idle);
    const poller = createProgressPoller({
      fetchProgress,
      onProgress: jest.fn(),
      isHidden: () => true
    });

    poller.start();
    await flush();
    expect(fetchProgress).not.toHaveBeenCalled();

    poller.stop();
  });

  it("после stop() запросов больше нет", async () => {
    const fetchProgress = jest.fn().mockResolvedValue(busy);
    const poller = createProgressPoller({ fetchProgress, onProgress: jest.fn() });

    poller.start();
    await flush();
    const before = fetchProgress.mock.calls.length;
    poller.stop();
    jest.advanceTimersByTime(BUSY_INTERVAL_MS * 5);
    await flush();

    expect(fetchProgress.mock.calls.length).toBe(before);
  });

  it("ошибка сервера не глушит опрос навсегда", async () => {
    const fetchProgress = jest.fn().mockRejectedValueOnce(new Error("502"));
    const poller = createProgressPoller({ fetchProgress, onProgress: jest.fn() });

    poller.start();
    await flush();
    expect(fetchProgress).toHaveBeenCalledTimes(1);

    fetchProgress.mockResolvedValue(busy);
    jest.advanceTimersByTime(5000);
    await flush();

    expect(fetchProgress).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});
