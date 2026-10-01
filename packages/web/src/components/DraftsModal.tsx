import { useEffect, useState } from "react";
import { Button, Empty, List, Modal, Popconfirm, Space, Tag, Typography, message } from "antd";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useStore } from "../store";
import type { Draft } from "../types";

/** Список сохранённых черновиков: открыть в композере или удалить. */
export default function DraftsModal() {
  const open = useStore((s) => s.draftsOpen);
  const setOpen = useStore((s) => s.setDraftsOpen);
  const openDraftCompose = useStore((s) => s.openDraftCompose);
  const accounts = useStore((s) => s.accounts);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setDrafts(await api.drafts());
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  const remove = async (id: string) => {
    try {
      await api.deleteDraft(id);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.username ?? "аккаунт";

  return (
    <Modal open={open} onCancel={() => setOpen(false)} footer={null} title="Черновики" width={680}>
      {!loading && !drafts.length ? <Empty description="Черновиков нет" /> : null}
      <List
        loading={loading}
        size="small"
        dataSource={drafts}
        renderItem={(d) => (
          <List.Item
            actions={[
              <Button
                key="o"
                size="small"
                type="link"
                icon={<EditOutlined />}
                onClick={() => {
                  openDraftCompose(d);
                  setOpen(false);
                }}
              >
                Открыть
              </Button>,
              <Popconfirm key="d" title="Удалить черновик?" onConfirm={() => void remove(d.id)}>
                <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                  Удалить
                </Button>
              </Popconfirm>
            ]}
          >
            <List.Item.Meta
              title={d.subject || "(без темы)"}
              description={
                <Space size={6} wrap>
                  <Tag color="blue">{accountName(d.accountId)}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {d.to.map((a) => (a.name ? a.name : a.address)).join(", ") || "(без получателя)"}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    · {new Date(d.updatedAt).toLocaleString("ru-RU")}
                  </Typography.Text>
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </Modal>
  );
}
