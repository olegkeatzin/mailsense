import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Checkbox, Empty, Segmented, Space, Spin, Tag, Tooltip } from "antd";
import { CheckCircleOutlined, FileAddOutlined, FlagOutlined, ReloadOutlined, RollbackOutlined, TagOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import { useStore } from "../store";
import { priorityLabel } from "../utils";
import type { IncomingItem } from "../types";
import { READY_STYLE, SOON_STYLE } from "./notifications/colors";
import { ServiceAccountHint } from "./ServiceAccountHint";
import { humanError } from "../utils/humanError";

/**
 * «Входящие на регистрацию» — рабочее место аппарата.
 *
 * Это не обычная почта: здесь только письма, которые ещё не стали документами,
 * и единственное действие — зарегистрировать. Правило сортировки лишь помечает письмо
 * меткой и подсказкой и поднимает его в очереди: документ по-прежнему создаёт человек
 * (rules §6.1, контракт §0.2). Своих полей не придумываем — берём §6.
 */
export default function IncomingList() {
  const setSection = useStore((s) => s.setSection);
  const can = useStore((s) => s.can);
  const select = useStore((s) => s.select);
  const requestRegister = useStore((s) => s.requestRegister);
  const [items, setItems] = useState<IncomingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** Только письма, совпавшие с активными правилами. */
  const [rulesOnly, setRulesOnly] = useState(false);
  /** Порядок по умолчанию — «По дате»: аппарат привык к нему, молча менять нельзя. */
  const [sort, setSort] = useState<"date" | "rules">("date");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.journalIncoming({ limit: 200, rulesOnly, sort });
      setItems(res.items);
      setTotal(res.total ?? res.items.length);
    } catch (err) {
      // Ошибку показываем в разделе, а не только всплывашкой: иначе список молча пустеет.
      setError(humanError(err));
    } finally {
      setLoading(false);
    }
  }, [rulesOnly, sort]);

  useEffect(() => {
    // Права нет — очередь не запрашивается: иначе 403 в консоли у чужой роли.
    if (!can("journal.register")) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, reloadKey]);

  return (
    <div style={{ padding: 16, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, flex: "1 1 240px" }}>
          Входящие на регистрацию
          {items.length > 0 && <span style={{ color: "#595959", fontWeight: 400 }}> · {items.length}</span>}
        </h3>
        <Checkbox checked={rulesOnly} onChange={(e) => setRulesOnly(e.target.checked)}>
          Только по правилам
        </Checkbox>
        <Segmented
          aria-label="Порядок писем"
          value={sort}
          onChange={(v) => setSort(v === "rules" ? "rules" : "date")}
          options={[
            { label: "По дате", value: "date" },
            { label: "По правилам", value: "rules" }
          ]}
        />
        <Button icon={<RollbackOutlined />} onClick={() => setSection("journal")}>
          В журнал
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => setReloadKey((k) => k + 1)}>
          Обновить
        </Button>
      </div>

      {/* Куда входить аппарату: служебный ящик выбирает администратор, здесь только подсказка. */}
      <ServiceAccountHint />

      {/* Важное утверждение, а не мелочь: поэтому всегда видно, а не в Tooltip. */}
      <div style={{ color: "#595959", fontSize: 12, margin: "8px 0 12px" }}>
        Документ регистрирует человек: правило только помечает письмо меткой и подсказкой и поднимает его в
        очереди. Номер при этом не выдаётся.
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          message="Не удалось загрузить список"
          description={error}
          style={{ marginBottom: 12 }}
          action={
            <Button size="small" onClick={() => setReloadKey((k) => k + 1)}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {loading && items.length === 0 ? (
        <Spin />
      ) : items.length === 0 ? (
        rulesOnly ? (
          <Empty description="Под правила пока не подошло ни одно письмо">
            <Button type="primary" onClick={() => setRulesOnly(false)}>
              Показать все письма
            </Button>
          </Empty>
        ) : (
          <Empty description="Все письма зарегистрированы — работы нет" />
        )
      ) : (
        <div style={{ position: "relative" }}>
          {/* Смена фильтра не должна мигать пустым состоянием: список остаётся, сверху — индикатор. */}
          {loading ? (
            <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.6)", zIndex: 1, display: "flex", justifyContent: "center", paddingTop: 24 }}>
              <Spin />
            </div>
          ) : null}
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {items.map((e) => {
              const labels = e.sortLabels ?? [];
              const notes = e.sortNotes ?? [];
              return (
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
                        {/* Пресет green даёт 3.37:1 — норма AA не проходит, поэтому свой стиль. */}
                        <Tag icon={<CheckCircleOutlined />} style={READY_STYLE}>
                          готово к регистрации
                        </Tag>
                      </Tooltip>
                    ) : (
                      <Tooltip title="Анализ ещё не выполнен: поля придётся заполнить вручную">
                        <Tag style={SOON_STYLE}>без анализа</Tag>
                      </Tooltip>
                    )}
                    {labels.map((label) => (
                      <Tooltip key={label} title="Метка правила сортировки">
                        <Tag color="blue" icon={<TagOutlined />}>
                          {label}
                        </Tag>
                      </Tooltip>
                    ))}
                    {e.sortPriority !== null && e.sortPriority !== undefined ? (
                      <Tooltip title="Приоритет предложен правилом сортировки">
                        <Tag icon={<FlagOutlined />} style={SOON_STYLE}>
                          {"правило: " + priorityLabel(e.sortPriority)}
                        </Tag>
                      </Tooltip>
                    ) : null}
                  </Space>
                  {notes.length ? (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginTop: 8 }}
                      message="Подсказка правила"
                      description={notes.join(" ")}
                    />
                  ) : null}
                </Card>
              );
            })}
          </Space>
          {total > items.length ? (
            <div style={{ color: "#595959", fontSize: 12, marginTop: 12 }}>
              {"Показаны первые " + items.length + " из " + total + ". Уточните фильтр или обновите список."}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
