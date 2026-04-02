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
    const { name, location } = payload || {};
    const lat = location?.lat;
    const lng = location?.lng;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError('Donation box name is required', 400, 'VALIDATION_ERROR');
    }
    const latNum = toNumber(lat);
    const lngNum = toNumber(lng);
    if (latNum === null || lngNum === null) {
      throw new AppError('Donation box location lat/lng are required', 400, 'VALIDATION_ERROR');
    }

    const box = await this.repo.create({
      org_id: this.orgId,
      name: name.trim(),
      status: 'active',
      location: {
        lat: latNum,
        lng: lngNum,
        address: typeof location?.address === 'string' ? location.address : '',
      },
      created_by: userId,
    });

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
    const entry_date = payload?.entry_date;
    const amountNum = toNumber(payload?.amount);
    const tipsNum = toNumber(payload?.tips_count ?? 0);

    if (!entry_date || Number.isNaN(new Date(entry_date).getTime())) {
      throw new AppError('entry_date is required', 400, 'VALIDATION_ERROR');
    }
    if (amountNum === null || amountNum < 0) {
      throw new AppError('amount must be a non-negative number', 400, 'VALIDATION_ERROR');
    }
    if (tipsNum === null || tipsNum < 0) {
      throw new AppError('tips_count must be a non-negative number', 400, 'VALIDATION_ERROR');
    }

    const ack = payload?.collector_acknowledgement;
    if (ack !== true && ack !== 'true') {
      throw new AppError(
        'The collector must acknowledge this collection before saving.',
        400,
        'COLLECTOR_ACK_REQUIRED'
      );
    }

    const boxStillRaw = payload?.box_still_at_location;
    const boxStillBool =
      boxStillRaw === true || boxStillRaw === false
        ? boxStillRaw
        : boxStillRaw === 'true'
          ? true
          : boxStillRaw === 'false'
            ? false
            : null;
    if (boxStillBool === null) {
      throw new AppError('box_still_at_location is required (true or false).', 400, 'VALIDATION_ERROR');
    }

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

    const collectorId = userId;
    const now = new Date();
    let workflowStatus = 'awaiting_office_ack';
    if (secondCounted && secondCounterId) {
      workflowStatus = 'awaiting_second_counter_ack';
    }

    const entry = {
      tips_count: tipsNum,
      amount: amountNum,
      entry_date: new Date(entry_date),
      notes: typeof payload?.notes === 'string' ? payload.notes : '',
      box_still_at_location: boxStillBool,
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
          note: 'Collection recorded by collector.',
        },
      ],
      created_by: userId,
      created_at: now,
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
