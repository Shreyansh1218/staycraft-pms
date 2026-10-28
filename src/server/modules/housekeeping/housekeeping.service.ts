import { HOUSEKEEPING_TASK_TYPE_LABELS } from '../../../shared/constants.js';
import { isValidIsoDate } from '../../../shared/dates.js';
import {
  housekeepingTaskCreateSchema,
  housekeepingTaskTransitionSchema,
  housekeepingTaskUpdateSchema,
} from '../../../shared/schemas.js';
import type { HousekeepingTask } from '../../../shared/types.js';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import { mapHousekeepingTaskRow } from '../../services/mappers.js';
import { validatePropertyStaffAssignee } from '../properties/properties.routes.js';

const TASK_SELECT = `
  SELECT ht.*,
         rm.room_number,
         rm.floor AS room_floor,
         rm.housekeeping_status AS room_housekeeping_status,
         rm.operational_status AS room_operational_status,
         rm.cleaning_started_at AS room_cleaning_started_at,
         rt.name AS room_type_name,
         res.booking_reference,
         u_ass.full_name AS assigned_to_name,
         u_ass.role AS assigned_to_role,
         u_start.full_name AS started_by_name,
         u_comp.full_name AS completed_by_name,
         u_cre.full_name AS created_by_name,
         u_upd.full_name AS updated_by_name,
         EXISTS (
           SELECT 1 FROM reservations r_occ
           WHERE r_occ.room_id = rm.id AND r_occ.status = 'checked_in'
         ) AS is_room_occupied
  FROM housekeeping_tasks ht
  JOIN rooms rm ON rm.id = ht.room_id
  JOIN room_types rt ON rt.id = rm.room_type_id
  LEFT JOIN reservations res ON res.id = ht.reservation_id
  LEFT JOIN users u_ass ON u_ass.id = ht.assigned_to
  LEFT JOIN users u_start ON u_start.id = ht.started_by
  LEFT JOIN users u_comp ON u_comp.id = ht.completed_by
  LEFT JOIN users u_cre ON u_cre.id = ht.created_by
  LEFT JOIN users u_upd ON u_upd.id = ht.updated_by
`;

export interface ListHousekeepingTasksFilter {
  status?: string;
  priority?: string;
  taskType?: string;
  roomId?: string;
  assignedTo?: string;
  dueDate?: string;
  dueFrom?: string;
  dueTo?: string;
  search?: string;
}

