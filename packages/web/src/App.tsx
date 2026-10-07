import { useEffect, useRef, useState } from "react";
import { Alert, Button, Dropdown, Layout, Segmented, Space, Spin, Tooltip, Typography, message } from "antd";
import {
  MenuOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  SettingOutlined,
  CalendarOutlined,
  ImportOutlined,
  EditOutlined,
  FileTextOutlined,
  UserOutlined
} from "@ant-design/icons";
import { useStore } from "./store";
import { api } from "./api";
import { createProgressPoller, type ProgressPoller } from "./utils/progressPolling";
import AccountSidebar from "./components/AccountSidebar";
import { ApprovalList } from "./components/ApprovalList";
import IncomingList from "./components/IncomingList";
import { MyTasks } from "./components/MyTasks";
import { ResolutionBoard } from "./components/ResolutionBoard";
import Journal from "./components/Journal";
import EmailList from "./components/EmailList";
import FilterBar from "./components/FilterBar";
import BulkBar from "./components/BulkBar";
import ImportModal from "./components/ImportModal";
import FetchModal from "./components/FetchModal";
import AnalyzeModal from "./components/AnalyzeModal";
import EmailViewer from "./components/EmailViewer";
import SettingsModal from "./components/SettingsModal";
import { StopAnalysisButton } from "./components/StopAnalysisButton";
import Composer from "./components/Composer";
import DraftsModal from "./components/DraftsModal";
import LoginScreen from "./components/LoginScreen";
import { NotificationsBell } from "./components/NotificationsBell";
import { humanError } from "./utils/humanError";

const { Header, Sider } = Layout;

/** Текущий пользователь и выход. В устаревшем режиме (документооборот выключен) не показывается. */
function CurrentUser() {
  const authUser = useStore((s) => s.authUser);
  const authStatus = useStore((s) => s.authStatus);
  const logout = useStore((s) => s.logout);
  if (!authStatus?.docflowEnabled || !authUser) return null;

  const roleLabel = authUser.roles.length ? authUser.roles.join(", ") : "без роли";
  return (
    <Dropdown
      menu={{
        items: [
          { key: "roles", label: "Роли: " + roleLabel, disabled: true },
          { key: "email", label: authUser.email || "—", disabled: true },
          { type: "divider" },
          { key: "logout", label: "Выйти", danger: true }
        ],
        onClick: async ({ key }) => {
          if (key !== "logout") return;
          try {
            await logout();
          } catch (e) {
            message.error(humanError(e));
          }
        }
      }}
    >
      <Button type="text" icon={<UserOutlined />} style={{ maxWidth: 220 }}>
        {authUser.fullName || authUser.email}
      </Button>
    </Dropdown>
  );
}

function DraftsButton() {
  const setDraftsOpen = useStore((s) => s.setDraftsOpen);
  return (
    <Tooltip title="Сохранённые черновики">
      <Button icon={<FileTextOutlined />} onClick={() => setDraftsOpen(true)}>
        Черновики
      </Button>
    </Tooltip>
  );
}

function AnalysisProgressBadge() {
  const [p, setP] = useState<{
    stage: string;
    attachmentName: string;
    page: number;
    totalPages: number;
    queueLength: number;
    done: number;
    total: number;
  } | null>(null);
  /** Скан, импорт, ручной анализ: счётчик заставляет проверить очередь немедленно. */
  const analysisEpoch = useStore((s) => s.analysisEpoch);
  const pollerRef = useRef<ProgressPoller | null>(null);

  useEffect(() => {
    // Опрос не останавливается насовсем: в простое он редкий («пульс»), потому что
    // анализ запускает и фоновый планировщик — тогда плашка обязана появиться.
    const poller = createProgressPoller({
      fetchProgress: () => api.progress(),
      onProgress: (r) => {
        setP(r);
        // Размер очереди знает только индикатор — им пользуется подтверждение «Стоп».
        useStore.getState().setAnalysisQueue(r.queueLength);
      },
      isHidden: () => document.hidden
    });
    pollerRef.current = poller;
    poller.start();

    /** Возвращение к окну — повод проверить очередь сразу. */
    const onVisibility = () => {
      if (!document.hidden) poller.poke();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      poller.stop();
      pollerRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const firstEpoch = useRef(true);
  useEffect(() => {
    // На старте опрос и так идёт; будим только на последующие действия.
    if (firstEpoch.current) {
      firstEpoch.current = false;
      return;
    }
    pollerRef.current?.poke();
  }, [analysisEpoch]);

  if (!p || (p.queueLength === 0 && p.stage === "idle")) return null;

  let label = "";
  if (p.stage === "attachment") {
    label = "OCR: " + p.attachmentName + (p.totalPages > 1 ? ", стр. " + p.page + "/" + p.totalPages : "");
  } else if (p.stage === "analysis") {
    label = "Анализ письма…";
  } else {
    label = "Очередь: " + p.queueLength;
  }
  if (p.total > 0) {
    label += " · " + p.done + "/" + p.total;
  }

  return (
    <span
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 1000,
        fontSize: 12,
        color: "#0958d9",
        whiteSpace: "nowrap",
        background: "#fff",
        border: "1px solid #d6e4ff",
        borderRadius: 6,
        padding: "6px 12px",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.12)",
        maxWidth: 420,
        overflow: "hidden",
        textOverflow: "ellipsis"
      }}
    >
      {label}
    </span>
  );
}

