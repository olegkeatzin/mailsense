
// ---------------- Резолюции и задачи (СЭД, этап 3) ----------------

export type ResolutionStatus =
  | "draft"
  | "pending_approval"
  | "email_approval"
  | "approved"
  | "sent"
  | "done"
  | "cancelled";

export const RESOLUTION_STATUS_TITLES: Record<ResolutionStatus, string> = {
  draft: "Черновик",
  pending_approval: "На утверждении",
  email_approval: "Ответ подписанта — ждёт подтверждения",
  approved: "Утверждено, ждёт отправки",
  sent: "Отправлено исполнителям",
  done: "Исполнено",
  cancelled: "Отменено"
};

export type ResolutionPriority = "urgent" | "important" | "normal";

export const PRIORITY_TITLES: Record<ResolutionPriority, string> = {
  urgent: "СРОЧНО",
  important: "ВАЖНО",
  normal: "ОБЫЧНО"
};

export type AssigneeKind = "responsible" | "coexecutor";

export interface ResolutionAssignee {
  userId: string;
  fullName: string;
  email: string;
  kind: AssigneeKind;
  receivedAt: string | null;
  reportText: string | null;
  reportAt: string | null;
}

export interface ResolutionHistoryEntry {
  id: string;
  step: "requested" | "approved" | "rejected" | "confirmed" | "dispatched" | "cancelled";
  actorId: string | null;
  actorName: string;
  method: "app" | "email" | "manual" | null;
  comment: string | null;
  emailId: string | null;
  createdAt: string;
}

export const RESOLUTION_STEP_TITLES: Record<ResolutionHistoryEntry["step"], string> = {
  requested: "Отправлено на утверждение",
  approved: "Утверждено подписантом",
  rejected: "Возвращено на доработку",
  confirmed: "Аппарат подтвердил утверждение",
  dispatched: "Отправлено исполнителям",
  cancelled: "Отменено"
};

export interface Resolution {
  id: string;
  documentId: string;
  text: string;
  sourceText: string;
  /** `forwarded` — письмо переслано руководителю, резолюцию он пишет сам. */
  sourceKind: "manual" | "ai" | "email" | "forwarded";
  status: ResolutionStatus;
  priority: ResolutionPriority;
  deadline: string | null;
  preparedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalMethod: "app" | "email" | null;
  confirmedBy: string | null;
  dispatchedBy: string | null;
  dispatchedAt: string | null;
  createdAt: string;
  documentNumber: string;
  documentSummary: string;
  /** Письмо, из которого вырос документ. */
  documentEmailId: string | null;
  preparedByName: string;
  approvedByName: string;
  dispatchedByName: string;
  confirmedByName: string;
  /** Письма, из которых состоит дело: от входящего до отправки исполнителям. */
  requestEmailId: string | null;
  approvalEmailId: string | null;
  dispatchEmailId: string | null;
  assignees: ResolutionAssignee[];
  history: ResolutionHistoryEntry[];
}

export interface TaskItem {
  resolutionId: string;
  kind: AssigneeKind;
  text: string;
  priority: ResolutionPriority;
  deadline: string | null;
  receivedAt: string | null;
  reportAt: string | null;
  /** Что именно написал исполнитель в отчёте. */
  reportText: string | null;
  documentId: string;
  documentNumber: string;
  documentSummary: string;
  /** Письмо-поручение, пришедшее исполнителю: открывается в его почте. */
  emailId: string | null;
  overdue: boolean;
  daysLeft: number | null;
}



/**
 * Факт из заголовков письма: оно отвечает в переписке по такому-то поручению.
 *
 * ⚠️ Это НЕ определение того, что за письмо. Резолюция это или отчёт — решает аппарат.
 */
export interface ReplyContextItem {
  resolutionId: string;
  expects: "approval" | "report";
  documentNumber: string;
  documentSummary: string;
  taskText: string;
  assignees: Array<{ userId: string; fullName: string; kind: AssigneeKind }>;
}

export interface BoardColumn {
  key: string;
  title: string;
  items: Resolution[];
}