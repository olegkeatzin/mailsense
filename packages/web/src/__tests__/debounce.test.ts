import { debounce } from "../utils/debounce";

describe("debounce", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("серия вызовов превращается в один — поиск не бьёт по серверу на каждую букву", () => {
    const fn = jest.fn();
    const d = debounce(fn, 300);

    d("о");
    d("от");
    d("отч");
    expect(fn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("отч");
  });

  it("после паузы следующий вызов снова срабатывает", () => {
    const fn = jest.fn();
    const d = debounce(fn, 300);

    d("первый");
    jest.advanceTimersByTime(300);
    d("второй");
    jest.advanceTimersByTime(300);

    expect(fn.mock.calls).toEqual([["первый"], ["второй"]]);
  });

  it("cancel отменяет отложенный вызов", () => {
    const fn = jest.fn();
    const d = debounce(fn, 300);

    d("ничего");
    d.cancel();
    jest.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });

  it("пауза меньше задержки не пропускает вызов", () => {
    const fn = jest.fn();
    const d = debounce(fn, 300);

    d("a");
    jest.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
