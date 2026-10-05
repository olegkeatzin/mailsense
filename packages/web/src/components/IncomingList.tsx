import { useCallback, useEffect, useState } from "react";
import { Button, Card, Empty, Space, Spin, Tag, Tooltip, message } from "antd";
import { CheckCircleOutlined, FileAddOutlined, ReloadOutlined, RollbackOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import { useStore } from "../store";
import type { IncomingItem } from "../types";

/**
 * «Входящие на регистрацию» — рабочее место аппарата.
 *
 * Это не обычная почта: здесь только письма, которые ещё не стали документами,
 * и единственное действие — зарегистрировать.
 */
export default function IncomingList() {
  const setSection = useStore((s) => s.setSection);
  const select = useStore((s) => s.select);
  const requestRegister = useStore((s) => s.requestRegister);
  const [items, setItems] = useState<IncomingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.journalIncoming(200);
      setItems(res.items);
    } catch (err) {
      message.error("Не удалось загрузить список: " + (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  return (
    <div style={{ padding: 16, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>
          Входящие на регистрацию
          {items.length > 0 && <span style={{ color: "#595959", fontWeight: 400 }}> · {items.length}</span>}
        </h3>
        <Button icon={<RollbackOutlined />} onClick={() => setSection("journal")}>
          В журнал
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadKey((k) => k + 1)}>
          Обновить</Button>
      </div>

      {loading && items.length === 0 ? (
        <Spin />
      ) : items.length === 0 ? (
        <Empty description="Все письма зарегистрированы — работы нет" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {items.map((e) => (
            <Card
              key={e.emailId}
              size="small"
              title={
                <Space>
                  <span>{e.from?.name || e.from?.address || "Неизвестный отправитель"}</span>
                  <span style={{ color: "#595959", fontWeight: 400, fontSize: 12 }}>
                    {e.date ? dayjs(e.date).format("DD.MM.YYYY HH:mm") : ""}
                  </span>
                </Space>
              }
              extra={
                <Button
                  type="primary"
                  size="small"
                  icon={<FileAddOutlined />}
                  // Открываем письмо, а не попап: поля регистрации берутся из письма, и оно
                // должно быть видно. Форма откроется сама — по «намерению» из стора.
                onClick={() => {
                  void select(e.emailId);
                  requestRegister(e.emailId);
                  setSection("mail");
                }}
                >
                  Зарегистрировать
                </Button>
              }
            >
              <div style={{ fontWeight: 500, marginBottom: 4 }}>{e.subject}</div>
              {e.summary && <div style={{ color: "#555", marginBottom: 6 }}>{e.summary}</div>}
              <Space size={4} wrap>
                {e.externalNumber && <Tag color="blue">№ {e.externalNumber}</Tag>}
                {e.sendDate && <Tag>от {dayjs(e.sendDate).format("DD.MM.YYYY")}</Tag>}
                {e.attachmentsCount > 0 && <Tag>{e.attachmentsCount} влож.</Tag>}
                {e.tags.slice(0, 4).map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
                {e.analysisStatus === "ready" ? (
                  <Tooltip title="Поля формы заполнены из письма и ИИ">
                    <Tag icon={<CheckCircleOutlined />} color="green">
                      готово к регистрации
                    </Tag>
                  </Tooltip>
                ) : (
                  <Tooltip title="Анализ ещё не выполнен: поля придётся заполнить вручную">
                    <Tag color="orange">без анализа</Tag>
                  </Tooltip>
                )}
              </Space>
            </Card>
          ))}
        </Space>
      )}

    </div>
  );
}