export async function listHousekeepingTasks(
  propertyId: string,
  filter: ListHousekeepingTasksFilter = {}
): Promise<HousekeepingTask[]> {
  const pool = getPool();
  const params: unknown[] = [propertyId];
  const conditions: string[] = ['ht.property_id = $1'];

  if (filter.status) {
    if (filter.status === 'active') {
      conditions.push(`ht.status IN ('pending', 'in_progress')`);
    } else {
      params.push(filter.status);
      conditions.push(`ht.status = $${params.length}`);
    }
  }

  if (filter.priority) {
    params.push(filter.priority);
    conditions.push(`ht.priority = $${params.length}`);
  }

  if (filter.taskType) {
    params.push(filter.taskType);
    conditions.push(`ht.task_type = $${params.length}`);
  }

  if (filter.roomId) {
    params.push(filter.roomId);
    conditions.push(`ht.room_id = $${params.length}`);
  }

  if (filter.assignedTo) {
    if (filter.assignedTo === 'unassigned') {
      conditions.push('ht.assigned_to IS NULL');
    } else {
      params.push(filter.assignedTo);
      conditions.push(`ht.assigned_to = $${params.length}`);
    }
  }

  if (filter.dueDate && isValidIsoDate(filter.dueDate)) {
    params.push(filter.dueDate);
    conditions.push(`ht.scheduled_for = $${params.length}::date`);
  }

  if (filter.dueFrom && isValidIsoDate(filter.dueFrom)) {
    params.push(filter.dueFrom);
    conditions.push(`ht.scheduled_for >= $${params.length}::date`);
  }

  if (filter.dueTo && isValidIsoDate(filter.dueTo)) {
    params.push(filter.dueTo);
    conditions.push(`ht.scheduled_for <= $${params.length}::date`);
  }

  if (filter.search && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim()}%`);
    const idx = params.length;
    conditions.push(
      `(rm.room_number ILIKE $${idx}
        OR rt.name ILIKE $${idx}
        OR ht.notes ILIKE $${idx}
        OR COALESCE(u_ass.full_name, '') ILIKE $${idx}
        OR COALESCE(res.booking_reference, '') ILIKE $${idx})`
    );
  }

  const sql = `
    ${TASK_SELECT}
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE ht.status
        WHEN 'in_progress' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'completed' THEN 2
        ELSE 3
      END ASC,
      CASE ht.priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        ELSE 3
      END ASC,
      ht.scheduled_for ASC,
      LENGTH(rm.room_number) ASC,
      rm.room_number ASC,
      ht.created_at DESC
  `;

  const res = await pool.query(sql, params);
  return res.rows.map(mapHousekeepingTaskRow);
}

export async function getHousekeepingTaskById(
  propertyId: string,
  taskId: string,
  db: Queryable = getPool()
): Promise<HousekeepingTask> {
  const res = await db.query(
    `${TASK_SELECT}
     WHERE ht.id = $1 AND ht.property_id = $2
     LIMIT 1`,
    [taskId, propertyId]
  );
  if (res.rowCount === 0) {
    throw AppError.notFound('Housekeeping task not found');
  }
  return mapHousekeepingTaskRow(res.rows[0]);
}

export async function createHousekeepingTask(
  propertyId: string,
  actorUserId: string,
  rawInput: unknown
): Promise<HousekeepingTask> {
  const input = housekeepingTaskCreateSchema.parse(rawInput);

  const createdId = await withTransaction(async (client) => {
    // Lock the room row to serialize concurrent task creation on the same room
    const roomRes = await client.query(
      'SELECT id, room_number, is_active FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [input.roomId, propertyId]
    );
    if (roomRes.rowCount === 0) {
      throw AppError.badRequest('Selected room does not belong to this property');
    }
    if (!roomRes.rows[0].is_active) {
      throw AppError.badRequest('Cannot create a housekeeping task for a deactivated room');
    }

    await validatePropertyStaffAssignee(client, propertyId, input.assignedTo);

    if (input.reservationId) {
      const resCheck = await client.query(
        'SELECT id FROM reservations WHERE id = $1 AND property_id = $2',
        [input.reservationId, propertyId]
      );
      if (resCheck.rowCount === 0) {
        throw AppError.badRequest('Linked reservation does not belong to this property');
      }
    }

    const roomNum = String(roomRes.rows[0].room_number);
    const label = HOUSEKEEPING_TASK_TYPE_LABELS[input.taskType] ?? input.taskType;
    const normalizedNotes = input.notes.trim().toLowerCase();

    // Prevent duplicate open tasks on the same (property, room, taskType, dueDate).
    // For ad-hoc linen_refresh requests, allow separate open tasks when both carry distinct non-empty notes.
    const dupCheck = await client.query(
      `SELECT id, notes
       FROM housekeeping_tasks
       WHERE property_id = $1
         AND room_id = $2
         AND task_type = $3
         AND scheduled_for = $4::date
         AND status IN ('pending', 'in_progress')`,
      [propertyId, input.roomId, input.taskType, input.dueDate]
    );

    const duplicateTask = dupCheck.rows.find((row) => {
      if (input.taskType === 'linen_refresh') {
        const existingNotes = String(row.notes ?? '').trim().toLowerCase();
        if (existingNotes !== '' && normalizedNotes !== '' && existingNotes !== normalizedNotes) {
          return false;
        }
      }
      return true;
    });

    if (duplicateTask) {
      throw AppError.conflict(
        `An open ${label} task is already scheduled for Room ${roomNum} on ${input.dueDate}.`,
        { existingTaskId: duplicateTask.id }
      );
    }

    const insertRes = await client.query(
      `INSERT INTO housekeeping_tasks (
         property_id, room_id, reservation_id, assigned_to,
         task_type, priority, status, scheduled_for, notes,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $9)
       RETURNING id`,
      [
        propertyId,
        input.roomId,
        input.reservationId,
        input.assignedTo,
        input.taskType,
        input.priority,
        input.dueDate,
        input.notes,
        actorUserId,
      ]
    );

    const taskId = insertRes.rows[0].id as string;

    await recordAuditEvent(
      {
        propertyId,
        actorUserId,
        entityType: 'housekeeping_task',
        entityId: taskId,
        action: 'created',
        summary: `Created ${label} task for Room ${roomNum} (due ${input.dueDate})`,
        payload: {
          roomId: input.roomId,
          roomNumber: roomNum,
          taskType: input.taskType,
          priority: input.priority,
          dueDate: input.dueDate,
          assignedTo: input.assignedTo,
        },
      },
      client
    );

    return taskId;
  });

  return getHousekeepingTaskById(propertyId, createdId);
}

export async function updateHousekeepingTask(
  propertyId: string,
  taskId: string,
  actorUserId: string,
  rawInput: unknown
): Promise<HousekeepingTask> {
  const input = housekeepingTaskUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT ht.*, rm.room_number
       FROM housekeeping_tasks ht
       JOIN rooms rm ON rm.id = ht.room_id
       WHERE ht.id = $1 AND ht.property_id = $2
       FOR UPDATE OF ht`,
      [taskId, propertyId]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Housekeeping task not found');
    }
    const existing = existingRes.rows[0];

    if (input.assignedTo !== undefined) {
      await validatePropertyStaffAssignee(client, propertyId, input.assignedTo);
    }

    const nextTaskType = input.taskType ?? existing.task_type;
    const nextPriority = input.priority ?? existing.priority;
    const nextDueDate = input.dueDate ?? existing.scheduled_for;
    const nextAssignedTo =
      input.assignedTo !== undefined ? input.assignedTo : existing.assigned_to;
    const nextNotes = input.notes !== undefined ? input.notes : existing.notes;
    const nextStatus = input.status ?? existing.status;

    if (existing.status === 'completed' && nextStatus !== 'completed') {
      throw AppError.badRequest(
        'Completed housekeeping tasks cannot be reverted. Create a new task if additional cleaning is needed.'
      );
    }

    let startedAt = existing.started_at;
    let startedBy = existing.started_by;
    let completedAt = existing.completed_at;
    let completedBy = existing.completed_by;

    if (nextStatus !== existing.status) {
      const roomRes = await client.query(
        'SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE',
        [existing.room_id, propertyId]
      );
      const room = roomRes.rows[0];

      if (room.housekeeping_status === 'out_of_service') {
        throw AppError.badRequest(
          `Room ${room.room_number} is Out of Service in housekeeping.`
        );
      }

      if (nextStatus === 'in_progress') {
        if (nextTaskType === 'inspection' && room.housekeeping_status !== 'clean') {
          throw AppError.badRequest(
            `Room ${room.room_number} must be marked Clean before starting supervisor inspection.`
          );
        }
        startedAt = startedAt ?? new Date().toISOString();
        startedBy = startedBy ?? actorUserId;
        if (nextTaskType !== 'inspection') {
          await client.query(
            `UPDATE rooms
             SET housekeeping_status = 'dirty',
                 cleaning_started_at = COALESCE(cleaning_started_at, NOW()),
                 cleaning_started_by = $1,
                 updated_at = NOW()
             WHERE id = $2 AND property_id = $3`,
            [actorUserId, existing.room_id, propertyId]
          );
        }
      } else if (nextStatus === 'completed') {
        if (nextTaskType === 'inspection' && room.housekeeping_status !== 'clean') {
          throw AppError.badRequest(
            `Room ${room.room_number} must be marked Clean before completing supervisor inspection.`
          );
        }
        startedAt = startedAt ?? new Date().toISOString();
        startedBy = startedBy ?? actorUserId;
        completedAt = new Date().toISOString();
        completedBy = actorUserId;
        if (nextTaskType === 'inspection') {
          await client.query(
            `UPDATE rooms
             SET housekeeping_status = 'inspected',
                 cleaning_started_at = NULL,
                 cleaning_started_by = NULL,
                 last_inspected_at = NOW(),
                 last_inspected_by = $1,
                 updated_at = NOW()
             WHERE id = $2 AND property_id = $3`,
            [actorUserId, existing.room_id, propertyId]
          );
        } else {
          await client.query(
            `UPDATE rooms
             SET housekeeping_status = 'clean',
                 cleaning_started_at = NULL,
                 cleaning_started_by = NULL,
                 last_cleaned_at = NOW(),
                 last_cleaned_by = $1,
                 updated_at = NOW()
             WHERE id = $2 AND property_id = $3`,
            [actorUserId, existing.room_id, propertyId]
          );
        }
      }
    }

    await client.query(
      `UPDATE housekeeping_tasks
       SET task_type = $1,
           priority = $2,
           status = $3,
           scheduled_for = $4,
           assigned_to = $5,
           notes = $6,
           started_at = $7,
           started_by = $8,
           completed_at = $9,
           completed_by = $10,
           updated_by = $11,
           updated_at = NOW()
       WHERE id = $12 AND property_id = $13`,
      [
        nextTaskType,
        nextPriority,
        nextStatus,
        nextDueDate,
        nextAssignedTo,
        nextNotes,
        startedAt,
        startedBy,
        completedAt,
        completedBy,
        actorUserId,
        taskId,
        propertyId,
      ]
    );

    const assignmentChanged = nextAssignedTo !== existing.assigned_to;
    await recordAuditEvent(
      {
        propertyId,
        actorUserId,
        entityType: 'housekeeping_task',
        entityId: taskId,
        action: assignmentChanged ? 'assigned' : 'updated',
        summary: assignmentChanged
          ? `Updated assignment on housekeeping task for Room ${existing.room_number}`
          : `Updated housekeeping task for Room ${existing.room_number}`,
        payload: {
          fromStatus: existing.status,
          toStatus: nextStatus,
          previousAssignee: existing.assigned_to,
          assignedTo: nextAssignedTo,
          priority: nextPriority,
          dueDate: nextDueDate,
        },
      },
      client
    );
  });

  return getHousekeepingTaskById(propertyId, taskId);
}

