import { useEffect, useState } from "react";
import { Button, Layout, Space, Tooltip, Typography } from "antd";
import {
  MenuOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  SettingOutlined,
  CalendarOutlined,
  ImportOutlined,
  StopOutlined
} from "@ant-design/icons";
import { useStore } from "./store";
import { api } from "./api";
import AccountSidebar from "./components/AccountSidebar";
import EmailList from "./components/EmailList";
import FilterBar from "./components/FilterBar";
import BulkBar from "./components/BulkBar";
import ImportModal from "./components/ImportModal";
import FetchModal from "./components/FetchModal";
import AnalyzeModal from "./components/AnalyzeModal";
import EmailViewer from "./components/EmailViewer";
import SettingsModal from "./components/SettingsModal";

const { Header, Sider } = Layout;

function AnalysisProgressBadge() {
  const [p, setP] = useState<{
    stage: string;
    attachmentName: string;
    page: number;
    totalPages: number;
    queueLength: number;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.progress();
        if (alive) setP(r);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!p || (p.queueLength === 0 && p.stage === "idle")) return null;

  let label = "";
  if (p.stage === "attachment") {
    label = "OCR: " + p.attachmentName + (p.totalPages > 1 ? ", стр. " + p.page + "/" + p.totalPages : "");
  } else if (p.stage === "analysis") {
    label = "Анализ письма…";
  } else {
    label = "Очередь: " + p.queueLength;
  }

  return (
    <span style={{ fontSize: 12, color: "#1677ff", whiteSpace: "nowrap", marginRight: 4 }}>
      {label}
    </span>
  );
}

export default function App() {
  const init = useStore((s) => s.init);
  const folder = useStore((s) => s.folder);
  const accounts = useStore((s) => s.accounts);
  const analyzeAll = useStore((s) => s.analyzeAll);
  const stopAnalysis = useStore((s) => s.stopAnalysis);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  const [collapsed, setCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState(360);
  const [refreshing, setRefreshing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const t = setInterval(async () => {
      await useStore.getState().loadEmails();
      await useStore.getState().refreshSelected();
    }, 4000);
    return () => clearInterval(t);
  }, []);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      for (const a of accounts) {
        await api.fetchAccount(a.id);
      }
      await useStore.getState().loadEmails();
      await useStore.getState().refreshSelected();
    } finally {
      setRefreshing(false);
    }
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth;
    const onMove = (ev: MouseEvent) => {
      const w = startW + (ev.clientX - startX);
      if (w > 260 && w < 720) setListWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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
          <Button type="text" icon={<MenuOutlined />} onClick={() => setCollapsed(!collapsed)} />
          <Typography.Text strong style={{ marginRight: 8, whiteSpace: "nowrap" }}>
            {folder === "INBOX" ? "Входящие" : folder === "SPAM" ? "Спам" : "Обработанные"}
          </Typography.Text>
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
          <Tooltip title="Остановить анализ (очистить очередь)">
            <Button icon={<StopOutlined />} onClick={() => void stopAnalysis()}>
              Стоп
            </Button>
          </Tooltip>
          <Tooltip title="Импорт писем из .eml / .mbox">
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              Импорт
            </Button>
          </Tooltip>
          <div style={{ flex: 1 }} />
          <Button type="text" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} />
        </Header>
        <div style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
          <div style={{ width: listWidth, minWidth: 200, flexShrink: 1, display: "flex", flexDirection: "column", borderRight: "1px solid #f0f0f0" }}>
            <FilterBar />
            <BulkBar />
            <EmailList />
          </div>
          <div onMouseDown={startResize} style={{ width: 4, cursor: "col-resize", background: "#f0f0f0", flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 280, background: "#fff", overflow: "hidden", display: "flex" }}>
            <EmailViewer />
          </div>
        </div>
      </Layout>
      <SettingsModal />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      <FetchModal open={fetchOpen} onClose={() => setFetchOpen(false)} />
      <AnalyzeModal open={analyzeOpen} onClose={() => setAnalyzeOpen(false)} />
    </Layout>
  );
}
