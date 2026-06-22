/**
 * Related Party Transaction service — risk assessment.
 *
 * Materiality is NOT hardcoded; it is classified against the org's configured
 * Approval Thresholds (petty_cash / low_cash / moderate_cash / high_cash) via
 * ApprovalThresholdRepository.getTierForAmount. Overall risk = the highest of
 * the contributing factors (relationship, value band, competitive quotes), which
 * implements the governance rule "any high factor makes the transaction high
 * risk" (e.g. a director-related dealing is high risk regardless of value).
 */

import { ApprovalThresholdRepository } from '../repositories/approvalThresholdRepository.js';

const LEVEL_RANK = { low: 1, medium: 2, high: 3 };

// Relationship → inherent risk. Insiders and entities they control are highest.
const RELATIONSHIP_LEVEL = {
  director: 'high',
  responsible_person: 'high',
  family_member: 'high',
  related_entity: 'high',
  contractor: 'medium',
  staff: 'medium',
  other: 'low'
};

const RELATIONSHIP_LABEL = {
  director: 'Director-related',
  responsible_person: 'Responsible-person-related',
  family_member: 'Family-member-related',
  related_entity: 'Related-entity-controlled',
  contractor: 'Contractor-related',
  staff: 'Staff-related',
  other: 'Other relationship'
};

// Approval-threshold tier → risk level.
const BAND_LEVEL = {
  petty_cash: 'low',
  low_cash: 'low',
  moderate_cash: 'medium',
  high_cash: 'high'
};

const BAND_LABEL = {
  petty_cash: 'Petty cash',
  low_cash: 'Low cash',
  moderate_cash: 'Moderate cash',
  high_cash: 'High cash'
};

const maxLevel = (levels) =>
  levels.reduce((acc, l) => (LEVEL_RANK[l] > LEVEL_RANK[acc] ? l : acc), 'low');

/** Classify a transaction value into the org's threshold band (or null). */
export async function classifyValueBand(tenantDb, orgDocId, value) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return null;
  try {
    const repo = new ApprovalThresholdRepository(tenantDb);
    return await repo.getTierForAmount(orgDocId, Number(value));
  } catch {
    return null;
  }
}

/**
 * Assess a related party transaction's risk.
 * Returns the fields to persist: value_band, risk_level, risk_factors,
 * requires_board_review, requires_audit_committee_review.
 */
export async function assessRisk(tenantDb, orgDocId, { relationshipType, transactionValue, competitiveQuotesObtained }) {
  const factors = [];

  const relLevel = RELATIONSHIP_LEVEL[relationshipType] || 'low';
  factors.push({ factor: 'relationship', level: relLevel, detail: RELATIONSHIP_LABEL[relationshipType] || 'Relationship' });

  const band = await classifyValueBand(tenantDb, orgDocId, transactionValue);
  let valueLevel = 'low';
  if (band) {
    valueLevel = BAND_LEVEL[band] || 'low';
    factors.push({ factor: 'value', level: valueLevel, detail: `Value band: ${BAND_LABEL[band] || band}` });
  }

  // No competitive quotes is a red flag — but only meaningful when money changes
  // hands (a procurement context).
  if (transactionValue !== null && transactionValue !== undefined && transactionValue !== '' && !competitiveQuotesObtained) {
    factors.push({ factor: 'competitive_quotes', level: 'high', detail: 'No competitive quotes obtained' });
  }

  const overall = maxLevel(factors.map((f) => f.level));

  return {
    value_band: band,
    risk_level: overall,
    risk_factors: factors,
    requires_board_review: overall === 'high' || valueLevel === 'high',
    requires_audit_committee_review: overall === 'high'
  };
}
