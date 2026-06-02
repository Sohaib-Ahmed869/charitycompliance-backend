/**
 * Expenses-by-entity reporting service
 *
 * Two operational reports that pivot the expense ledger by either:
 *   - supplier_id  (every expense linked to each Supplier Register entry),
 *   - project_id   (every expense linked to each Project Register entry).
 *
 * No new data is collected — both pivots are read directly from
 * `expense.supplier_id` and `expense.project_id`, which the expense
 * form already captures at submission time.
 *
 * Filters supported:
 *   - startDate / endDate (ISO, optional) — applied against `created_at`.
 *   - status (optional) — single expense status (draft|pending|approved|paid|...).
 *
 * Aggregation runs in JS rather than a Mongo $group, so we can fold in
 * the populated supplier and project fields and shape the response
 * exactly the way the report table expects.
 *
 * Returned shape (both reports):
 *   {
 *     filters: { startDate, endDate, status },
 *     totals: { expense_count, total_amount, paid_amount, approved_amount,
 *               unallocated_count, unallocated_amount },
 *     rows:   [ { entity-specific keys + breakdown + expenses[] } ]
 *   }
 *
 * `unallocated_*` rolls up expenses with no supplier_id / project_id set
 * (older records or out-of-scope spend) so they don't silently vanish
 * from the totals.
 */

import mongoose from 'mongoose';
import expenseSchema from '../db/schemas/platform/expenseSchema.js';
import supplierSchema from '../db/schemas/platform/supplierSchema.js';
import projectRegisterSchema from '../db/schemas/platform/projectRegisterSchema.js';

const STATUS_BUCKETS = ['draft', 'pending', 'approved', 'paid', 'rejected', 'resubmission_required', 'cancelled'];

const isPaid     = (s) => s === 'paid';
const isApproved = (s) => s === 'approved';

const ensureModel = (tenantDb, name, schema) =>
  tenantDb.models[name] || tenantDb.model(name, schema);

/**
 * Resolve, query, and decorate the expense list for both reports. Kept
 * private so the two public builders share a single load path.
 */
const loadExpenses = async ({ tenantDb, orgId, startDate, endDate, status }) => {
  // Register all three models on this tenant connection so populate works.
  const Expense = ensureModel(tenantDb, 'Expense', expenseSchema);
  ensureModel(tenantDb, 'Supplier', supplierSchema);
  ensureModel(tenantDb, 'ProjectRegister', projectRegisterSchema);

  const query = { org_id: orgId };
  if (status && STATUS_BUCKETS.includes(status)) query.status = status;

  if (startDate || endDate) {
    query.created_at = {};
    if (startDate) query.created_at.$gte = new Date(startDate);
    if (endDate) {
      // Treat endDate as inclusive end-of-day so the report does not
      // silently drop an expense submitted on the picked end date.
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.created_at.$lte = end;
    }
  }

  return Expense.find(query)
    .select('expense_name amount status created_at paid_at category supplier_id supplier_name project_id vendor_name payment_method')
    .populate('supplier_id', 'legal_name trading_name supplier_number category vetting_status')
    .populate('project_id', 'project_name project_code status project_kind')
    .sort({ created_at: -1 })
    .lean();
};

/**
 * Update a per-bucket row with one expense — used by both pivots.
 * Mutates `row` in place; returns nothing.
 */
