/**
 * Approval Flowchart SVG Generator
 * 
 * Generates a visual flowchart of the approval journey similar to the UI:
 * - Submitted card
 * - Approval steps with statuses
 * - Connectors with visual indicators
 * - Special markers (restarted, re-attempt, escalations, etc.)
 */

const formatDate = (date) => {
  if (!date) return '—';
  try {
    return new Date(date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
};

const COLORS = {
  navy: '#132e5e',
  approved: '#10b981',
  rejected: '#ef4444',
  pending: '#94a3b8',
  amber: '#f59e0b',
  purple: '#7c3aed',
};

/**
 * Convert snake_case to Title Case for display
 */
const formatSnakeCase = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Generate HTML flowchart for approval journey with full details
 * @param {Object} approvalRequest - The approval request object
 * @returns {string} HTML string
 */
export function generateApprovalFlowchart(approvalRequest) {
  if (!approvalRequest) return '';

  const steps = approvalRequest.approval_steps || [];
  const previousAttempts = approvalRequest.previous_attempts || [];
  const escalations = approvalRequest.escalations || [];
  const rejectionReviews = approvalRequest.rejection_reviews || [];
  
  // If no steps, return empty
  if (steps.length === 0) {
    return '<p style="text-align:center;color:#94a3b8;padding:20px;">No approval steps defined</p>';
  }

  let html = `<div style="font-family: Poppins, Helvetica, Arial, sans-serif; background: #fafbfc; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0;">`;

  // ═══ SVG Flowchart Cards ════════════════════════════════
  html += generateFlowchartSVG(approvalRequest, steps, previousAttempts);

  // ═══ Complete Approval Trail (All Decisions, Notes & Attachments) ════════
  html += `<div style="margin-top: 20px; border-top: 2px solid #cbd5e1; padding-top: 16px;">
    <h3 style="font-size: 12px; font-weight: bold; color: #1f2937; margin-bottom: 12px;">📋 Complete Approval Trail</h3>`;

  // Show all approval steps in chronological order
  steps.forEach((step, stepIdx) => {
    const approverName = step.approver_user_id?.first_name 
      ? `${step.approver_user_id.first_name} ${step.approver_user_id.last_name || ''}`
      : step.approver_position_id?.title || 'Approver';
    
    const approverTitle = step.approver_position_id?.title || 
                         step.approver_department_id?.name || '';

    // APPROVED STEP
    if (step.status === 'approved') {
      html += `
        <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; padding: 12px; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="display: inline-block; width: 20px; height: 20px; border-radius: 50%; background: #10b981; color: white; text-align: center; line-height: 20px; font-size: 11px; font-weight: bold;">✓</span>
            <strong style="color: #047857;">Approved by ${escapeHtml(approverName)}</strong>
            <span style="color: #059669; font-size: 11px; margin-left: auto;">${formatDate(step.approved_at)}</span>
          </div>
          ${approverTitle ? `<div style="color: #047857; font-size: 10px; margin-bottom: 4px;"><strong>Position:</strong> ${escapeHtml(approverTitle)}</div>` : ''}
          ${step.comments ? `<div style="color: #047857; font-size: 10px; margin-bottom: 6px;"><strong>Comments:</strong> ${escapeHtml(step.comments)}</div>` : ''}
          ${step.acknowledgement_files && step.acknowledgement_files.length > 0 ? renderAttachmentsList(step.acknowledgement_files, '#047857', 'rgba(16, 185, 129, 0.05)') : ''}
        </div>
      `;
    }

    // REJECTED STEP
    if (step.status === 'rejected') {
      html += `
        <div style="background: #fee2e2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="display: inline-block; width: 20px; height: 20px; border-radius: 50%; background: #ef4444; color: white; text-align: center; line-height: 20px; font-size: 12px; font-weight: bold;">✕</span>
            <strong style="color: #991b1b;">Declined by ${escapeHtml(approverName)}</strong>
            <span style="color: #7f1d1d; font-size: 11px; margin-left: auto;">${formatDate(step.rejected_at)}</span>
          </div>
          ${approverTitle ? `<div style="color: #991b1b; font-size: 10px; margin-bottom: 4px;"><strong>Position:</strong> ${escapeHtml(approverTitle)}</div>` : ''}
          ${step.rejection_reason ? `<div style="color: #991b1b; font-size: 10px; margin-bottom: 6px;"><strong>Reason:</strong> ${escapeHtml(step.rejection_reason)}</div>` : ''}
          ${step.comments ? `<div style="color: #991b1b; font-size: 10px; margin-bottom: 6px;"><strong>Comments:</strong> ${escapeHtml(step.comments)}</div>` : ''}
          ${step.acknowledgement_files && step.acknowledgement_files.length > 0 ? renderAttachmentsList(step.acknowledgement_files, '#991b1b', 'rgba(239, 68, 68, 0.05)') : ''}
          ${Array.isArray(step.rejection_reviews) && step.rejection_reviews.length > 0 ? `
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #fecaca;">
              <div style="color: #991b1b; font-size: 10px; font-weight: bold; margin-bottom: 6px;">📤 Rejection Review Trail:</div>
              ${renderRejectionReviews(step.rejection_reviews)}
            </div>
          ` : ''}
        </div>
      `;
    }
  });

  // ESCALATIONS (grouped separately for visibility)
  if (escalations.length > 0 || rejectionReviews.length > 0) {
    html += `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #fcd34d;">
      <h4 style="font-size: 11px; font-weight: bold; color: #b45309; margin-bottom: 8px;">⚠️ Escalations & Reviews</h4>`;
    
    // Show request-level escalations
    escalations.forEach((esc, escIdx) => {
      const escalatedByName = esc.escalated_by?.first_name 
        ? `${esc.escalated_by.first_name} ${esc.escalated_by.last_name || ''}`
        : 'System';
      
      const escalatedToName = esc.escalated_to?.first_name
        ? `${esc.escalated_to.first_name} ${esc.escalated_to.last_name || ''}`
        : typeof esc.escalated_to === 'string' ? esc.escalated_to : 'Reviewer';

      html += `
        <div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px; padding: 12px; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="display: inline-block; width: 20px; height: 20px; border-radius: 50%; background: #f59e0b; color: white; text-align: center; line-height: 20px; font-size: 12px; font-weight: bold;">!</span>
            <strong style="color: #b45309;">Escalated for Further Review</strong>
            <span style="color: #92400e; font-size: 11px; margin-left: auto;">${formatDate(esc.escalated_at)}</span>
          </div>
          <div style="color: #b45309; font-size: 10px;"><strong>By:</strong> ${escapeHtml(escalatedByName)}</div>
          <div style="color: #b45309; font-size: 10px; margin-bottom: 6px;"><strong>To:</strong> ${escapeHtml(escalatedToName)}</div>
          ${esc.reason ? `<div style="color: #92400e; font-size: 10px; margin-bottom: 6px;"><strong>Reason:</strong> ${escapeHtml(esc.reason)}</div>` : ''}
          ${esc.escalation_notes ? `<div style="color: #92400e; font-size: 10px; margin-bottom: 6px;"><strong>Notes:</strong> ${escapeHtml(esc.escalation_notes)}</div>` : ''}
          ${esc.escalation_files && esc.escalation_files.length > 0 ? renderAttachmentsList(esc.escalation_files, '#92400e', 'rgba(245, 158, 11, 0.05)') : ''}
          ${esc.response_status ? `<div style="color: #b45309; font-size: 10px; margin-top: 6px;"><strong>Status:</strong> ${escapeHtml(formatSnakeCase(esc.response_status))}</div>` : ''}
          ${esc.response_notes ? `<div style="color: #b45309; font-size: 10px; margin-top: 3px;"><strong>Response:</strong> ${escapeHtml(esc.response_notes)}</div>` : ''}
          ${esc.responded_at ? `<div style="color: #92400e; font-size: 9px; margin-top: 3px;"><strong>Responded:</strong> ${formatDate(esc.responded_at)}</div>` : ''}
        </div>
      `;
    });

    // Show request-level rejection reviews
    if (rejectionReviews.length > 0) {
      html += `<div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px; padding: 12px; margin-bottom: 10px;">
        <div style="color: #b45309; font-size: 11px; font-weight: bold; margin-bottom: 8px;">📋 Rejection Review</div>`;
      
      rejectionReviews.forEach(rr => {
        const rejectedByName = rr.rejected_by?.first_name
          ? `${rr.rejected_by.first_name} ${rr.rejected_by.last_name || ''}`
          : 'Approver';
        
        const reviewedByName = rr.forwarded_to?.first_name
          ? `${rr.forwarded_to.first_name} ${rr.forwarded_to.last_name || ''}`
          : 'Reviewer';

        html += `
          <div style="background: rgba(245, 158, 11, 0.05); padding: 8px; border-radius: 4px; margin-bottom: 6px;">
            <div style="color: #b45309; font-size: 9px;"><strong>Rejected by:</strong> ${escapeHtml(rejectedByName)}</div>
            <div style="color: #b45309; font-size: 9px;"><strong>Reviewed by:</strong> ${escapeHtml(reviewedByName)}</div>
            ${rr.review_status ? `<div style="color: #b45309; font-size: 9px;"><strong>Status:</strong> ${escapeHtml(formatSnakeCase(rr.review_status))}</div>` : ''}
            ${rr.review_action ? `<div style="color: #b45309; font-size: 9px;"><strong>Action:</strong> ${escapeHtml(formatSnakeCase(rr.review_action))}</div>` : ''}
            ${rr.review_comments ? `<div style="color: #b45309; font-size: 9px; margin-top: 3px;"><strong>Notes:</strong> ${escapeHtml(rr.review_comments)}</div>` : ''}
            ${rr.rejection_files && rr.rejection_files.length > 0 ? renderAttachmentsList(rr.rejection_files, '#b45309', 'rgba(245, 158, 11, 0.1)') : ''}
          </div>
        `;
      });

      html += `</div>`;
    }

    html += `</div>`;
  }

  html += `</div></div>`;
  return html;
}

/**
 * Generate SVG flowchart showing step progression
 */
function generateFlowchartSVG(approvalRequest, steps, previousAttempts) {
  const cardWidth = 120;
  const cardHeight = 70;
  const cardSpacing = 16;
  const totalWidth = Math.max(900, (steps.length + 1) * cardWidth + (steps.length) * cardSpacing + 80);
  const totalHeight = 150;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" preserveAspectRatio="xMinYMid meet" style="display: block; margin: 0 auto;">`;
  svg += `<rect width="${totalWidth}" height="${totalHeight}" fill="#ffffff" rx="8" />`;

  let xPos = 40;
  const yPos = 35;

  // ═══ Step 0: Submitted ═══════════════════════════════════════
  const submittedBy = approvalRequest.submitted_by?.first_name 
    ? `${approvalRequest.submitted_by.first_name} ${approvalRequest.submitted_by.last_name || ''}`
    : 'Submitted';
  
  svg += drawApprovalCard({
    x: xPos,
    y: yPos,
    width: cardWidth,
    height: cardHeight,
    status: 'submitted',
    title: 'Submitted',
    subtitle: submittedBy,
    date: formatDate(approvalRequest.created_at),
    position: '',
  });

  xPos += cardWidth + cardSpacing;

  // Draw connector
  if (steps.length > 0) {
    svg += drawConnector(xPos - cardSpacing, yPos + cardHeight / 2, cardSpacing, COLORS.navy);
  }

  // ═══ Check for restart banner ════════════════════════════════
  let hasRestart = previousAttempts.length > 0;

  // ═══ Approval Steps ════════════════════════════════════════════
  steps.forEach((step, index) => {
    const isApproved = step.status === 'approved';
    const isRejected = step.status === 'rejected';
    const isCurrent = approvalRequest.status === 'pending' && 
                     steps.slice(0, index).every(s => s.status === 'approved');
    
    let status = 'pending';
    if (isApproved) status = 'approved';
    if (isRejected) status = 'rejected';
    if (isCurrent) status = 'current';

    // Check if this step was re-attempted
    let wasReAttempted = false;
    if (previousAttempts.length > 0) {
      const prevAttemptSteps = previousAttempts[previousAttempts.length - 1].steps_snapshot || [];
      const prevStep = prevAttemptSteps[index];
      wasReAttempted = prevStep && (prevStep.status === 'rejected' || prevStep.status === 'pending');
    }

    const stepNumber = steps.slice(0, index).filter(s => !s.is_department_head).length + 1;
    const isDeptHead = step.is_department_head === true;
    const title = isDeptHead ? 'Dept Head' : `Step ${stepNumber}`;
    
    const approverName = step.approver_user_id?.first_name 
      ? `${step.approver_user_id.first_name} ${step.approver_user_id.last_name || ''}`
      : step.approver_position_id?.title || 'Approver';
    
    const position = step.approver_position_id?.title || 
                    step.approver_department_id?.name || '';

    const dateStr = isApproved 
      ? formatDate(step.approved_at)
      : isRejected 
        ? formatDate(step.rejected_at || step.approved_at)
        : 'Pending';

    svg += drawApprovalCard({
      x: xPos,
      y: yPos,
      width: cardWidth,
      height: cardHeight,
      status,
      title,
      subtitle: approverName,
      date: dateStr,
      position,
      hasReAttempt: wasReAttempted,
    });

    // Draw connector to next step
    if (index < steps.length - 1) {
      xPos += cardWidth + cardSpacing;
      svg += drawConnector(xPos - cardSpacing, yPos + cardHeight / 2, cardSpacing, 
        isApproved ? COLORS.approved : '#cbd5e1');
    } else {
      xPos += cardWidth + cardSpacing;
    }
  });

  // ═══ Restart Banner (if applicable) ═════════════════════════
  if (hasRestart) {
    svg += `
      <rect x="40" y="${yPos + cardHeight + 10}" width="${totalWidth - 80}" height="22" rx="4" fill="#fef3c7" stroke="#fcd34d" stroke-width="1"/>
      <text x="50" y="${yPos + cardHeight + 26}" font-size="10" font-weight="bold" fill="#b45309" font-family="Poppins, sans-serif">
        ↻ RESUBMISSION — WORKFLOW RUNNING AGAIN
      </text>
    `;
  }

  svg += '</svg>';
  return svg;
}

/**
 * Draw a single approval step card
 */
function drawApprovalCard({ x, y, width, height, status, title, subtitle, date, position, hasReAttempt }) {
  let bgColor = '#f3f4f6';
  let borderColor = '#e5e7eb';
  let textColor = '#6b7280';

  if (status === 'approved') {
    bgColor = '#d1fae5';
    borderColor = COLORS.approved;
    textColor = '#047857';
  } else if (status === 'rejected') {
    bgColor = '#fee2e2';
    borderColor = COLORS.rejected;
    textColor = '#991b1b';
  } else if (status === 'current') {
    bgColor = `${COLORS.navy}10`;
    borderColor = COLORS.navy;
    textColor = COLORS.navy;
  } else if (status === 'submitted') {
    bgColor = COLORS.navy;
    borderColor = COLORS.navy;
    textColor = '#ffffff';
  }

  // If re-attempt, use amber border
  if (hasReAttempt && status !== 'submitted') {
    borderColor = '#f59e0b';
  }

  let svg = `
    <g>
      <!-- Card background and border -->
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="${bgColor}" stroke="${borderColor}" stroke-width="1.5"/>
      
      <!-- Status icon -->
      <g transform="translate(${x + 5}, ${y + 5})">
  `;

  if (status === 'approved') {
    svg += `
      <circle cx="4.5" cy="4.5" r="4.5" fill="${borderColor}"/>
      <path d="M 1.5 4.5 L 3 6 L 7 2" stroke="#ffffff" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  } else if (status === 'rejected') {
    svg += `
      <circle cx="4.5" cy="4.5" r="4.5" fill="${borderColor}"/>
      <path d="M 0.5 0.5 L 8.5 8.5 M 8.5 0.5 L 0.5 8.5" stroke="#ffffff" stroke-width="1" stroke-linecap="round"/>
    `;
  } else if (status === 'current') {
    svg += `
      <circle cx="4.5" cy="4.5" r="4.5" fill="${borderColor}"/>
      <circle cx="4.5" cy="4.5" r="2" fill="#ffffff"/>
    `;
  } else if (status === 'submitted') {
    svg += `
      <circle cx="4.5" cy="4.5" r="4.5" fill="#ffffff" opacity="0.25"/>
      <path d="M 1.5 4.5 L 3 6 L 7 2" stroke="#ffffff" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  }

  svg += `
      </g>
      
      <!-- Title -->
      <text x="${x + 20}" y="${y + 13}" font-size="9" font-weight="bold" fill="${textColor}" font-family="Poppins, sans-serif" text-anchor="start">
        ${escapeHtml(title)}
      </text>
      
      <!-- Subtitle (Name) -->
      <text x="${x + 5}" y="${y + 25}" font-size="7" fill="${textColor}" font-family="Poppins, sans-serif" text-anchor="start">
        ${escapeHtml(truncate(subtitle, 12))}
      </text>
      
      <!-- Date -->
      <text x="${x + 5}" y="${y + height - 4}" font-size="6.5" fill="${textColor}" opacity="0.6" font-family="Poppins, sans-serif" text-anchor="start">
        ${escapeHtml(date)}
      </text>
      
      <!-- RE-ATTEMPT Badge -->
      ${hasReAttempt ? `
      <rect x="${x + width - 33}" y="${y + 2}" width="30" height="14" rx="2" fill="#f59e0b" opacity="0.2" stroke="#f59e0b" stroke-width="0.5"/>
      <text x="${x + width - 17}" y="${y + 11}" font-size="6" font-weight="bold" fill="#b45309" font-family="Poppins, sans-serif" text-anchor="middle">
        RE-ATTEMPT
      </text>
      ` : ''}
    </g>
  `;

  return svg;
}

/**
 * Render rejection review information with all attachments
 */
function renderRejectionReviews(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return '';
  
  let html = '';
  reviews.forEach((review, reviewIdx) => {
    const reviewerName = review.forwarded_to?.first_name 
      ? `${review.forwarded_to.first_name} ${review.forwarded_to.last_name || ''}`
      : typeof review.forwarded_to === 'string' ? review.forwarded_to : 'reviewer';
    
    const hasFiles = Array.isArray(review.rejection_files) && review.rejection_files.length > 0;
    
    html += `
      <div style="margin-top: 8px; padding: 8px; background: rgba(239, 68, 68, 0.05); border-left: 2px solid #ef4444; border-radius: 2px;">
        <div style="color: #7f1d1d; font-size: 10px;"><strong>➜ Forwarded to ${escapeHtml(reviewerName)}</strong></div>
        ${review.review_decision ? `<div style="color: #991b1b; font-size: 10px; margin-top: 3px;"><strong>Decision:</strong> ${escapeHtml(review.review_decision.toUpperCase())}</div>` : ''}
        ${review.review_notes ? `<div style="color: #991b1b; font-size: 10px; margin-top: 3px;"><strong>Notes:</strong> ${escapeHtml(review.review_notes)}</div>` : ''}
        ${review.reviewed_at ? `<div style="color: #7f1d1d; font-size: 9px; margin-top: 3px;"><strong>Reviewed:</strong> ${formatDate(review.reviewed_at)}</div>` : ''}
        ${hasFiles ? renderAttachmentsList(review.rejection_files, '#991b1b') : ''}
      </div>
    `;
  });
  
  return html;
}

/**
 * Render attachments as clickable links
 */
function renderAttachmentsList(files, textColor = '#6b7280', bgColor = 'rgba(0,0,0,0.02)') {
  if (!Array.isArray(files) || files.length === 0) return '';
  
  let html = `<div style="margin-top: 6px; padding: 6px; background: ${bgColor}; border-radius: 3px;">
    <div style="color: ${textColor}; font-size: 9px; font-weight: bold; margin-bottom: 4px;">📎 Attachments:</div>`;
  
  files.forEach(file => {
    const filename = file.name || file.key?.split('/').pop() || 'Document';
    const filesize = file.size ? ` (${formatFileSize(file.size)})` : '';
    const fileUrl = file.url || file.file_url || '';
    
    if (fileUrl) {
      html += `<div style="color: ${textColor}; font-size: 8px; margin: 2px 0;">
        <a href="${escapeHtml(fileUrl)}" style="color: #1e40af; text-decoration: underline; cursor: pointer;" target="_blank">📄 ${escapeHtml(filename)}</a>${filesize}
      </div>`;
    } else {
      html += `<div style="color: ${textColor}; font-size: 8px; margin: 2px 0;">
        📄 ${escapeHtml(filename)}${filesize}
      </div>`;
    }
  });
  
  html += `</div>`;
  return html;
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 10) / 10 + ' ' + sizes[i];
}

/**
 * Truncate text to specified length
 */
function truncate(text, length) {
  if (!text) return '';
  return text.length > length ? text.substring(0, length - 1) + '…' : text;
}

/**
 * Draw connector line between steps
 */
function drawConnector(x, y, length, color) {
  return `
    <g>
      <line x1="${x}" y1="${y}" x2="${x + length}" y2="${y}" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
      <polygon points="${x + length},${y} ${x + length - 5},${y - 3} ${x + length - 5},${y + 3}" fill="${color}"/>
    </g>
  `;
}

/**
 * Format request status for display
 */
function formatRequestStatus(status) {
  const labels = {
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    pending_rejection_review: 'Under Review',
    rejection_accepted: 'Rejection Upheld',
    returned_for_resubmission: 'Returned for Resubmission',
    paused_for_coi: 'Paused (COI)',
  };
  return labels[status] || status;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default {
  generateApprovalFlowchart,
};
