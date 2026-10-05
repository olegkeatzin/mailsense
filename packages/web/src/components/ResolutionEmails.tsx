import { Button, Space, Tag } from "antd";
import { useStore } from "../store";
import type { Resolution } from "../resolutionTypes";

/**
 * Письма по делу: вся переписка резолюции в одном месте.
 *
 * Раньше была видна только история шагов («отправлено», «утверждено») — то есть ЧТО
 * произошло, но не сами письма. Для разбора («почему так решили?») нужны именно они.
 *
 * Цепочка: входящее → направлено руководителю → его ответ → отправлено исполнителям.
 */
export function ResolutionEmails({ resolution, compact = false }: { resolution: Resolution; compact?: boolean }) {
  const setSection = useStore((s) => s.setSection);
  const select = useStore((s) => s.select);

  async function open(emailId: string) {
    setSection("mail");
    await select(emailId);
  }

  const links: Array<{ id: string | null; label: string; color?: string }> = [
    { id: resolution.documentEmailId, label: "Входящее письмо" },
    { id: resolution.requestEmailId, label: "Направлено руководителю", color: "blue" },
    // Ответ руководителя выделен цветом: это решение, а не просто письмо.
    { id: resolution.approvalEmailId, label: "Ответ руководителя", color: "gold" },
    { id: resolution.dispatchEmailId, label: "Отправлено исполнителям", color: "green" }
  ].filter((l) => !!l.id);

  if (!links.length) {
    return <span style={{ color: "#bbb", fontSize: 12 }}>Писем не привязано</span>;
  }

  return (
    <Space wrap size={4}>
      {!compact ? <span style={{ color: "#888", fontSize: 12 }}>Письма по делу:</span> : null}
      {links.map((l) =>
        l.color ? (
          <Tag key={l.id} color={l.color} style={{ cursor: "pointer", margin: 0 }} onClick={() => void open(l.id!)}>
            {l.label}
          </Tag>
        ) : (
          <Button key={l.id} size="small" type="link" style={{ padding: 0, height: "auto" }} onClick={() => void open(l.id!)}>
            {l.label}
          </Button>
        )
      )}
    </Space>
  );
}