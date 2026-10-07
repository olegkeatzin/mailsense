import { useEffect, useState } from "react";
import { Space, Tag, Tooltip } from "antd";
import dayjs from "dayjs";
import { resolutionApi } from "../api";
import { useStore } from "../store";

/**
 * Подсказки-чипы для поля «срок» (А9 приложения к контракту).
 *
 * Список типовых сроков и даты считает СЕРВЕР (ядро addWorkingDays): своей арифметики
 * рабочих дней и праздников на клиенте нет — она разошлась бы с ядром. Клик подставляет
 * готовую дату в поле; поле остаётся редактируемым вручную.
 */
export function DeadlinePresets({ onPick }: { onPick: (dueDate: string) => void }) {
  const can = useStore((s) => s.can);
  const authStatus = useStore((s) => s.authStatus);
  const authUser = useStore((s) => s.authUser);
  /** Маршрут открыт тому, кто поручает или подписывает. */
  const allowed = !!authStatus?.docflowEnabled && !!authUser && (can("resolution.create") || can("resolution.approve"));
  const [items, setItems] = useState<Array<{ id: string; title: string; days: number; isWorkday: boolean; dueDate: string }>>([]);

  useEffect(() => {
    // Без права — ни запроса, ни чипов: иначе у подписанта сыпались 403 по каждой карточке (D4).
    if (!allowed) return;
    let alive = true;
    // Сегодняшняя дата — параметр запроса, а не расчёт срока: расчёт делает сервер.
    const from = dayjs().format("YYYY-MM-DD");
    resolutionApi
      .deadlinePresets(from)
      .then((r) => {
        if (alive) setItems(r.items ?? []);
      })
      // Подсказки — не обязательные: без них поле срока работает как раньше.
      .catch(() => setItems([]));
    return () => {
      alive = false;
    };
  }, [allowed]);

  if (!items.length) return null;

  return (
    <Space size={4} wrap style={{ marginTop: 4 }}>
      {items.map((p) => {
        const title = p.isWorkday ? p.title + " (" + p.days + " раб. дн.)" : p.title + " (" + p.days + " дн.)";
        return (
          <Tooltip key={p.id} title={"Срок: " + dayjs(p.dueDate).format("DD.MM.YYYY")}>
            <Tag
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              aria-label={"Подставить срок: " + p.title + ", " + dayjs(p.dueDate).format("DD.MM.YYYY")}
              onClick={() => onPick(p.dueDate)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPick(p.dueDate);
                }
              }}
            >
              {title}
            </Tag>
          </Tooltip>
        );
      })}
    </Space>
  );
}
