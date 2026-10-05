import { useCallback, useRef, useState } from "react";

/**
 * Тело письма, пришедшее в HTML, — в изолированной рамке.
 *
 * ⚠️ **Никогда не заменяйте это на `dangerouslySetInnerHTML`.** HTML приходит из письма,
 * а письмо может прислать кто угодно: сценарий в нём исполнился бы в нашем origin, а запросы
 * идут с сессионной cookie (`credentials: "include"`) — то есть чужое письмо получило бы
 * доступ ко всей почте и к API документооборота от имени вошедшего.
 *
 * ⚠️ **`allow-scripts` в `sandbox` добавлять нельзя ни при каких условиях** — именно он
 * снимает защиту. `allow-same-origin` оставлен намеренно и сам по себе безопасен: без права
 * на сценарии содержимое не может ни выполнить код, ни дотянуться до нашего DOM. Он нужен,
 * чтобы работали картинки внутри письма (они требуют cookie) и чтобы измерить высоту.
 *
 * Цена защиты: письмо рендерится в своей рамке, поэтому стили приложения внутрь не попадают.
 */
export function SafeLetterHtml({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);

  /** Подгоняем рамку под содержимое, но не даём длинному письму занять весь экран. */
  const fit = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const h = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
    if (h > 0) setHeight(Math.min(Math.max(h + 16, 120), 720));
  }, []);

  return (
    <iframe
      ref={ref}
      title="Тело письма"
      // Пустая строка здесь — не опечатка: разрешений не выдаём, кроме same-origin.
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={fit}
      style={{
        width: "100%",
        height,
        border: "1px solid #f0f0f0",
        borderRadius: 4,
        background: "#fff",
        display: "block"
      }}
    />
  );
}