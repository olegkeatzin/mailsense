import { useState } from "react";
import { Button, Checkbox, Input, Select } from "antd";
import { ClearOutlined, FilterOutlined } from "@ant-design/icons";
import { useStore } from "../store";
import type { AnalysisStatus, Category } from "../types";
import FilterModal from "./FilterModal";

const CATEGORY_OPTIONS = [
  { value: "work", label: "Рабочее" },
  { value: "personal", label: "Личное" },
  { value: "spam", label: "Спам" }
];

const PRIORITY_OPTIONS = [
  { value: 0, label: "Все приоритеты" },
  { value: 3, label: "≥ 3" },
  { value: 4, label: "≥ 4 (важные)" },
  { value: 5, label: "5 (критичные)" }
];

const STATUS_OPTIONS = [
  { value: "", label: "Все статусы" },
  { value: "pending", label: "Ожидает" },
  { value: "queued", label: "В очереди" },
  { value: "processing", label: "Обрабатывается" },
  { value: "ready", label: "Готово" },
  { value: "error", label: "Ошибка" }
];

const SORT_OPTIONS = [
  { value: "date_desc", label: "Дата ↓" },
  { value: "date_asc", label: "Дата ↑" },
  { value: "priority_desc", label: "Приоритет ↓" },
  { value: "priority_asc", label: "Приоритет ↑" }
];

export default function FilterBar() {
  const [filterOpen, setFilterOpen] = useState(false);
  const categories = useStore((s) => s.categories);
  const minPriority = useStore((s) => s.minPriority);
  const tag = useStore((s) => s.tag);
  const status = useStore((s) => s.status);
  const q = useStore((s) => s.q);
  const sortBy = useStore((s) => s.sortBy);
  const sortDir = useStore((s) => s.sortDir);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilters = useStore((s) => s.resetFilters);
  const emails = useStore((s) => s.emails);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectAll = useStore((s) => s.selectAll);
  const clearSelection = useStore((s) => s.clearSelection);

  const allSelected = emails.length > 0 && selectedIds.length === emails.length;
  const someSelected = selectedIds.length > 0 && !allSelected;

  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid #f0f0f0",
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap"
      }}
    >
      <Checkbox
        checked={allSelected}
        indeterminate={someSelected}
        onChange={(e) => (e.target.checked ? selectAll() : clearSelection())}
      >
        Все
      </Checkbox>
      <Button size="small" icon={<FilterOutlined />} onClick={() => setFilterOpen(true)}>
        Фильтр
      </Button>
      <Input
        size="small"
        style={{ width: 200 }}
        allowClear
        placeholder="Поиск по содержанию / номеру…"
        value={q}
        onChange={(e) => setFilter({ q: e.target.value })}
      />
      <Select
        size="small"
        mode="multiple"
        style={{ minWidth: 160 }}
        allowClear
        placeholder="Категории"
        value={categories}
        onChange={(v) => setFilter({ categories: v as Category[] })}
        options={CATEGORY_OPTIONS}
      />
      <Select
        size="small"
        style={{ width: 150 }}
        value={minPriority ?? 0}
        onChange={(v) => setFilter({ minPriority: v || null })}
        options={PRIORITY_OPTIONS}
      />
      <Input
        size="small"
        style={{ width: 150 }}
        allowClear
        placeholder="Поиск по тегу…"
        value={tag ?? ""}
        onChange={(e) => setFilter({ tag: e.target.value || null })}
      />
      <Select
        size="small"
        style={{ width: 150 }}
        value={status ?? ""}
        onChange={(v) => setFilter({ status: (v as AnalysisStatus) || null })}
        options={STATUS_OPTIONS}
      />
      <Select
        size="small"
        style={{ width: 140 }}
        value={sortBy + "_" + sortDir}
        onChange={(v) => {
          const [sb, sd] = v.split("_") as ["date" | "priority", "asc" | "desc"];
          setFilter({ sortBy: sb, sortDir: sd });
        }}
        options={SORT_OPTIONS}
      />
      <Button size="small" icon={<ClearOutlined />} onClick={resetFilters}>
        Сброс
      </Button>
      <FilterModal open={filterOpen} onClose={() => setFilterOpen(false)} />
    </div>
  );
}
