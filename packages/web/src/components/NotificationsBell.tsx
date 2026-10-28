import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Empty,
  List,
  Popover,
  Skeleton,
  Space,
  Tooltip,
  Typography,
  message
} from "antd";
import {
  BellOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useStore } from "../store";
import type { AppNotification, NotificationSeverity } from "../types";
import { NOTIFY_TEXTS, notificationTime } from "./notifications/texts";
import { BADGE_STYLE } from "./notifications/colors";
import { humanError } from "../utils/humanError";

/**
 * Центр уведомлений (этап 5, §2 stage5-ux.md).
 *
 * Уведомления живут ТОЛЬКО внутри приложения: писем-напоминаний не отправляем (Р11).
 * Опрос счётчика — раз в 60 с и только при праве notifications.view: без права /count
 * отвечает 403, и это уже проходило (rules §1.3 — консоль обязана быть пуста у каждой роли).
 */

const SEVERITY_ICON: Record<NotificationSeverity, ReactNode> = {
  info: <InfoCircleOutlined />,
  warning: <WarningOutlined />,
  danger: <ExclamationCircleOutlined />
};

const SEVERITY_COLOR: Record<NotificationSeverity, string> = {
  info: "#0958d9",
  warning: "#ad4e00",
  danger: "#cf1322"
};

function ItemBody({ n, time }: { n: AppNotification; time: { label: string; exact: string } }) {
  return (
    <Space size={6} align="start" style={{ width: "100%" }}>
      <span aria-hidden="true" style={{ color: SEVERITY_COLOR[n.severity], lineHeight: "20px" }}>
        {SEVERITY_ICON[n.severity]}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontWeight: n.readAt ? 400 : 600,
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }}
        >
          {n.title}
        </span>
        {n.body ? (
          <span
            style={{
              color: "#595959",
              fontSize: 13,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              overflowWrap: "anywhere"
            }}
          >
            {n.body}
          </span>
        ) : null}
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#767676" }}>
          {!n.readAt ? (
            <>
              <span aria-hidden="true" style={{ color: "#cf1322" }}>
                •
              </span>
              <span className="visually-hidden">{NOTIFY_TEXTS.unreadSr}</span>
            </>
          ) : null}
          <Tooltip title={time.exact}>
            <span>{time.label}</span>
          </Tooltip>
        </span>
      </span>
    </Space>
  );
}

/**
 * Один элемент списка.
 *
 * С `link` элемент — кнопка-переход; без `link` — блок с отдельной кнопкой «Отметить
 * прочитанным»: клик по «ничему» обещал бы переход, которого нет (§2.3).
 */
function NotificationRow({ n, onOpen, onRead }: { n: AppNotification; onOpen: (n: AppNotification) => void; onRead: (n: AppNotification) => void }) {
  const time = notificationTime(n.createdAt);
  const deadlineText = n.deadline ? dayjs(n.deadline).format("DD.MM.YYYY") : "";
  const aria =
    "Уведомление: " +
    n.title +
    (deadlineText ? ". Срок " + deadlineText : "") +
    ". " +
    time.label +
    (n.readAt ? "" : ". Непрочитано.");

  if (!n.link) {
    return (
      <List.Item style={{ padding: "8px 4px", borderBlockEnd: "1px solid #f0f0f0" }}>
        <div style={{ width: "100%" }}>
          <ItemBody n={n} time={time} />
          {!n.readAt ? (
            <Button
              size="small"
              type="link"
              aria-label={"Отметить уведомление прочитанным: " + n.title}
              onClick={() => onRead(n)}
            >
              {NOTIFY_TEXTS.markRead}
            </Button>
          ) : null}
        </div>
      </List.Item>
    );
  }

  return (
    <List.Item style={{ padding: 0, borderBlockEnd: "1px solid #f0f0f0" }}>
      <button
        type="button"
        aria-label={aria}
        onClick={() => onOpen(n)}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: n.readAt ? "transparent" : "#f5f9ff",
          border: "none",
          padding: "8px 6px",
          cursor: "pointer",
          font: "inherit"
        }}
      >
        <ItemBody n={n} time={time} />
      </button>
    </List.Item>
  );
}

