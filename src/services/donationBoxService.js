import { DonationBoxRepository } from '../repositories/donationBoxRepository.js';
import { AppError } from '../middleware/errorHandler.js';

const toNumber = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Normalize legacy entries (before workflow fields existed). */
function effectiveWorkflowStatus(entry) {
  if (entry?.workflow_status) return entry.workflow_status;
  if (Array.isArray(entry?.proof_files) && entry.proof_files.length > 0) return 'completed';
  return 'awaiting_deposit';
}

const sameUser = (a, b) => a != null && b != null && String(a) === String(b);

export class DonationBoxService {
  constructor(orgId, tenantDb) {
    this.orgId = orgId;
    this.repo = new DonationBoxRepository(tenantDb);
  }

  async createBox(payload, userId) {
    const { name, location, category, source_type, description } = payload || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError('Collection point name is required', 400, 'VALIDATION_ERROR');
    }

    // Category — defaults to donation_box to keep existing clients working
    const VALID_CATEGORIES = ['donation_box', 'miscellaneous'];
    const categoryValue = VALID_CATEGORIES.includes(category) ? category : 'donation_box';

    // Location — required only for physical donation boxes
    const latNum = toNumber(location?.lat);
    const lngNum = toNumber(location?.lng);
    const locationBlock = {};
    if (latNum !== null) locationBlock.lat = latNum;
    if (lngNum !== null) locationBlock.lng = lngNum;
    locationBlock.address = typeof location?.address === 'string' ? location.address : '';

    if (categoryValue === 'donation_box') {
      if (latNum === null || lngNum === null) {
        throw new AppError('Donation box location lat/lng are required', 400, 'VALIDATION_ERROR');
      }
    }

    // Miscellaneous metadata
    const VALID_SOURCE_TYPES = ['fundraising_event', 'online_fundraise', 'in_person_appeal', 'workplace_giving', 'other'];
    const doc = {
      org_id: this.orgId,
      name: name.trim(),
      status: 'active',
      category: categoryValue,
      description: typeof description === 'string' ? description.trim() : '',
      location: locationBlock,
      created_by: userId,
    };
    if (categoryValue === 'miscellaneous' && VALID_SOURCE_TYPES.includes(source_type)) {
      doc.source_type = source_type;
    }

