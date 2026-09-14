/**
 * RPT detection — classifies whether a Conflict-of-Interest declaration likely
 * constitutes a Related Party Transaction (AASB 124 / ACNC), and extracts the
 * triggering keywords + a suggested relationship/transaction type.
 *
 * Uses OpenAI when OPENAI_API_KEY is configured (same key as the chatbot);
 * falls back to a keyword scan so it works without a key / when the API errors.
 * Never throws — detection is advisory and must not break the COI page.
 */
import OpenAI from 'openai';
import { logError } from '../utils/logger.js';

// Words/phrases that hint at a related-party transaction. Split so the keyword
// fallback can require BOTH a relationship and a dealing signal.
const RELATIONSHIP_WORDS = [
  'spouse', 'wife', 'husband', 'partner', 'family', 'son', 'daughter', 'brother',
  'sister', 'relative', 'related', 'father', 'mother', 'in-law', 'cousin',
  'director', 'board member', 'trustee', 'responsible person', 'owns', 'owned by',
  'controlled', 'shareholder', 'proprietor', 'his company', 'her company', 'my company',
];
const DEALING_WORDS = [
  'supplier', 'vendor', 'purchase', 'goods', 'services', 'contract', 'contractor',
  'consultant', 'employment', 'employed', 'employ', 'salary', 'wage', 'paid', 'payment',
  'lease', 'rent', 'loan', 'asset', 'sale', 'sell', 'buy', 'bought', 'invoice',
  'procure', 'procurement', 'grant', 'funds', 'fee', 'commission', 'sponsorship',
];

const scan = (text, words) => [...new Set(words.filter((w) => text.includes(w)))];

const RELATIONSHIP_TYPES = ['director', 'responsible_person', 'family_member', 'related_entity', 'staff', 'contractor', 'other'];
const TRANSACTION_TYPES = ['purchase_goods_services', 'provide_funds', 'employment_contractor', 'lease', 'loan', 'asset_transfer', 'other'];

/**
 * @param {{ reason?, personName?, personDetails? }} input  COI text fields.
 * @returns {Promise<{ isLikely, confidence, keywords[], reason, relationshipType, transactionType, source }>}
 */
export async function detectRptFromText({ reason, personName, personDetails } = {}) {
  const text = [personName, personDetails, reason].filter(Boolean).join('. ').trim();
  const lower = text.toLowerCase();
  const relHits = scan(lower, RELATIONSHIP_WORDS);
  const dealHits = scan(lower, DEALING_WORDS);
  const kwAll = [...new Set([...relHits, ...dealHits])];

  if (process.env.OPENAI_API_KEY && text) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 320,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You assess whether a charity Conflict-of-Interest declaration indicates a potential Related Party Transaction (RPT) under AASB 124 / ACNC — i.e. the charity transacts (buys, sells, leases, loans, employs, pays, grants funds) with a party connected to a director, responsible person, their family, or an entity they control. A mere disclosed relationship with NO actual or anticipated dealing is NOT an RPT. Respond ONLY with strict JSON.',
          },
          {
            role: 'user',
            content:
              `COI declaration:\n"""${text}"""\n\nReturn JSON exactly:\n{"isLikely": boolean, "confidence": "low"|"medium"|"high", "keywords": string[], "reason": "one plain-English sentence", "relationshipType": ${JSON.stringify(RELATIONSHIP_TYPES)} or null, "transactionType": ${JSON.stringify(TRANSACTION_TYPES)} or null}`,
          },
        ],
      });
      const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
      const aiLikely = !!parsed.isLikely;
      return {
        isLikely: aiLikely,
        // A related party is named but no dealing was detected — not an RPT, but
        // worth a soft "confirm whether a transaction is involved" nudge.
        relationshipOnly: !aiLikely && relHits.length > 0,
        relationshipWords: relHits,
        confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : (aiLikely ? 'medium' : 'low'),
        keywords: Array.isArray(parsed.keywords) && parsed.keywords.length ? parsed.keywords.slice(0, 8) : kwAll,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        relationshipType: RELATIONSHIP_TYPES.includes(parsed.relationshipType) ? parsed.relationshipType : null,
        transactionType: TRANSACTION_TYPES.includes(parsed.transactionType) ? parsed.transactionType : null,
        source: 'ai',
      };
    } catch (err) {
      logError('RPT detection: OpenAI failed, using keyword fallback', { error: err?.message });
      // fall through to keyword fallback
    }
  }

  // Keyword fallback: likely when there's both a relationship and a dealing word.
  const isLikely = relHits.length > 0 && dealHits.length > 0;
  return {
    isLikely,
    // Relationship named but no dealing → soft nudge, not a positive detection.
    relationshipOnly: !isLikely && relHits.length > 0,
    relationshipWords: relHits,
    confidence: isLikely ? (relHits.length + dealHits.length >= 4 ? 'medium' : 'low') : 'low',
    keywords: kwAll,
    reason: isLikely
      ? `Mentions ${[...relHits, ...dealHits].slice(0, 4).join(', ')} — suggests a dealing with a related party.`
      : '',
    relationshipType: null,
    transactionType: null,
    source: 'keywords',
  };
}
