import { Button, Popconfirm } from "antd";
import { StopOutlined } from "@ant-design/icons";
import { useStore } from "../store";

/**
 * Остановка анализа.
 *
 * Кнопка стоит рядом с «Анализ», очищает очередь и назад не отыгрывается — случайное
 * нажатие стоило бы необработанных писем. Поэтому спрашиваем подтверждение и показываем
 * цену: сколько писем будет снято с очереди.
 */
export function StopAnalysisButton() {
  const queue = useStore((s) => s.analysisQueue);
  const stopAnalysis = useStore((s) => s.stopAnalysis);

  return (
    <Popconfirm
      title="Остановить анализ?"
      description={
        queue > 0
          ? "Будет остановлен анализ " + queue + " писем: они останутся необработанными."
          : "Очередь сейчас пуста — снимать нечего."
      }
      okText="Остановить"
      cancelText="Отмена"
      onConfirm={() => void stopAnalysis()}
    >
      <Button icon={<StopOutlined />}>Стоп</Button>
    </Popconfirm>
  );
}
