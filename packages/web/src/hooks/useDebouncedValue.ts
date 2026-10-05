import { useEffect, useState } from "react";

/**
 * Значение, «устоявшееся» за `delay` мс: пока пользователь печатает, оно не меняется.
 *
 * Так поиск в журнале и аудите уходит на сервер один раз, а не на каждую букву.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}