/** Содержимое панели: шапка, фильтр, список, футер (§2.2–§2.4). */
function NotificationsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notifications = useStore((s) => s.notifications);
  const notificationsTotal = useStore((s) => s.notificationsTotal);
  const notificationsEnabled = useStore((s) => s.notificationsEnabled);
  const unreadCount = useStore((s) => s.unreadCount);
  const loading = useStore((s) => s.notificationsLoading);
  const error = useStore((s) => s.notificationsError);
  const loadNotifications = useStore((s) => s.loadNotifications);
  const markNotificationRead = useStore((s) => s.markNotificationRead);
  const markAllNotificationsRead = useStore((s) => s.markAllNotificationsRead);
  const setSection = useStore((s) => s.setSection);
  const requestDocument = useStore((s) => s.requestDocument);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Фильтр — серверный: фильтровать 20 уже загруженных записей значит спрятать
  // непрочитанное 21-е и показать ложное «Непрочитанных нет» (§2.2).
  // Список при открытии грузит колокольчик; здесь остаётся только смена фильтра.
  useEffect(() => {
    if (!open) setUnreadOnly(false);
  }, [open]);

  useEffect(() => {
    if (open) containerRef.current?.focus();
  }, [open]);

  const readOne = async (n: AppNotification) => {
    if (n.readAt) return;
    try {
      await markNotificationRead(n.id);
    } catch (e) {
      message.error(NOTIFY_TEXTS.readFailed + humanError(e));
    }
  };

  const openNotification = (n: AppNotification) => {
    // Порядок: пометить прочитанным, закрыть панель, перейти (§2.8).
    void readOne(n);
    onClose();
    // Старые уведомления могли сохранить ссылку на удалённую вкладку «На подтверждении».
    // Ведём их в резолюции: отчёт по поручению виден в карточке.
    const link = n.link as string | null;
    const target = link === "confirmation" ? "board" : n.link;
    if (target === "journal" && n.entityType === "document") requestDocument(n.entityId);
    if (target) setSection(target);
  };

  const readAll = async () => {
    try {
      await markAllNotificationsRead();
      message.success(NOTIFY_TEXTS.readAllDone);
    } catch (e) {
      message.error(humanError(e));
    }
  };

  const showMore = () => void loadNotifications({ unreadOnly, append: true });

  const emptyState = () => {
    if (!notificationsEnabled) {
      return <Empty image={<BellOutlined style={{ fontSize: 36, color: "#bfbfbf" }} />} description={NOTIFY_TEXTS.disabled} />;
    }
    if (unreadOnly) {
      return (
        <div>
          <Empty
            image={<BellOutlined style={{ fontSize: 36, color: "#bfbfbf" }} />}
            description={
              <span>
                {NOTIFY_TEXTS.emptyUnreadTitle}
                <br />
                <span style={{ fontSize: 12, color: "#595959" }}>{NOTIFY_TEXTS.emptyUnreadText}</span>
              </span>
            }
          />
          <div style={{ textAlign: "center" }}>
            <Button type="link" size="small" onClick={() => setUnreadOnly(false)}>
              {NOTIFY_TEXTS.showAll}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <Empty
        image={<BellOutlined style={{ fontSize: 36, color: "#bfbfbf" }} />}
        description={
          <span>
            {NOTIFY_TEXTS.emptyTitle}
            <br />
            <span style={{ fontSize: 12, color: "#595959" }}>{NOTIFY_TEXTS.emptyText}</span>
          </span>
        }
      />
    );
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={NOTIFY_TEXTS.panelAria}
      aria-modal={false}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{ width: "min(380px, 92vw)", outline: "none" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Typography.Text strong style={{ flex: 1, fontSize: 14 }}>
          {NOTIFY_TEXTS.panelTitle}
        </Typography.Text>
        <Badge count={unreadCount} size="small" style={BADGE_STYLE} />
        <Button size="small" disabled={unreadCount === 0} onClick={() => void readAll()}>
          {NOTIFY_TEXTS.markAll}
        </Button>
      </div>

      <Checkbox
        checked={unreadOnly}
        onChange={(e) => {
          const next = e.target.checked;
          setUnreadOnly(next);
          void loadNotifications({ unreadOnly: next });
        }}
      >
        {NOTIFY_TEXTS.unreadOnly}
      </Checkbox>

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          message={NOTIFY_TEXTS.errorTitle}
          description={error}
          action={
            <Button size="small" onClick={() => void loadNotifications({ unreadOnly })}>
              {NOTIFY_TEXTS.retry}
            </Button>
          }
        />
      ) : loading && !notifications.length ? (
        <div aria-busy="true" aria-label={NOTIFY_TEXTS.loading} style={{ marginTop: 8 }}>
          <Skeleton active paragraph={{ rows: 3 }} title={false} />
        </div>
      ) : notifications.length ? (
        <List
          size="small"
          dataSource={notifications}
          style={{ maxHeight: 420, overflowY: "auto", marginTop: 4 }}
          renderItem={(n) => (
            <NotificationRow n={n} onOpen={openNotification} onRead={(x) => void readOne(x)} />
          )}
        />
      ) : (
        <div style={{ marginTop: 8 }}>{emptyState()}</div>
      )}

      {notifications.length > 0 && notifications.length < notificationsTotal ? (
        <div style={{ textAlign: "center", marginTop: 8 }}>
          <Button type="link" size="small" loading={loading} onClick={showMore}>
            {NOTIFY_TEXTS.showMore}
          </Button>
          <div style={{ fontSize: 12, color: "#595959" }}>
            {NOTIFY_TEXTS.shownOf + notifications.length + NOTIFY_TEXTS.shownOfMid + notificationsTotal}
          </div>
        </div>
      ) : null}

      {notificationsTotal >= 100 ? (
        <div style={{ fontSize: 12, color: "#595959", marginTop: 8 }}>{NOTIFY_TEXTS.retentionNote}</div>
      ) : null}
    </div>
  );
}

