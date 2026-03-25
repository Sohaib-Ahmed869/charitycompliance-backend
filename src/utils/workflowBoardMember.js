/**
 * Board-level detection aligned with workflow / departments-roles API.
 *
 * getDepartmentsAndRoles marks a position with is_board_level when at least one
 * active responsible person has is_board_member: true and holds that position_id.
 * Workflow UIs use that flag for board approver dropdowns.
 *
 * A user "is a board member" for handbook / UI when they hold at least one
 * position_id that appears in that same boardPositionIds set.
 */

/**
 * @param {import('mongoose').Connection} tenantDb
 * @param {import('mongoose').Types.ObjectId} orgObjectId
 * @returns {Promise<Set<string>>}
 */
export async function getBoardPositionIdsForOrg(tenantDb, orgObjectId) {
  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const boardMembers = await boardMemberRepo.BoardMember.find({
    org_id: orgObjectId,
    is_active: true,
    is_board_member: true,
    position_id: { $ne: null }
  }).lean();
  return new Set(
    boardMembers.map((bm) => bm.position_id?.toString?.()).filter(Boolean)
  );
}

/**
 * True if the user holds a board-level position (same notion as role.is_board_level in workflows).
 *
 * @param {import('mongoose').Connection} tenantDb
 * @param {string} userId
 * @param {import('mongoose').Types.ObjectId} orgObjectId
 */
export async function userHoldsBoardLevelPosition(tenantDb, userId, orgObjectId) {
  const boardPositionIds = await getBoardPositionIdsForOrg(tenantDb, orgObjectId);
  if (boardPositionIds.size === 0) return false;

  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const userRecords = await boardMemberRepo.findAllActiveByUserId(userId, orgObjectId);
  if (!userRecords?.length) return false;

  return userRecords.some((bm) => {
    const pid = bm.position_id?.toString?.();
    return pid && boardPositionIds.has(pid);
  });
}
