/**
 * Отложенный вызов: срабатывает один раз после паузы в `delay` мс.
 *
 * Нужен для поиска: без него запрос уходит на сервер на каждое нажатие клавиши,
 * десять букв в строке поиска — десять запросов, которые ещё и обгоняют друг друга.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Отменить отложенный вызов (например, при размонтировании). */
  cancel: () => void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, delay = 300): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}