/** Колокольчик в шапке: бейдж, панель и опрос счётчика. */
export function NotificationsBell() {
  const can = useStore((s) => s.can);
  const authStatus = useStore((s) => s.authStatus);
  const authUser = useStore((s) => s.authUser);
  const unreadCount = useStore((s) => s.unreadCount);
  const startNotificationPolling = useStore((s) => s.startNotificationPolling);
  const stopNotificationPolling = useStore((s) => s.stopNotificationPolling);
  const refreshUnreadCount = useStore((s) => s.refreshUnreadCount);
  const loadNotifications = useStore((s) => s.loadNotifications);
  const [panelOpen, setPanelOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement | null>(null);
  /** Панель уже открывали: только тогда закрытие обязано вернуть фокус на колокольчик. */
  const wasOpen = useRef(false);

  // Право проверяется и здесь, и в сторе: без него нет ни колокольчика, ни единого /count.
  const canView = !!authStatus?.docflowEnabled && !!authUser && can("notifications.view");

  useEffect(() => {
    if (!canView) return;
    startNotificationPolling();
    // Возврат на вкладку — повод проверить счётчик сразу (§2.7).
    const onVisibility = () => {
      if (!document.hidden) void refreshUnreadCount();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // Размонтирование обязано снять таймер: иначе опрос живёт после ухода со страницы.
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopNotificationPolling();
    };
  }, [canView, startNotificationPolling, stopNotificationPolling, refreshUnreadCount]);

  useEffect(() => {
    if (panelOpen) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      bellRef.current?.focus();
    }
  }, [panelOpen]);

  if (!canView) return null;

  const many = unreadCount > 99;
  const bellAria = unreadCount === 0 ? NOTIFY_TEXTS.bellAriaNone : many ? NOTIFY_TEXTS.bellAriaMany : NOTIFY_TEXTS.bellAria + unreadCount;
  const bellTooltip = unreadCount === 0 ? NOTIFY_TEXTS.bellTooltip : many ? NOTIFY_TEXTS.bellTooltipMany : NOTIFY_TEXTS.bellTooltipCount + unreadCount + ")";

  return (
    <span>
      {/* Единственная на приложение aria-live-зона: смена числа объявляется вежливо. */}
      <span role="status" aria-live="polite" className="visually-hidden">
        {NOTIFY_TEXTS.liveRegion + unreadCount}
      </span>
      <Popover
        open={panelOpen}
        onOpenChange={(next) => {
          setPanelOpen(next);
          // Перечитываем список именно при открытии: счётчик в бейдже обновляется
          // опросом, а панель без этого оставалась на старых уведомлениях.
          if (next) void loadNotifications();
        }}
        trigger="click"
        placement="bottomRight"
        arrow={false}
        content={<NotificationsPanel open={panelOpen} onClose={() => setPanelOpen(false)} />}
      >
        <Tooltip title={bellTooltip}>
          <Badge count={unreadCount} overflowCount={99} size="small" offset={[-2, 2]} showZero={false} style={BADGE_STYLE}>
            <Button
              ref={bellRef}
              type="text"
              icon={<BellOutlined />}
              aria-label={bellAria}
              aria-haspopup="dialog"
              aria-expanded={panelOpen}
            />
          </Badge>
        </Tooltip>
      </Popover>
    </span>
  );
}
