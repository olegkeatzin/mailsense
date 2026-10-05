import { useEffect, useState } from "react";
import { Alert, Button, Space, Tag } from "antd";
import { resolutionApi } from "../api";

/**
 * Блок «Предложенные исполнители» (Р14).
 *
 * Подсказки СЕЙЧАС НЕТ — система ещё не накопила историю поручений. Блок существует, чтобы
 * место под неё было готово, и честно говорит об этом, а не притворяется работающим.
 *
 * Когда появится граф знаний, он начнёт заполнять `items` — форма интерфейса не изменится,
 * потому что контракт зафиксирован заранее.
 */
interface Suggestion {
  userId: string;
  fullName: string;
  /** Почему предложен: «похожие письма уходили в этот отдел», срок и т.п. */
  reason: string;
  confidence: number;
}

export function SuggestedAssignees(props: {
  documentId: string;
  /** Нажатие «Назначить» — добавляет человека к выбранным исполнителям. */
  onPick: (userId: string) => void;
}) {
  const { documentId, onPick } = props;
  const [state, setState] = useState<{
    ready: boolean;
    collected: number;
    needed: number;
    items: Suggestion[];
  } | null>(null);

  useEffect(() => {
    if (!documentId) return;
    resolutionApi
      .suggestAssignees(documentId)
      .then(setState)
      .catch(() => setState(null));
  }, [documentId]);

  // Сервер недоступен — молчим: это вспомогательный блок, а не обязательное поле.
  if (!state) return null;

  if (!state.ready) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Предложенных исполнителей пока нет"
        description={
          <span style={{ fontSize: 12 }}>
            Когда накопится история поручений, система начнёт подсказывать, кому такое письмо обычно
            попадает на исполнение — с обоснованием. Накоплено резолюций: <b>{state.collected}</b>
            {state.needed ? " (подсказка станет осмысленной примерно после " + state.needed + ")" : ""}.
            Пока исполнителя выбирает человек.
          </span>
        }
      />
    );
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ marginBottom: 4 }}>
        <b>Предложенные исполнители</b>{" "}
        <span style={{ color: "#595959", fontSize: 12 }}>по похожим письмам</span>
      </div>
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        {state.items.map((s) => (
          <Space key={s.userId} wrap>
            <Button size="small" onClick={() => onPick(s.userId)}>Назначить</Button>
            <b>{s.fullName}</b>
            <Tag>{Math.round(s.confidence * 100)}%</Tag>
            <span style={{ color: "#666", fontSize: 12 }}>{s.reason}</span>
          </Space>
        ))}
      </Space>
    </div>
  );
}