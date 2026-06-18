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

// ---------------------------------------------------------------------------
// Customer & Contract Management (Module 3)
// ---------------------------------------------------------------------------

export type CustomerStatus = 'ACTIVE' | 'INACTIVE';
export type SlaTier = 'PLATINUM' | 'GOLD' | 'SILVER' | 'BRONZE';
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED';

export interface UserRef {
  id: number;
  fullName: string | null;
}

export interface Customer {
  id: number;
  name: string;
  registrationNo: string | null;
  vatNo: string | null;
  industry: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  billingEmail: string | null;
  billingPhone: string | null;
  status: CustomerStatus;
  notes: string | null;
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
  /** Present only on the list endpoint. */
  contractCount?: number;
  activeContractCount?: number;
}

export interface CustomerSite {
  id: number;
  customerId: number;
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  contactName: string | null;
  contactPhone: string | null;
  isPrimary: boolean;
  createdAt: string;
}

export interface CustomerContact {
  id: number;
  customerId: number;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  createdAt: string;
}

export interface ContractSummary {
  id: number;
  contractNo: string;
  startDate: string;
  endDate: string;
  monthlyLeaseFee: number;
  perClickBw: number;
  perClickColour: number;
  slaTier: SlaTier;
  status: ContractStatus;
  hasDocument: boolean;
}

export interface CustomerDetail {
  customer: Customer;
  sites: CustomerSite[];
  contacts: CustomerContact[];
  contracts: ContractSummary[];
}

export interface ContractPrinter {
  id: number;
  printerModel: string;
  serialNo: string | null;
  siteId: number | null;
  quantity: number;
}

export interface ContractDocument {
  id: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedBy: UserRef | null;
  uploadedAt: string;
}