export async function startHousekeepingTask(
  propertyId: string,
  taskId: string,
  actorUserId: string,
  rawInput: unknown
): Promise<HousekeepingTask> {
  const input = housekeepingTaskTransitionSchema.parse(rawInput ?? {});

  await withTransaction(async (client) => {
    const taskRes = await client.query(
      'SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [taskId, propertyId]
    );
    if (taskRes.rowCount === 0) {
      throw AppError.notFound('Housekeeping task not found');
    }
    const task = taskRes.rows[0];

    if (task.status !== 'pending') {
      throw AppError.badRequest(
        `Only Pending tasks can be started (current status: "${task.status}").`
      );
    }

    const roomRes = await client.query(
      'SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [task.room_id, propertyId]
    );
    const room = roomRes.rows[0];

    if (room.housekeeping_status === 'out_of_service') {
      throw AppError.badRequest(
        `Room ${room.room_number} is marked Out of Service in housekeeping.`
      );
    }

    if (task.task_type === 'inspection' && room.housekeeping_status !== 'clean') {
      throw AppError.badRequest(
        `Room ${room.room_number} must be Clean before starting a supervisor inspection task.`
      );
    }

    const mergedNotes = input.notes ? input.notes : task.notes;

    await client.query(
      `UPDATE housekeeping_tasks
       SET status = 'in_progress',
           started_at = NOW(),
           started_by = $1,
           updated_by = $1,
           notes = $2,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`,
      [actorUserId, mergedNotes, taskId, propertyId]
    );

    if (task.task_type !== 'inspection') {
      await client.query(
        `UPDATE rooms
         SET housekeeping_status = 'dirty',
             cleaning_started_at = COALESCE(cleaning_started_at, NOW()),
             cleaning_started_by = $1,
             updated_at = NOW()
         WHERE id = $2 AND property_id = $3`,
        [actorUserId, task.room_id, propertyId]
      );
    }

    await recordAuditEvent(
      {
        propertyId,
        actorUserId,
        entityType: 'housekeeping_task',
        entityId: taskId,
        action: 'started',
        summary: `Started ${task.task_type} task for Room ${room.room_number}`,
        payload: {
          roomId: task.room_id,
          roomNumber: room.room_number,
          taskType: task.task_type,
        },
      },
      client
    );
  });

  return getHousekeepingTaskById(propertyId, taskId);
}

