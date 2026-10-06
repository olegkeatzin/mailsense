/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { SafeLetterHtml } from "../components/SafeLetterHtml";
import { installDomEnvironment } from "./dom";

beforeAll(installDomEnvironment);

/**
 * Тело письма — чужой HTML, поэтому оно обязано жить в песочнице.
 * Тесты держат две вещи: письмо не попадает в наш DOM и sandbox не разрешает сценарии.
 */
describe("SafeLetterHtml: письмо рендерится в изолированной рамке", () => {
  const payload = '<p>Привет</p><script>window.__xss = true</script>';

  it("рендерит письмо в iframe, а не в разметку приложения", () => {
    const { container } = render(<SafeLetterHtml html={payload} />);

    const frame = screen.getByTitle("Тело письма");
    expect(frame.tagName).toBe("IFRAME");
    // Сценарий из письма не стал узлом нашего документа…
    expect(container.querySelector("script")).toBeNull();
    // …и текст письма не попал в наш DOM (он живёт внутри рамки).
    expect(container.textContent).not.toContain("Привет");
  });

  it("HTML письма уходит в srcDoc, а не в innerHTML страницы", () => {
    render(<SafeLetterHtml html={payload} />);

    expect(screen.getByTitle("Тело письма").getAttribute("srcdoc")).toBe(payload);
  });

  it("sandbox НЕ разрешает сценарии: с allow-scripts письмо дотянется до сессии", () => {
    render(<SafeLetterHtml html={payload} />);

    const sandbox = screen.getByTitle("Тело письма").getAttribute("sandbox") ?? "";
    expect(sandbox).not.toBe("");
    expect(sandbox).toContain("allow-same-origin");
    // Именно этой строки быть не должно — тест обязан покраснеть, если её добавят.
    expect(sandbox.split(/\s+/)).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-popups");
    expect(sandbox).not.toContain("allow-forms");
  });
});
