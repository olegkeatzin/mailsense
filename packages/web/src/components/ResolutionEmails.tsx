import { useEffect, useState } from "react";
import { Button, Space, Tag } from "antd";
import { resolutionApi } from "../api";
import { useStore } from "../store";
import type { Resolution } from "../resolutionTypes";

type EmailLink = { key: string; label: string; emailId: string };

const COLORS: Record<string, string> = {
  request: "blue",
  approval: "gold",
  dispatch: "green"
};

/**
 * Письма по делу: вся переписка резолюции в одном месте.
 *
 * Ссылки отдаёт сервер: в базе хранится id копии отправителя, а у каждого человека
 * своя копия с тем же Message-ID. Иначе у руководителя открывался чужой id и приходило
 * «Письмо не найдено».
 */
export function ResolutionEmails({ resolution, compact = false }: { resolution: Resolution; compact?: boolean }) {
  const setSection = useStore((s) => s.setSection);
  const select = useStore((s) => s.select);
  const [links, setLinks] = useState<EmailLink[]>([]);

  useEffect(() => {
    let alive = true;
    resolutionApi
      .emailLinks(resolution.id)
      .then((r) => {
        if (alive) setLinks(r.links);
      })
      .catch(() => {
        if (alive) setLinks([]);
      });
    return () => {
      alive = false;
    };
  }, [resolution.id]);

  async function open(emailId: string) {
    setSection("mail");
    await select(emailId);
  }

  if (!links.length) {
    return <span style={{ color: "#767676", fontSize: 12 }}>Писем не привязано</span>;
  }

  return (
    <Space wrap size={4}>
      {!compact ? <span style={{ color: "#595959", fontSize: 12 }}>Письма по делу:</span> : null}
      {links.map((l) =>
        COLORS[l.key] ? (
          // Цветной шаг процесса — внутри настоящая кнопка: Tag с onClick не берёт фокус с клавиатуры.
          <Tag key={l.key} color={COLORS[l.key]} style={{ margin: 0, padding: 0 }}>
            <button
              type="button"
              onClick={() => void open(l.emailId)}
              aria-label={"Открыть письмо: " + l.label}
              style={{
                background: "none",
                border: 0,
                padding: "0 7px",
                font: "inherit",
                color: "inherit",
                cursor: "pointer"
              }}
            >
              {l.label}
            </button>
          </Tag>
        ) : (
          <Button
            key={l.key}
            size="small"
            type="link"
            style={{ padding: 0, height: "auto" }}
            onClick={() => void open(l.emailId)}
          >
            {l.label}
          </Button>
        )
      )}
    </Space>
  );
}