export interface Contract {
  id: number;
  customerId: number;
  customerName: string | null;
  contractNo: string;
  startDate: string;
  endDate: string;
  monthlyLeaseFee: number;
  perClickBw: number;
  perClickColour: number;
  slaTier: SlaTier;
  status: ContractStatus;
  notes: string | null;
  daysUntilExpiry: number;
  expiringSoon: boolean;
  activatedAt: string | null;
  activatedBy: UserRef | null;
  terminatedAt: string | null;
  terminatedBy: UserRef | null;
  terminationReason: string | null;
  createdBy: UserRef;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDetail {
  contract: Contract;
  printers: ContractPrinter[];
  documents: ContractDocument[];
}

// ---------------------------------------------------------------------------
// Asset / Printer Management (Module 4)
// ---------------------------------------------------------------------------

export type PrinterStatus =
  | 'ORDERED' | 'IN_TRANSIT' | 'RECEIVED'
  | 'QC_PASS' | 'QC_FAIL'
  | 'IN_STOCK' | 'ALLOCATED' | 'DISPATCHED' | 'INSTALLED'
  | 'UNDER_REPAIR' | 'REPLACEMENT_OUT'
  | 'RETURNED' | 'REFURBISHED' | 'RETIRED';

export type PrintTechnology = 'LASER' | 'INKJET' | 'LED' | 'THERMAL' | 'DOT_MATRIX' | 'OTHER';

export interface Printer {
  id: number;
  serialNo: string;
  assetNo: string | null;
  brand: string;
  model: string;
  printTechnology: PrintTechnology;
  isColour: boolean;
  ppmBw: number | null;
  ppmColour: number | null;
  lifetimePages: number;
  location: string | null;
  warrantyExpiry: string | null;
  currentContractId: number | null;
  currentContractNo: string | null;
  currentSiteId: number | null;
  currentSiteName: string | null;
  status: PrinterStatus;
  notes: string | null;
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrinterHistoryEntry {
  id: number;
  fromStatus: PrinterStatus | null;
  toStatus: PrinterStatus;
  reason: string | null;
  changedBy: UserRef;
  changedAt: string;
}

export interface PrinterDetail {
  printer: Printer;
  history: PrinterHistoryEntry[];
  allowedTransitions: PrinterStatus[];
}

// ---------------------------------------------------------------------------
// Inventory / Warehouse Management (Module 5)
// ---------------------------------------------------------------------------

export interface Warehouse {
  id: number;
  code: string;
  name: string;
  type: 'CENTRAL' | 'DEPOT';
  address: string | null;
  city: string | null;
  contactName: string | null;
  contactPhone: string | null;
  isActive: boolean;
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
  printerCount?: number;
  consumableLineCount?: number;
}

export interface WarehousePrinterStock {
  id: number;
  serialNo: string;
  assetNo: string | null;
  brand: string;
  model: string;
  status: PrinterStatus;
  currentContractId: number | null;
  currentContractNo: string | null;
}

export interface WarehouseConsumableStock {
  consumableId: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  qtyOnHand: number;
  reorderLevel: number;
  isLowStock: boolean;
}

export interface WarehouseDetail {
  warehouse: Warehouse;
  printers: WarehousePrinterStock[];
  consumableStock: WarehouseConsumableStock[];
}

export type ConsumableCategory = 'TONER' | 'SPARE_PART' | 'PAPER' | 'OTHER';

export interface Consumable {
  id: number;
  sku: string;
  name: string;
  category: ConsumableCategory;
  unit: string;
  reorderLevel: number;
  description: string | null;
  isActive: boolean;
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
  totalQtyOnHand?: number;
  isLowStock?: boolean;
}

export interface ConsumableStockLine {
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  qtyOnHand: number;
  isLowStock: boolean;
}

export interface GRN {
  id: number;
  grnNo: string;
  warehouseId: number;
  warehouseName: string;
  supplierName: string | null;
  supplierRef: string | null;
  receivedAt: string;
  notes: string | null;
  receivedBy: UserRef | null;
  createdAt: string;
  printerCount?: number;
  consumableLineCount?: number;
}

export interface GRNPrinterLine {
  id: number;
  printerId: number;
  serialNo: string;
  brand: string;
  model: string;
  assetNo: string | null;
  unitCost: number | null;
}

export interface GRNConsumableLine {
  id: number;
  consumableId: number;
  sku: string;
  consumableName: string;
  unit: string;
  quantity: number;
  unitCost: number | null;
}

export interface GRNDetail {
  grn: GRN;
  printerLines: GRNPrinterLine[];
  consumableLines: GRNConsumableLine[];
}

// ---------------------------------------------------------------------------
// Dispatch & Delivery Management (Module 6)
// ---------------------------------------------------------------------------

export type DispatchStatus = 'PENDING' | 'SCHEDULED' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED';

export interface DispatchOrderItem {
  id: number;
  printerId: number;
  serialNo: string;
  brand: string;
  model: string;
  assetNo: string | null;
  printerStatus: PrinterStatus;
  notes: string | null;
}

export interface DispatchOrder {
  id: number;
  orderNo: string;
  contractId: number;
  contractNo: string;
  customerId: number;
  customerName: string;
  siteId: number | null;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  status: DispatchStatus;
  plannedDate: string | null;
  courier: string | null;
  trackingRef: string | null;
  departedAt: string | null;
  deliveredAt: string | null;
  podRecipient: string | null;
  podNotes: string | null;
  notes: string | null;
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchOrderDetail {
  order: DispatchOrder;
  items: DispatchOrderItem[];
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
  customersRead: 'customers.read',
  customersCreate: 'customers.create',
  customersUpdate: 'customers.update',
  contractsRead: 'contracts.read',
  contractsCreate: 'contracts.create',
  contractsUpdate: 'contracts.update',
  contractsActivate: 'contracts.activate',
  contractsTerminate: 'contracts.terminate',
  printersRead: 'printers.read',
  printersCreate: 'printers.create',
  printersUpdate: 'printers.update',
  printersManageStatus: 'printers.manage_status',
  inventoryRead: 'inventory.read',
  inventoryGrn: 'inventory.grn',
  inventoryAdjust: 'inventory.adjust',
  inventoryAllocate: 'inventory.allocate',
  dispatchRead: 'dispatch.read',
  dispatchCreate: 'dispatch.create',
  dispatchUpdate: 'dispatch.update',
  dispatchDeliver: 'dispatch.deliver',
  serviceRead: 'service.read',
  serviceCreate: 'service.create',
  serviceAssign: 'service.assign',
  serviceUpdate: 'service.update',
  serviceClose: 'service.close',
  serviceEscalate: 'service.escalate',
  serviceResolve: 'service.resolve',
  serviceReopen: 'service.reopen',
  helpdeskManage: 'helpdesk.manage',
} as const;

// ---------------------------------------------------------------------------
// Service Ticket Management — Module 8 (Helpdesk)
// ---------------------------------------------------------------------------

export type TicketStatus = 'OPEN' | 'ASSIGNED' | 'IN_TRANSIT' | 'ON_SITE' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'ESCALATED' | 'CANCELLED';
export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type TicketSource = 'PHONE' | 'PORTAL' | 'EMAIL';
export type SlaAlertType = 'T_MINUS_1H' | 'BREACH' | 'DOUBLE_BREACH';

export interface TicketUserRef { id: number; fullName: string | null; }
export interface TicketSite { id: number; name: string | null; address: string | null; city: string | null; lat: number | null; lng: number | null; }
export interface TicketPrinter { id: number; serialNo: string | null; model: string | null; isColour: boolean; }
export interface IssueCategory { id: number; name: string; description: string | null; isActive: boolean; }

export interface ServiceTicket {
  id: number;
  ticketNo: string;
  visitType: string;
  priority: TicketPriority;
  status: TicketStatus;
  customer: { id: number; name: string; phone: string | null; email: string | null };
  site: TicketSite | null;
  contractId: number | null;
  contractNo: string | null;
  printer: TicketPrinter | null;
  assignedTo: TicketUserRef | null;
  escalatedTo: TicketUserRef | null;
  description: string | null;
  source: TicketSource;
  slaTier: SlaTier | null;
  issueCategory: { id: number; name: string } | null;
  reopenCount: number;
  lastResolvedAt: string | null;
  scheduledDate: string | null;
  slaDueAt: string | null;
  inTransitAt: string | null;
  checkedInAt: string | null;
  slaMet: boolean | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  closedAt: string | null;
  closeMethod: 'SIGNATURE' | 'OTP' | null;
  signatureName: string | null;
  hasSignature: boolean;
  escalatedAt: string | null;
  escalationReason: string | null;
  createdBy: TicketUserRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlaAlert {
  id: number;
  ticketId: number;
  ticketNo: string;
  ticketStatus: TicketStatus;
  alertType: SlaAlertType;
  status: 'NEW' | 'NOTIFIED' | 'ESCALATED';
  slaDueAt: string | null;
  escalatedTo: string | null;
  createdAt: string;
}
