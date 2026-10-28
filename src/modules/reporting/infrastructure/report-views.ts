import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '@/shared/db/transaction';

/*
 * Reads of the reporting views (db/migrations/0020_reporting_views.sql), the module's only data
 * source. Every column is cast to text where its JavaScript form would lose something: numerics
 * stay exact strings and dates stay YYYY-MM-DD.
 */
type Db = Database | Tx;

async function rows<T>(db: Db, query: SQL): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

export type OrgSettingsRow = { timezone: string; currencyCode: string; currencyScale: number; rfqRequiredAbove: string | null; poApprovalThreshold: string | null };

export async function readOrgSettings(db: Db): Promise<OrgSettingsRow> {
  const [row] = await rows<OrgSettingsRow>(
    db,
    sql`SELECT timezone, currency_code AS "currencyCode", currency_scale AS "currencyScale",
          rfq_required_above::text AS "rfqRequiredAbove", po_approval_threshold::text AS "poApprovalThreshold"
        FROM report_org_settings`,
  );
  if (!row) throw new Error('org_settings row is missing');
  return row;
}

/** The org date at `now`. */
export async function readOrgToday(db: Db, now: Date): Promise<string> {
  const [row] = await rows<{ today: string }>(db, sql`SELECT ((${now.toISOString()}::timestamptz AT TIME ZONE timezone)::date)::text AS today FROM report_org_settings`);
  if (!row) throw new Error('org_settings row is missing');
  return row.today;
}

