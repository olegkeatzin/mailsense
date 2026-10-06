/**
 * Заглушки браузерных API, которых нет в jsdom.
 *
 * Нужны компонентным тестам: antd и react-window обращаются к ResizeObserver,
 * matchMedia и к высотам элементов, а jsdom их не реализует (высоты всегда 0,
 * из-за чего виртуальный список не отрисовал бы ни одной строки).
 */
export function installDomEnvironment(): void {
  const g = globalThis as unknown as Record<string, unknown>;

  if (typeof g.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    g.ResizeObserver = ResizeObserverStub;
  }

  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
  }

  if (typeof Element !== "undefined") {
    // react-window меряет контейнер: без ненулевой высоты строки не рендерятся.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 600
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 800
    });
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  }
}
