/**
 * Опрос очереди анализа.
 *
 * Раньше прогресс опрашивался раз в секунду всегда — это жгло сеть и батарею.
 * Теперь частота зависит от состояния: пока идёт работа — раз в секунду, в простое —
 * редкий «пульс» (анализ может запустить фоновый планировщик или другой клиент, и
 * тогда плашка обязана появиться). Действия пользователя — скан, импорт, ручной
 * анализ — будят опрос немедленно через poke(), не дожидаясь «пульса».
 *
 * Логика вынесена из компонента: её видно в тестах, а не только в браузере.
 */
export interface AnalysisProgress {
  stage: string;
  queueLength: number;
}

/** Идёт работа: плашка нужна, опрашиваем часто. */
export const BUSY_INTERVAL_MS = 1000;
/** Простой: редкий «пульс», а не вечный опрос раз в секунду. */
export const IDLE_INTERVAL_MS = 20_000;
/** Свёрнутое окно: прогресс всё равно никто не видит. */
export const HIDDEN_INTERVAL_MS = 30_000;
/** Сервер недоступен: не долбим его каждую секунду, но и не замолкаем навсегда. */
export const ERROR_INTERVAL_MS = 5_000;

export function isBusy(p: AnalysisProgress): boolean {
  return p.queueLength > 0 || p.stage !== "idle";
}

export interface ProgressPollerOptions<T extends AnalysisProgress> {
  fetchProgress: () => Promise<T>;
  onProgress: (p: T) => void;
  /** Скрыто ли окно (в браузере — document.hidden). */
  isHidden?: () => boolean;
  /** Таймеры подменяются в тестах. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ProgressPoller {
  /** Начать опрос: первый запрос уходит сразу. */
  start: () => void;
  /** Проверить очередь немедленно (после скана, импорта, ручного анализа). */
  poke: () => void;
  stop: () => void;
}

export function createProgressPoller<T extends AnalysisProgress>(
  options: ProgressPollerOptions<T>
): ProgressPoller {
  const { fetchProgress, onProgress, isHidden = () => false } = options;
  const setT = options.setTimeoutFn ?? setTimeout;
  const clearT = options.clearTimeoutFn ?? clearTimeout;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let alive = false;
  /** Запрос уже в полёте: повторный poke не должен слать второй. */
  let inFlight = false;

  const cancel = () => {
    if (timer) {
      clearT(timer);
      timer = null;
    }
  };

  const schedule = (ms: number) => {
    if (!alive) return;
    cancel();
    timer = setT(() => void tick(), ms);
  };

  const tick = async (): Promise<void> => {
    if (!alive || inFlight) return;
    if (isHidden()) {
      schedule(HIDDEN_INTERVAL_MS);
      return;
    }
    inFlight = true;
    try {
      const p = await fetchProgress();
      if (!alive) return;
      onProgress(p);
      schedule(isBusy(p) ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
    } catch {
      if (alive) schedule(ERROR_INTERVAL_MS);
    } finally {
      inFlight = false;
    }
  };

  return {
    start: () => {
      alive = true;
      void tick();
    },
    poke: () => {
      if (!alive) return;
      cancel();
      void tick();
    },
    stop: () => {
      alive = false;
      cancel();
    }
  };
}