export type AuditEventRow = {
  id: string;
  /** ISO 8601 with offset. */
  occurredAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorRoles: string[];
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, [unknown, unknown]>;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type AuditSearchFilter = {
  entityType?: string | undefined;
  entityId?: string | undefined;
  actorUserId?: string | undefined;
  action?: string | undefined;
  /** Org dates, inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  /** Events older than this id (ids grow with time). */
  beforeId?: string | undefined;
  limit: number;
};

export async function searchAuditEvents(db: Db, filter: AuditSearchFilter): Promise<AuditEventRow[]> {
  const where: SQL[] = [sql`true`];
  if (filter.entityType) where.push(sql`e.entity_type = ${filter.entityType}`);
  if (filter.entityId) where.push(sql`e.entity_id = ${filter.entityId}`);
  if (filter.actorUserId) where.push(sql`e.actor_user_id = ${filter.actorUserId}`);
  if (filter.action) where.push(sql`e.action = ${filter.action}`);
  if (filter.from) where.push(sql`e.occurred_at >= (${filter.from}::date)::timestamp AT TIME ZONE s.timezone`);
  if (filter.to) where.push(sql`e.occurred_at < (${filter.to}::date + 1)::timestamp AT TIME ZONE s.timezone`);
  if (filter.beforeId) where.push(sql`e.id < ${filter.beforeId}::bigint`);
  return rows<AuditEventRow>(
    db,
    sql`SELECT e.id::text AS id, to_json(e.occurred_at)#>>'{}' AS "occurredAt", e.actor_user_id AS "actorUserId", e.actor_name AS "actorName",
          e.actor_roles AS "actorRoles", e.action, e.entity_type AS "entityType", e.entity_id AS "entityId", e.changes, e.reason,
          e.request_id::text AS "requestId", e.ip, e.user_agent AS "userAgent"
        FROM report_audit_events e CROSS JOIN report_org_settings s
        WHERE ${sql.join(where, sql` AND `)}
        ORDER BY e.id DESC
        LIMIT ${filter.limit}`,
  );
}

export async function listUsers(db: Db): Promise<{ id: string; name: string }[]> {
  return rows(db, sql`SELECT id::text AS id, name FROM report_users ORDER BY name, id`);
}

export type SpendBasis = 'issued' | 'received';
export type SpendDimension = 'supplier' | 'department';
export type SpendRow = { key: string; code: string; name: string; currencyCode: string; currencyScale: number; poCount: number; total: string };

const SPEND_VIEWS: Record<SpendBasis, SQL> = { issued: sql`report_spend_issued`, received: sql`report_spend_received` };
const SPEND_KEYS: Record<SpendDimension, { id: SQL; code: SQL; name: SQL }> = {
  supplier: { id: sql`supplier_id`, code: sql`supplier_code`, name: sql`supplier_name` },
  department: { id: sql`department_id`, code: sql`department_code`, name: sql`department_name` },
};

export async function readSpend(db: Db, basis: SpendBasis, by: SpendDimension, from: string, to: string): Promise<SpendRow[]> {
  const k = SPEND_KEYS[by];
  return rows<SpendRow>(
    db,
    sql`SELECT ${k.id}::text AS key, ${k.code} AS code, ${k.name} AS name, currency_code AS "currencyCode",
          max(currency_scale)::int AS "currencyScale", count(DISTINCT purchase_order_id)::int AS "poCount", sum(amount)::text AS total
        FROM ${SPEND_VIEWS[basis]}
        WHERE spend_on BETWEEN ${from}::date AND ${to}::date
        GROUP BY ${k.id}, ${k.code}, ${k.name}, currency_code
        ORDER BY sum(amount) DESC, ${k.name}, ${k.id}`,
  );
}

export type CycleRow = {
  requisitionId: string;
  number: string;
  departmentId: string;
  departmentName: string;
  submittedAt: string;
  approvedAt: string;
  cycleSeconds: string;
};

export async function readRequisitionCycles(db: Db, from: string, to: string, departmentId: string | undefined): Promise<CycleRow[]> {
  return rows<CycleRow>(
    db,
    sql`SELECT requisition_id::text AS "requisitionId", number, department_id::text AS "departmentId", department_name AS "departmentName",
          to_json(submitted_at)#>>'{}' AS "submittedAt", to_json(approved_at)#>>'{}' AS "approvedAt", cycle_seconds::text AS "cycleSeconds"
        FROM report_requisition_cycle
        WHERE approved_on BETWEEN ${from}::date AND ${to}::date
          ${departmentId ? sql`AND department_id = ${departmentId}::uuid` : sql``}
        ORDER BY approved_at, number`,
  );
}

export type PendingStepRow = {
  documentType: 'requisition' | 'purchase_order';
  documentId: string;
  documentNumber: string;
  documentTitle: string;
  amount: string;
  currencyCode: string;
  currencyScale: number;
  departmentName: string;
  stepNo: number;
  requiredRole: string;
  activatedAt: string;
  ageSeconds: string;
};

export async function readPendingSteps(db: Db, now: Date, olderThanDays: number): Promise<PendingStepRow[]> {
  const at = now.toISOString();
  return rows<PendingStepRow>(
    db,
    sql`SELECT document_type AS "documentType", document_id::text AS "documentId", document_number AS "documentNumber",
          document_title AS "documentTitle", amount_snapshot::text AS amount, currency_code AS "currencyCode", currency_scale AS "currencyScale",
          department_name AS "departmentName", step_no AS "stepNo", required_role AS "requiredRole", to_json(activated_at)#>>'{}' AS "activatedAt",
          greatest(EXTRACT(EPOCH FROM ${at}::timestamptz - activated_at), 0)::text AS "ageSeconds"
        FROM report_pending_approval_steps
        WHERE activated_at <= ${at}::timestamptz - make_interval(days => ${olderThanDays})
        ORDER BY activated_at, document_number, step_no`,
  );
}

export type OpenLineRow = {
  purchaseOrderId: string;
  number: string;
  status: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  departmentName: string;
  currencyCode: string;
  currencyScale: number;
  issuedOn: string;
  expectedDeliveryDate: string | null;
  lineNo: number;
  description: string;
  uom: string;
  quantity: string;
  receivedQty: string;
  outstandingQty: string;
  outstandingAmount: string;
};

export async function readOpenOrderLines(db: Db, supplierId: string | undefined): Promise<OpenLineRow[]> {
  return rows<OpenLineRow>(
    db,
    sql`SELECT purchase_order_id::text AS "purchaseOrderId", number, status, supplier_id::text AS "supplierId", supplier_code AS "supplierCode",
          supplier_name AS "supplierName", department_name AS "departmentName", currency_code AS "currencyCode", currency_scale AS "currencyScale",
          issued_on::text AS "issuedOn", expected_delivery_date::text AS "expectedDeliveryDate", line_no AS "lineNo", description, uom,
          quantity::text AS quantity, received_qty::text AS "receivedQty", outstanding_qty::text AS "outstandingQty",
          outstanding_amount::text AS "outstandingAmount"
        FROM report_open_order_lines
        ${supplierId ? sql`WHERE supplier_id = ${supplierId}::uuid` : sql``}
        ORDER BY issued_on, number, line_no`,
  );
}

/** Suppliers with at least one open order, for the filter. */
export async function readOpenOrderSuppliers(db: Db): Promise<{ id: string; code: string; name: string }[]> {
  return rows(
    db,
    sql`SELECT DISTINCT supplier_id::text AS id, supplier_code AS code, supplier_name AS name FROM report_open_order_lines ORDER BY name, id`,
  );
}

export type SplitCandidateRow = {
  purchaseOrderId: string;
  number: string;
  requisitionNumber: string;
  requesterUserId: string;
  requesterName: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  currencyCode: string;
  currencyScale: number;
  fromQuotation: boolean;
  subtotal: string;
  total: string;
  approvedOn: string;
};

export async function readSplitCandidates(db: Db, from: string, to: string): Promise<SplitCandidateRow[]> {
  return rows<SplitCandidateRow>(
    db,
    sql`SELECT purchase_order_id::text AS "purchaseOrderId", number, requisition_number AS "requisitionNumber",
          requester_user_id::text AS "requesterUserId", requester_name AS "requesterName", supplier_id::text AS "supplierId",
          supplier_code AS "supplierCode", supplier_name AS "supplierName", currency_code AS "currencyCode", currency_scale AS "currencyScale",
          from_quotation AS "fromQuotation", subtotal::text AS subtotal, total::text AS total, approved_on::text AS "approvedOn"
        FROM report_split_candidates
        WHERE approved_on BETWEEN ${from}::date AND ${to}::date
        ORDER BY approved_on, number`,
  );
}