export default function App() {
  const init = useStore((s) => s.init);
  const loadAuth = useStore((s) => s.loadAuth);
  const authReady = useStore((s) => s.authReady);
  const authStatus = useStore((s) => s.authStatus);
  const authUser = useStore((s) => s.authUser);
  const docflowUnavailable = useStore((s) => s.docflowUnavailable);
  const folder = useStore((s) => s.folder);
  const accounts = useStore((s) => s.accounts);
  const analyzeAll = useStore((s) => s.analyzeAll);

  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const openCompose = useStore((s) => s.openCompose);
  const threadView = useStore((s) => s.threadView);
  const setThreadView = useStore((s) => s.setThreadView);
  const section = useStore((s) => s.section);

  const [collapsed, setCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState(360);
  const [refreshing, setRefreshing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  // Сначала выясняем, нужен ли вход, и только потом грузим данные.
  useEffect(() => {
    void loadAuth();
  }, [loadAuth]);

  // Пока не выяснили состояние входа, грузить данные нельзя: до ответа /api/auth/status
  // authStatus ещё null, и приложение успевало дёрнуть /api/accounts без сессии (401 в консоли).
  const authorized = authReady && (!authStatus?.docflowEnabled || !!authUser);

  useEffect(() => {
    if (authorized) void init();
  }, [authorized, init]);

  // Фоновое обновление списка писем. Раньше оно шло в любом разделе и даже при
  // свёрнутом окне — то есть дёргало сервер, когда результат никто не увидит.
  useEffect(() => {
    if (!authorized) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      if (useStore.getState().section !== "mail") return;
      void useStore.getState().loadEmails();
      void useStore.getState().refreshSelected();
    }, 4000);
    return () => clearInterval(t);
  }, [authorized]);

  if (!authReady) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!authorized) return <LoginScreen />;

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      // Через стор, а не напрямую: он сообщает индикатору, что сервер ставит
      // принятые письма в анализ (иначе плашка прогресса не появится).
      await useStore.getState().fetchAccounts(accounts.map((a) => a.id));
      await useStore.getState().refreshSelected();
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Перетаскивание границы списка.
   *
   * Слушатели вешаются на сам элемент и снимаются по pointerup/pointercancel:
   * если mouseup терялся (курсор уходил за окно), прежняя версия оставляла
   * слушатели на window навсегда. setPointerCapture гарантирует, что конец
   * перетаскивания придёт именно сюда.
   */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* захват недоступен — обойдёмся без него */
    }
    const startX = e.clientX;
    const startW = listWidth;
    const onMove = (ev: PointerEvent) => {
      const w = startW + (ev.clientX - startX);
      if (w > 260 && w < 720) setListWidth(w);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("lostpointercapture", onUp);
      try {
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      } catch {
        /* уже отпущен */
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("lostpointercapture", onUp);
  };

  return (
    <Layout className="app-root">
      <Sider
        collapsible
        collapsed={collapsed}
        trigger={null}
        width={240}
        collapsedWidth={0}
        theme="light"
        style={{ borderRight: "1px solid #f0f0f0" }}
      >
        <AccountSidebar />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderBottom: "1px solid #f0f0f0",
            height: 52,
            lineHeight: "52px"
          }}
        >
          <Button
            type="text"
            icon={<MenuOutlined />}
            aria-label={collapsed ? "Показать панель папок" : "Скрыть панель папок"}
            title={collapsed ? "Показать панель папок" : "Скрыть панель папок"}
            onClick={() => setCollapsed(!collapsed)}
          />
          {section !== "mail" && (
            <Typography.Text strong style={{ marginRight: 8, whiteSpace: "nowrap" }}>
              {section === "journal"
              ? "Журнал регистрации"
              : section === "approvals"
                ? "На утверждении"
                : section === "confirmation"
                  ? "На подтверждении"
                  : section === "tasks"
                  ? "Мои задачи"
                  : section === "board"
                    ? "Резолюции"
                    : "Входящие на регистрацию"}
            </Typography.Text>
          )}
          {section === "mail" && (
            <>
              <Typography.Text strong style={{ marginRight: 8, whiteSpace: "nowrap" }}>
                {folder === "INBOX"
                  ? "Входящие"
                  : folder === "Sent"
                    ? "Отправленные"
                    : folder === "SPAM"
                      ? "Спам"
                      : "Обработанные"}
              </Typography.Text>
          <Button type="primary" icon={<EditOutlined />} onClick={() => openCompose("new")}>
            Написать
          </Button>
          <DraftsButton />
          <Segmented
            size="small"
            options={[
              { label: "Письма", value: "emails" },
              { label: "Переписка", value: "threads" }
            ]}
            value={threadView ? "threads" : "emails"}
            onChange={(v) => setThreadView(v === "threads")}
          />
          <AnalysisProgressBadge />
          <Tooltip title="Сканировать ящик за период дат">
            <Button icon={<CalendarOutlined />} onClick={() => setFetchOpen(true)}>
              Скан
            </Button>
          </Tooltip>
          <Tooltip title="Анализ писем за период дат">
            <Button icon={<ThunderboltOutlined />} onClick={() => setAnalyzeOpen(true)}>
              Анализ
            </Button>
          </Tooltip>
          <StopAnalysisButton />
          <Tooltip title="Импорт писем из .eml / .mbox">
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              Импорт
            </Button>
          </Tooltip>
            </>
          )}
          <div style={{ flex: 1 }} />
          {/* Уведомления — левее пользователя: привычный порядок шапки не ломаем. */}
          <NotificationsBell />
          <CurrentUser />
          <Tooltip title="Настройки">
            <Button
              type="text"
              icon={<SettingOutlined />}
              aria-label="Настройки"
              onClick={() => setSettingsOpen(true)}
            />
          </Tooltip>
        </Header>
        {docflowUnavailable ? (
          <Alert
            type="warning"
            showIcon
            banner
            message="Сервер документооборота недоступен"
            description="Журнал, задачи и резолюции временно недоступны. Почта работает — она хранится локально."
          />
        ) : null}
        {section === "journal" ? (
          <Journal />
        ) : section === "approvals" ? (
          <ApprovalList />
        ) : section === "confirmation" ? (
          // Очередь аппарата «подтвердить разбор ответа, пришедшего письмом» (А1).
          <ApprovalList mode="confirm" />
        ) : section === "tasks" ? (
          <MyTasks />
        ) : section === "board" ? (
          <ResolutionBoard />
        ) : section === "incoming" ? (
          <IncomingList />
        ) : (
          <div style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
            <div style={{ width: listWidth, minWidth: 200, flexShrink: 1, display: "flex", flexDirection: "column", borderRight: "1px solid #f0f0f0" }}>
              <FilterBar />
              <BulkBar />
              <EmailList />
            </div>
            <div
              onPointerDown={startResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Изменить ширину списка писем"
              style={{ width: 4, cursor: "col-resize", background: "#f0f0f0", flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 280, background: "#fff", overflow: "hidden", display: "flex" }}>
              <EmailViewer />
            </div>
          </div>
        )}
      </Layout>
      <SettingsModal />
      <Composer />
      <DraftsModal />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      <FetchModal open={fetchOpen} onClose={() => setFetchOpen(false)} />
      <AnalyzeModal open={analyzeOpen} onClose={() => setAnalyzeOpen(false)} />
    </Layout>
  );
}
