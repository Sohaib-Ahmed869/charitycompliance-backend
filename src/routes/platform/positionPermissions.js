import express from 'express';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { AppError } from '../../middleware/errorHandler.js';
import { PositionRepository } from '../../repositories/positionRepository.js';

const router = express.Router();

/** Valid MongoDB ObjectId is 24 hex characters */
function isValidObjectId(id) {
  return typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);
}

// Use combined authenticate + tenant resolver so handlers have req.tenantDb and req.orgId
router.use(authAndResolveTenant);

/**
 * GET /api/v1/platform/position-permissions/:positionId/permissions
 * Return module_permissions for a position as a map keyed by module_id
 */
router.get('/:positionId/permissions', async (req, res) => {
  const { positionId } = req.params;
  const tenantDb = req.tenantDb;

  if (!isValidObjectId(positionId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid position ID. Positions must be created in Charity Administration first.'
    });
  }

  try {
    const positionRepo = new PositionRepository(tenantDb);
    const position = await positionRepo.findById(positionId);
    if (!position) return res.status(404).json({ success: false, error: 'Position not found' });

    const modulePermissions = {};
    (position.module_permissions || []).forEach(mp => {
      if (!mp || !mp.module_id) return;
      modulePermissions[mp.module_id] = {
        view: !!mp.view,
        edit: !!mp.edit,
        delete: !!mp.delete
      };
    });

    res.json({ success: true, positionId, modulePermissions });
  } catch (err) {
    console.error('Error fetching position permissions', err);
    res.status(500).json({ success: false, error: 'Failed to fetch permissions' });
  }
});

/**
 * PUT /api/v1/platform/position-permissions/:positionId/permissions
 * Body: { modules: [{ id: string, view: boolean, edit: boolean, delete: boolean }] }
 */
router.put('/:positionId/permissions', async (req, res) => {
  const { positionId } = req.params;
  const { modules } = req.body;
  const tenantDb = req.tenantDb;
  const changedBy = req.user?.id || null;

  if (!isValidObjectId(positionId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid position ID. Positions must be created in Charity Administration first.'
    });
  }

  if (!Array.isArray(modules)) {
    return res.status(400).json({ success: false, error: 'modules array is required' });
  }

  try {
    const positionRepo = new PositionRepository(tenantDb);
    const position = await positionRepo.findById(positionId);
    if (!position) return res.status(404).json({ success: false, error: 'Position not found' });

    // Build a map of existing module permissions for easy lookup
    const existingMap = {};
    (position.module_permissions || []).forEach(mp => {
      if (mp && mp.module_id) existingMap[mp.module_id] = { view: !!mp.view, edit: !!mp.edit, delete: !!mp.delete };
    });

    let updatedCount = 0;
    const newModulePermissions = { ...existingMap };

    // Prepare audit log entries
    const auditCollection = tenantDb.collection('permission_audit_logs');
    const auditWrites = [];

    for (const m of modules) {
      const moduleId = m.id || m.module_id;
      if (!moduleId || typeof moduleId !== 'string') {
        throw new AppError('Invalid module id', 400, 'INVALID_MODULE_ID');
      }

      const view = !!m.view;
      const edit = !!m.edit;
      const del = !!m.delete;

      const prev = existingMap[moduleId] || { view: false, edit: false, delete: false };

      // If no change, skip
      if (prev.view === view && prev.edit === edit && prev.delete === del) continue;

      newModulePermissions[moduleId] = { view, edit, delete: del };
      updatedCount++;

      auditWrites.push({
        position_id: position._id,
        module_id: moduleId,
        previous_permissions: prev,
        new_permissions: { view, edit, delete: del },
        changed_by: changedBy,
        changed_at: new Date()
      });
    }

    // Persist new module_permissions array
    const modulePermissionsArray = Object.keys(newModulePermissions).map(k => ({ module_id: k, ...newModulePermissions[k] }));
    const updatedPosition = await positionRepo.update(positionId, { module_permissions: modulePermissionsArray });

    // Insert audit logs if any
    if (auditWrites.length) {
      await auditCollection.insertMany(auditWrites);
    }

    res.json({ success: true, updated: updatedCount, position: { id: updatedPosition._id } });
  } catch (err) {
    console.error('Error updating permissions', err);
    if (err instanceof AppError) {
      return res.status(err.status || 400).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: 'Failed to update permissions' });
  }
});

/**
 * GET /api/v1/platform/position-permissions/department/:departmentId/permissions
 * Return list of positions in a department with their module_permissions
 */
router.get('/department/:departmentId/permissions', async (req, res) => {
  const { departmentId } = req.params;
  const tenantDb = req.tenantDb;

  try {
    const positionRepo = new PositionRepository(tenantDb);
    // Find positions in department
    const positions = await positionRepo.findByDepartment(req.orgId, departmentId);

    const out = positions.map(p => {
      const modulePermissions = {};
      (p.module_permissions || []).forEach(mp => {
        if (!mp || !mp.module_id) return;
        modulePermissions[mp.module_id] = { view: !!mp.view, edit: !!mp.edit, delete: !!mp.delete };
      });
      return {
        id: p._id,
        title: p.title,
        level: p.level,
        modulePermissions
      };
    });

    res.json({ success: true, departmentId, positions: out });
  } catch (err) {
    console.error('Error fetching department permissions', err);
    res.status(500).json({ success: false, error: 'Failed to fetch department permissions' });
  }
});

/**
 * GET /api/v1/platform/position-permissions/audit-log/:positionId
 */
router.get('/audit-log/:positionId', async (req, res) => {
  const { positionId } = req.params;
  const tenantDb = req.tenantDb;
  const limit = parseInt(req.query.limit || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);

  if (!isValidObjectId(positionId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid position ID. Positions must be created in Charity Administration first.'
    });
  }

  try {
    const auditCollection = tenantDb.collection('permission_audit_logs');
    const query = { position_id: PositionIdOrString(positionId) };
    const cursor = auditCollection.find(query).sort({ changed_at: -1 }).skip(offset).limit(limit);
    const changes = await cursor.toArray();
    res.json({ success: true, positionId, changes, count: changes.length });
  } catch (err) {
    console.error('Error fetching audit log', err);
    res.status(500).json({ success: false, error: 'Failed to fetch audit log' });
  }
});

function PositionIdOrString(id) {
  // If passed an ObjectId-like string, leave as-is - Mongo driver will match by string or ObjectId depending on stored type
  return id;
}

export default router;
