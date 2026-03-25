import { DonationBoxRepository } from '../repositories/donationBoxRepository.js';
import { AppError } from '../middleware/errorHandler.js';

const toNumber = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

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

  async addEntry({ boxId, payload, userId }) {
    const entry_date = payload?.entry_date;
    const amountNum = toNumber(payload?.amount);
    const tipsNum = toNumber(payload?.tips_count ?? 0);

    if (!entry_date || Number.isNaN(new Date(entry_date).getTime())) {
      throw new AppError('entry_date is required', 400, 'VALIDATION_ERROR');
    }
    if (amountNum === null || amountNum < 0) {
      throw new AppError('amount must be a positive number', 400, 'VALIDATION_ERROR');
    }
    if (tipsNum === null || tipsNum < 0) {
      throw new AppError('tips_count must be a positive number', 400, 'VALIDATION_ERROR');
    }

    const box = await this.repo.addEntry({
      orgId: this.orgId,
      boxId,
      entry: {
        tips_count: tipsNum,
        amount: amountNum,
        entry_date: new Date(entry_date),
        notes: typeof payload?.notes === 'string' ? payload.notes : '',
        created_by: userId,
        created_at: new Date(),
      },
    });

    if (!box) throw new AppError('Donation box not found', 404, 'NOT_FOUND');
    return box;
  }
}