const accumulate = (row, exp) => {
  const amount = Number(exp?.amount || 0);
  row.expense_count += 1;
  row.total_amount  += amount;
  if (isPaid(exp.status))     { row.paid_amount     += amount; row.paid_count     += 1; }
  if (isApproved(exp.status)) { row.approved_amount += amount; row.approved_count += 1; }
  row.status_breakdown[exp.status] = (row.status_breakdown[exp.status] || 0) + 1;

  const created = exp?.created_at ? new Date(exp.created_at).getTime() : 0;
  if (!row._last_ts || created > row._last_ts) {
    row._last_ts = created;
    row.last_expense_date = exp?.created_at || null;
  }

  row.expenses.push({
    _id: String(exp._id),
    expense_name: exp.expense_name || '',
    amount,
    status: exp.status,
    created_at: exp.created_at,
    paid_at: exp.paid_at,
    category: exp.category || '',
    vendor_name: exp.vendor_name || '',
    payment_method: exp.payment_method || '',
    // Cross-reference: when listing by supplier we still want the
    // project chip on each row, and vice-versa.
    supplier_id: exp.supplier_id?._id ? String(exp.supplier_id._id) : null,
    supplier_label: exp.supplier_id?.legal_name || exp.supplier_id?.trading_name || exp.supplier_name || null,
    project_id: exp.project_id?._id ? String(exp.project_id._id) : null,
    project_label: exp.project_id?.project_name || null
  });
};

const blankStatusBreakdown = () =>
  STATUS_BUCKETS.reduce((acc, s) => { acc[s] = 0; return acc; }, {});

/**
 * Expenses grouped by Supplier Register entry.
 *
 * Rows: one per distinct supplier_id encountered, plus a synthetic
 * "Unallocated" row for expenses that didn't reference a vetted
 * supplier (free-text vendor only).
 */
export const buildExpensesBySupplierReport = async ({ tenantDb, orgId, startDate, endDate, status }) => {
  const expenses = await loadExpenses({ tenantDb, orgId, startDate, endDate, status });

  const bySupplier = new Map(); // supplierId -> row
  // Unallocated bucket — explicit so the totals reconcile even when
  // the user has legacy expenses without a supplier_id.
  const UNALLOCATED_KEY = '__unallocated__';

  const totals = {
    expense_count: 0,
    total_amount: 0,
    paid_amount: 0,
    approved_amount: 0,
    unallocated_count: 0,
    unallocated_amount: 0
  };

  for (const exp of expenses) {
    const amount = Number(exp?.amount || 0);
    totals.expense_count += 1;
    totals.total_amount  += amount;
    if (isPaid(exp.status))     totals.paid_amount     += amount;
    if (isApproved(exp.status)) totals.approved_amount += amount;

    const sid = exp.supplier_id?._id ? String(exp.supplier_id._id) : UNALLOCATED_KEY;

    if (!bySupplier.has(sid)) {
      const unalloc = sid === UNALLOCATED_KEY;
      bySupplier.set(sid, {
        supplier_id: unalloc ? null : sid,
        supplier_name: unalloc
          ? 'Unallocated (no vetted supplier)'
          : (exp.supplier_id.legal_name || exp.supplier_id.trading_name || exp.supplier_name || 'Unnamed supplier'),
        supplier_number: unalloc ? null : (exp.supplier_id.supplier_number || null),
        supplier_category: unalloc ? null : (exp.supplier_id.category || null),
        vetting_status: unalloc ? null : (exp.supplier_id.vetting_status || null),
        is_unallocated: unalloc,
        expense_count: 0,
        total_amount: 0,
        paid_amount: 0,
        approved_amount: 0,
        paid_count: 0,
        approved_count: 0,
        // Distinct project ids seen for this supplier — fills the
        // "Projects funded through this supplier" chip on the row.
        _project_ids: new Set(),
        projects: [],
        status_breakdown: blankStatusBreakdown(),
        last_expense_date: null,
        _last_ts: 0,
        expenses: []
      });
    }

    const row = bySupplier.get(sid);
    accumulate(row, exp);

    if (exp.project_id?._id) {
      const pid = String(exp.project_id._id);
      if (!row._project_ids.has(pid)) {
        row._project_ids.add(pid);
        row.projects.push({
          _id: pid,
          project_name: exp.project_id.project_name || '',
          project_code: exp.project_id.project_code || null,
          status: exp.project_id.status || null
        });
      }
    }

    if (sid === UNALLOCATED_KEY) {
      totals.unallocated_count  += 1;
      totals.unallocated_amount += amount;
    }
  }

  // Strip internal-only fields and sort by total_amount desc, with the
  // unallocated bucket pinned to the bottom so it doesn't dominate
  // the top of the table.
  const rows = [...bySupplier.values()]
    .map(({ _project_ids, _last_ts, ...rest }) => ({  // eslint-disable-line no-unused-vars
      ...rest,
      project_count: rest.projects.length
    }))
    .sort((a, b) => {
      if (a.is_unallocated !== b.is_unallocated) return a.is_unallocated ? 1 : -1;
      return b.total_amount - a.total_amount;
    });

  return {
    filters: { startDate: startDate || null, endDate: endDate || null, status: status || null },
    totals,
    rows
  };
};