export async function completeHousekeepingTask(
  propertyId: string,
  taskId: string,
  actorUserId: string,
  rawInput: unknown
): Promise<HousekeepingTask> {
  const input = housekeepingTaskTransitionSchema.parse(rawInput ?? {});

  await withTransaction(async (client) => {
    const taskRes = await client.query(
      'SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [taskId, propertyId]
    );
    if (taskRes.rowCount === 0) {
      throw AppError.notFound('Housekeeping task not found');
    }
    const task = taskRes.rows[0];

    if (task.status !== 'pending' && task.status !== 'in_progress') {
      throw AppError.badRequest(
        `Task in "${task.status}" status cannot be completed.`
      );
    }

    const roomRes = await client.query(
      'SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [task.room_id, propertyId]
    );
    const room = roomRes.rows[0];

    if (room.housekeeping_status === 'out_of_service') {
      throw AppError.badRequest(
        `Room ${room.room_number} is marked Out of Service in housekeeping.`
      );
    }

    if (task.task_type === 'inspection') {
      if (room.housekeeping_status !== 'clean') {
        throw AppError.badRequest(
          `Room ${room.room_number} must be Clean before completing supervisor inspection (currently "${room.housekeeping_status}").`
        );
      }
      await client.query(
        `UPDATE rooms
         SET housekeeping_status = 'inspected',
             cleaning_started_at = NULL,
             cleaning_started_by = NULL,
             last_inspected_at = NOW(),
             last_inspected_by = $1,
             updated_at = NOW()
         WHERE id = $2 AND property_id = $3`,
        [actorUserId, task.room_id, propertyId]
      );
    } else {
      await client.query(
        `UPDATE rooms
         SET housekeeping_status = 'clean',
             cleaning_started_at = NULL,
             cleaning_started_by = NULL,
             last_cleaned_at = NOW(),
             last_cleaned_by = $1,
             updated_at = NOW()
         WHERE id = $2 AND property_id = $3`,
        [actorUserId, task.room_id, propertyId]
      );
    }

    const mergedNotes = input.notes ? input.notes : task.notes;

    await client.query(
      `UPDATE housekeeping_tasks
       SET status = 'completed',
           started_at = COALESCE(started_at, NOW()),
           started_by = COALESCE(started_by, $1),
           completed_at = NOW(),
           completed_by = $1,
           updated_by = $1,
           notes = $2,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`,
      [actorUserId, mergedNotes, taskId, propertyId]
    );

    await recordAuditEvent(
      {
        propertyId,
        actorUserId,
        entityType: 'housekeeping_task',
        entityId: taskId,
        action: 'completed',
        summary: `Completed ${task.task_type} task for Room ${room.room_number}`,
        payload: {
          roomId: task.room_id,
          roomNumber: room.room_number,
          taskType: task.task_type,
        },
      },
      client
    );
  });

  return getHousekeepingTaskById(propertyId, taskId);
}
