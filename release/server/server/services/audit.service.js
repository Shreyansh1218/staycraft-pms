import { getPool } from '../db/pool.js';
export async function recordAuditEvent(params, db = getPool()) {
    await db.query(`INSERT INTO audit_events (property_id, actor_user_id, entity_type, entity_id, action, summary, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`, [
        params.propertyId ?? null,
        params.actorUserId ?? null,
        params.entityType,
        params.entityId ?? null,
        params.action,
        params.summary,
        JSON.stringify(params.payload ?? {}),
    ]);
}