    const box = await this.repo.create(doc);
    return box;
  }

  async listBoxes({ status = 'active', search = '' } = {}) {
    return this.repo.list({ orgId: this.orgId, status, search });
  }

  async getBox({ boxId }) {
    const box = await this.repo.findById({ orgId: this.orgId, boxId });
    if (!box) throw new AppError('Donation box not found', 404, 'NOT_FOUND');
    return box;
  }

  /**
   * New collection entry: collector acknowledges on submit; no deposit slip yet.
   * Optional second counter → extra acknowledgement step before office.
   */
  async addEntry({ boxId, payload, userId }) {
    // We need the parent record's category to decide which rules apply.
    const parent = await this.repo.findById({ orgId: this.orgId, boxId });
    if (!parent) throw new AppError('Cash-handling record not found', 404, 'NOT_FOUND');
    const parentCategory = parent.category || 'donation_box';
    const isBox = parentCategory === 'donation_box';

    const entry_date = payload?.entry_date;
    if (!entry_date || Number.isNaN(new Date(entry_date).getTime())) {
      throw new AppError('entry_date is required', 400, 'VALIDATION_ERROR');
    }

    // Amount resolution:
    //   donation_box  → `amount` is authoritative (existing behaviour)
    //   miscellaneous → `gross_amount` is authoritative; falls back to `amount` if the caller
    //                   still sends the old field. `amount` on the stored entry always carries
    //                   the net figure so downstream totals keep working.
    const amountNum = toNumber(payload?.amount);
    const grossNum = toNumber(payload?.gross_amount);
    const expensesNum = toNumber(payload?.expenses);
    const netPayloadNum = toNumber(payload?.net_amount);
    const tipsNum = toNumber(payload?.tips_count ?? 0);

    let effectiveGross = null;
    let effectiveExpenses = 0;
    let effectiveNet = null;

    if (isBox) {
      if (amountNum === null || amountNum < 0) {
        throw new AppError('amount must be a non-negative number', 400, 'VALIDATION_ERROR');
      }
      if (tipsNum === null || tipsNum < 0) {
        throw new AppError('tips_count must be a non-negative number', 400, 'VALIDATION_ERROR');
      }
      effectiveNet = amountNum;
    } else {
      effectiveGross = grossNum !== null ? grossNum : amountNum;
      if (effectiveGross === null || effectiveGross < 0) {
        throw new AppError('gross_amount is required for miscellaneous entries', 400, 'VALIDATION_ERROR');
      }
      effectiveExpenses = expensesNum !== null && expensesNum >= 0 ? expensesNum : 0;
      effectiveNet = netPayloadNum !== null
        ? netPayloadNum
        : Math.max(0, effectiveGross - effectiveExpenses);
    }

    const ack = payload?.collector_acknowledgement;
    if (ack !== true && ack !== 'true') {
      throw new AppError(
        'The collector must acknowledge this collection before saving.',
        400,
        'COLLECTOR_ACK_REQUIRED'
      );
    }

    // box_still_at_location only applies to physical boxes. Miscellaneous records default
    // to `true` — the collection source continues to exist unless manually retired.
    const boxStillRaw = payload?.box_still_at_location;
    const boxStillBool =
      boxStillRaw === true || boxStillRaw === false
        ? boxStillRaw
        : boxStillRaw === 'true'
          ? true
          : boxStillRaw === 'false'
            ? false
            : null;
    if (isBox && boxStillBool === null) {
      throw new AppError('box_still_at_location is required (true or false).', 400, 'VALIDATION_ERROR');
    }
    const boxStillFinal = isBox ? boxStillBool : true;

    const secondCounted =
      payload?.second_person_counted === true ||
      payload?.second_person_counted === 'true';
    const secondCounterId = payload?.second_counter_user_id || payload?.secondCounterUserId || null;

    if (secondCounted) {
      if (!secondCounterId) {
        throw new AppError(
          'When a second person counted the cash, select who performed the count.',
          400,
          'SECOND_COUNTER_REQUIRED'
        );
      }
      if (sameUser(secondCounterId, userId)) {
        throw new AppError(
          'The second counter must be a different person from the collector.',
          400,
          'VALIDATION_ERROR'
        );
      }
    }

    // Miscellaneous-only metadata — carried through only when the parent is miscellaneous.
    const VALID_PAYMENT_METHODS = ['cash', 'card', 'online', 'mixed', 'other'];
    const miscMeta = {};
    if (!isBox) {
      miscMeta.gross_amount = effectiveGross;
      miscMeta.expenses = effectiveExpenses;
      miscMeta.net_amount = effectiveNet;
      const partNum = toNumber(payload?.participant_count);
      if (partNum !== null && partNum >= 0) miscMeta.participant_count = partNum;
      if (VALID_PAYMENT_METHODS.includes(payload?.payment_method)) miscMeta.payment_method = payload.payment_method;
      if (typeof payload?.platform === 'string' && payload.platform.trim()) miscMeta.platform = payload.platform.trim();
      if (payload?.period_start && !Number.isNaN(new Date(payload.period_start).getTime())) miscMeta.period_start = new Date(payload.period_start);
      if (payload?.period_end && !Number.isNaN(new Date(payload.period_end).getTime())) miscMeta.period_end = new Date(payload.period_end);
    }

    const collectorId = userId;
    const now = new Date();
    let workflowStatus = 'awaiting_office_ack';
    if (secondCounted && secondCounterId) {
      workflowStatus = 'awaiting_second_counter_ack';
    }

    // Optional "expected from receipts" amount — when supplied we persist it
    // alongside the variance so finance can audit cash count discrepancies
    // (e.g. counted $400 vs receipts $500 → variance -$100).
    const expectedNum = toNumber(payload?.expected_amount);
    const countedAmount = isBox ? amountNum : effectiveNet;
    const hasExpected = expectedNum !== null && expectedNum >= 0;
    const variance = hasExpected ? Number((countedAmount - expectedNum).toFixed(2)) : undefined;

    const entry = {
      tips_count: isBox ? tipsNum : 0,
      // `amount` stays the authoritative "money in" figure regardless of category so that
      // downstream reports/totals (list cards, CSV export, CSV reporting, etc.) keep working.
      amount: countedAmount,
      ...(hasExpected ? { expected_amount: expectedNum, variance } : {}),
      entry_date: new Date(entry_date),
      notes: typeof payload?.notes === 'string' ? payload.notes : '',
      box_still_at_location: boxStillFinal,
      collector_id: collectorId,
      collector_acknowledged_at: now,
      collector_acknowledged_by: userId,
      second_person_counted: !!secondCounted,
      second_counter_user_id: secondCounted ? secondCounterId : null,
      workflow_status: workflowStatus,
      proof_status: 'pending',
      proof_assigned_to: null,
      proof_files: [],
      proof_added_by: null,
      proof_added_at: null,
      workflow_events: [
        {
          step: 'collector',
          action: 'collector_acknowledged',
          at: now,
          actor_id: userId,
          note: isBox ? 'Collection recorded by collector.' : 'Miscellaneous collection recorded.',
        },
      ],
      created_by: userId,
      created_at: now,
      ...miscMeta,
    };
    if (secondCounted && secondCounterId) {
      entry.workflow_events.push({
        step: 'second_counter',
        action: 'second_counter_required',
        at: now,
        actor_id: userId,
        note: 'Awaiting second counter acknowledgement.',
      });
    } else {
      entry.workflow_events.push({
        step: 'office',
        action: 'office_ack_required',
        at: now,
        actor_id: userId,
        note: 'Awaiting office receipt acknowledgement.',
      });
    }

    let box = await this.repo.addEntry({
      orgId: this.orgId,
      boxId,
      entry,
    });

    if (!box) throw new AppError('Donation box not found', 404, 'NOT_FOUND');

    if (boxStillBool === false) {
      box = await this.repo.updateBoxStatus({ orgId: this.orgId, boxId, status: 'inactive' });
    }

    return box;
  }

  async acknowledgeSecondCounter({ boxId, entryId, userId }) {
    const box = await this.repo.findById({ orgId: this.orgId, boxId });
    if (!box) throw new AppError('Donation box not found', 404, 'NOT_FOUND');
    const entry = (box.entries || []).find((e) => String(e._id) === String(entryId));
    if (!entry) throw new AppError('Donation entry not found', 404, 'ENTRY_NOT_FOUND');

    if (effectiveWorkflowStatus(entry) !== 'awaiting_second_counter_ack') {
      throw new AppError('This entry is not awaiting second-counter acknowledgement.', 400, 'WORKFLOW_STATE');
    }
    if (!sameUser(userId, entry.second_counter_user_id)) {
      throw new AppError('Only the nominated second counter can complete this step.', 403, 'FORBIDDEN');
    }

    return this.repo.updateEntryFields({
      orgId: this.orgId,
      boxId,
      entryId,
      fields: {
        workflow_events: [
          ...(Array.isArray(entry.workflow_events) ? entry.workflow_events : []),
          {
            step: 'second_counter',
            action: 'second_counter_acknowledged',
            at: new Date(),
            actor_id: userId,
            note: 'Second counter acknowledged.',
          },
          {
            step: 'office',
            action: 'office_ack_required',
            at: new Date(),
            actor_id: userId,
            note: 'Awaiting office receipt acknowledgement.',
          },
        ],
        second_counter_acknowledged_at: new Date(),
        second_counter_acknowledged_by: userId,
        workflow_status: 'awaiting_office_ack',
      },
    });
  }

  async acknowledgeOfficeReceipt({ boxId, entryId, userId }) {
    const box = await this.repo.findById({ orgId: this.orgId, boxId });
    if (!box) throw new AppError('Donation box not found', 404, 'NOT_FOUND');
    const entry = (box.entries || []).find((e) => String(e._id) === String(entryId));
    if (!entry) throw new AppError('Donation entry not found', 404, 'ENTRY_NOT_FOUND');

    const status = effectiveWorkflowStatus(entry);
    if (status !== 'awaiting_office_ack') {
      throw new AppError('Office receipt can only be acknowledged when that step is pending.', 400, 'WORKFLOW_STATE');
    }

    const collectorRef = entry.collector_id || entry.collector_acknowledged_by;

    // Preferred control: office acknowledgement should be a different person,
    // but do not hard-block small teams.

    return this.repo.updateEntryFields({
      orgId: this.orgId,
      boxId,
      entryId,
      fields: {
        workflow_events: [
          ...(Array.isArray(entry.workflow_events) ? entry.workflow_events : []),
          {
            step: 'office',
            action: 'office_acknowledged',
            at: new Date(),
            actor_id: userId,
            note: sameUser(userId, collectorRef)
              ? 'Office receipt acknowledged by collector (small team exception).'
              : 'Office receipt acknowledged.',
          },
          {
            step: 'deposit',
            action: 'deposit_required',
            at: new Date(),
            actor_id: userId,
            note: 'Awaiting bank deposit slip upload.',
          },
        ],
        office_acknowledged_at: new Date(),
        office_acknowledged_by: userId,
        workflow_status: 'awaiting_deposit',
      },
    });
  }

  async addEntryProof({ boxId, entryId, files, userId }) {
    const normalizedFiles = (Array.isArray(files) ? files : [])
      .map((f) => ({
        name: String(f?.name || f?.file_name || '').trim(),
        url: String(f?.url || '').trim(),
        key: String(f?.key || '').trim(),
        size: Number(f?.size || 0),
        type: String(f?.type || f?.file_type || '').trim(),
        uploaded_at: new Date(),
      }))
      .filter((f) => f.name && f.url);

    if (normalizedFiles.length === 0) {
      throw new AppError('At least one deposit slip / receipt file is required', 400, 'PROOF_REQUIRED');
    }

    const box = await this.repo.findById({ orgId: this.orgId, boxId });
    if (!box) throw new AppError('Donation box not found', 404, 'NOT_FOUND');
    const entry = (box.entries || []).find((e) => String(e._id) === String(entryId));
    if (!entry) throw new AppError('Donation entry not found', 404, 'ENTRY_NOT_FOUND');

    const wf = effectiveWorkflowStatus(entry);
    if (wf !== 'awaiting_deposit') {
      throw new AppError(
        'Bank deposit can only be confirmed after office receipt has been acknowledged.',
        400,
        'WORKFLOW_STATE'
      );
    }

    const assignedTo = entry.proof_assigned_to ? String(entry.proof_assigned_to) : null;
    if (assignedTo && String(assignedTo) !== String(userId)) {
      throw new AppError('Only the assigned user can upload the deposit slip for this entry', 403, 'NOT_ASSIGNED');
    }

    const collectorRef = entry.collector_id || entry.collector_acknowledged_by;

    // Preferred control: depositor should be different from collector,
    // but allow same user when no alternate staff is available.

    const now = new Date();
    return this.repo.updateEntryFields({
      orgId: this.orgId,
      boxId,
      entryId,
      fields: {
        workflow_events: [
          ...(Array.isArray(entry.workflow_events) ? entry.workflow_events : []),
          {
            step: 'deposit',
            action: 'deposit_confirmed',
            at: now,
            actor_id: userId,
            note: sameUser(userId, collectorRef)
              ? 'Deposit confirmed by collector (small team exception).'
              : 'Deposit confirmed with deposit slip.',
          },
        ],
        proof_status: 'submitted',
        proof_files: normalizedFiles,
        proof_added_by: userId,
        proof_added_at: now,
        deposit_confirmed_at: now,
        deposit_confirmed_by: userId,
        entry_closed_at: now,
        entry_closed_by: userId,
        workflow_status: 'completed',
      },
    });
  }

  async assignEntryProof({ boxId, entryId, assignedToUserId, userId }) {
    const box = await this.repo.findById({ orgId: this.orgId, boxId });
    if (!box) throw new AppError('Donation box not found', 404, 'NOT_FOUND');
    const entry = (box.entries || []).find((e) => String(e._id) === String(entryId));
    if (!entry) throw new AppError('Donation entry not found', 404, 'ENTRY_NOT_FOUND');

    if (effectiveWorkflowStatus(entry) !== 'awaiting_deposit') {
      throw new AppError(
        'Deposit slip assignment is only available while the entry is awaiting bank deposit confirmation.',
        400,
        'WORKFLOW_STATE'
      );
    }

    const updated = await this.repo.updateEntryProof({
      orgId: this.orgId,
      boxId,
      entryId,
      update: {
        proof_status: entry.proof_files?.length ? 'submitted' : 'pending',
        proof_files: entry.proof_files || [],
        proof_added_by: entry.proof_added_by || null,
        proof_added_at: entry.proof_added_at || null,
        proof_assigned_to: assignedToUserId || null,
      },
    });

    return updated;
  }
}
