/** Shared frontend types mirroring the backend's public shapes. */

// ---------------------------------------------------------------------------
// Lead & Opportunity Management (Module 2)
// ---------------------------------------------------------------------------

export type LeadStage = 'NEW' | 'CONTACTED' | 'PROPOSAL_SENT' | 'WON' | 'LOST';
export type LeadSource = 'REFERRAL' | 'WEBSITE' | 'COLD_CALL' | 'EXHIBITION' | 'OTHER';
export type QuotationStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export interface LeadUserRef {
  id: number;
  fullName: string;
}

export interface QuotationPrinter {
  id: number;
  printerModel: string;
  quantity: number;
}

export interface Quotation {
  id: number;
  leadId: number;
  monthlyLeaseFee: number;
  perPageBw: number;
  perPageColour: number;
  discountPct: number;
  notes: string | null;
  status: QuotationStatus;
  printers: QuotationPrinter[];
  approvedBy: LeadUserRef | null;
  approvedAt: string | null;
  approvalNote: string | null;
  createdBy: LeadUserRef;
  createdAt: string;
  updatedAt: string;
}

export interface StageHistoryEntry {
  id: number;
  fromStage: LeadStage | null;
  toStage: LeadStage;
  note: string | null;
  changedBy: LeadUserRef;
  changedAt: string;
}

export interface Lead {
  id: number;
  companyName: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  source: LeadSource;
  expectedPrinters: number;
  stage: LeadStage;
  stageNote: string | null;
  assignedTo: LeadUserRef | null;
  lostReason: string | null;
  convertedCustomerId: number | null;
  convertedAt: string | null;
  convertedBy: LeadUserRef | null;
  createdBy: LeadUserRef;
  createdAt: string;
  updatedAt: string;
}

export interface LeadDetail {
  lead: Lead;
  quotations: Quotation[];
  stageHistory: StageHistoryEntry[];
}

export interface Role {
  id: number;
  code: string;
  name: string;
  description?: string | null;
}

export interface User {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only present on the logged-in user (from /auth/me & /auth/login). */
  permissions?: string[];
}

export interface AuditEntry {
  id: number;
  actorUserId: number | null;
  actorEmail: string | null;
  entityType: string;
  entityId: string | null;
  action: string;
  reason: string | null;
  changes: unknown;
  ipAddress: string | null;
  createdAt: string;
}

/** Permission codes used by the UI to gate navigation and actions. */
export const PERM = {
  usersRead: 'users.read',
  usersCreate: 'users.create',
  usersUpdate: 'users.update',
  usersDeactivate: 'users.deactivate',
  usersResetPassword: 'users.reset_password',
  rolesRead: 'roles.read',
  auditRead: 'audit.read',
  leadsRead: 'leads.read',
  leadsCreate: 'leads.create',
  leadsUpdate: 'leads.update',
  leadsChangeStage: 'leads.change_stage',
  leadsConvert: 'leads.convert',
  quotationsCreate: 'quotations.create',
  quotationsApprove: 'quotations.approve',
} as const;