/**
 * Expenses grouped by Project Register entry.
 *
 * Rows: one per distinct project_id encountered, plus a synthetic
 * "Unallocated" row for non-project / general-fund spend.
 */
export const buildExpensesByProjectReport = async ({ tenantDb, orgId, startDate, endDate, status }) => {
  const expenses = await loadExpenses({ tenantDb, orgId, startDate, endDate, status });

  const byProject = new Map();
  const UNALLOCATED_KEY = '__unallocated__';

  const totals = {
    expense_count: 0,
    total_amount: 0,
    paid_amount: 0,
    approved_amount: 0,
    unallocated_count: 0,
    unallocated_amount: 0
  };

  for (const exp of expenses) {
    const amount = Number(exp?.amount || 0);
    totals.expense_count += 1;
    totals.total_amount  += amount;
    if (isPaid(exp.status))     totals.paid_amount     += amount;
    if (isApproved(exp.status)) totals.approved_amount += amount;

    const pid = exp.project_id?._id ? String(exp.project_id._id) : UNALLOCATED_KEY;

    if (!byProject.has(pid)) {
      const unalloc = pid === UNALLOCATED_KEY;
      byProject.set(pid, {
        project_id: unalloc ? null : pid,
        project_name: unalloc
          ? 'Unallocated (general / non-project spend)'
          : (exp.project_id.project_name || 'Unnamed project'),
        project_code: unalloc ? null : (exp.project_id.project_code || null),
        project_status: unalloc ? null : (exp.project_id.status || null),
        project_kind: unalloc ? null : (exp.project_id.project_kind || null),
        is_unallocated: unalloc,
        expense_count: 0,
        total_amount: 0,
        paid_amount: 0,
        approved_amount: 0,
        paid_count: 0,
        approved_count: 0,
        _supplier_ids: new Set(),
        suppliers: [],
        status_breakdown: blankStatusBreakdown(),
        last_expense_date: null,
        _last_ts: 0,
        expenses: []
      });
    }

    const row = byProject.get(pid);
    accumulate(row, exp);

    if (exp.supplier_id?._id) {
      const sid = String(exp.supplier_id._id);
      if (!row._supplier_ids.has(sid)) {
        row._supplier_ids.add(sid);
        row.suppliers.push({
          _id: sid,
          legal_name: exp.supplier_id.legal_name || exp.supplier_id.trading_name || 'Supplier',
          supplier_number: exp.supplier_id.supplier_number || null,
          category: exp.supplier_id.category || null
        });
      }
    }

    if (pid === UNALLOCATED_KEY) {
      totals.unallocated_count  += 1;
      totals.unallocated_amount += amount;
    }
  }

  const rows = [...byProject.values()]
    .map(({ _supplier_ids, _last_ts, ...rest }) => ({  // eslint-disable-line no-unused-vars
      ...rest,
      supplier_count: rest.suppliers.length
    }))
    .sort((a, b) => {
      if (a.is_unallocated !== b.is_unallocated) return a.is_unallocated ? 1 : -1;
      return b.total_amount - a.total_amount;
    });

  return {
    filters: { startDate: startDate || null, endDate: endDate || null, status: status || null },
    totals,
    rows
  };
};

// Internal symbol export — referenced only by tests if/when we add one.
export const __TEST_INTERNALS__ = { STATUS_BUCKETS, accumulate, blankStatusBreakdown };

// Eslint placation: mongoose import is here for the Schema.Types reference
// if we extend this service to do server-side aggregation later. Keeping
// the import documents the intent.
void mongoose;
