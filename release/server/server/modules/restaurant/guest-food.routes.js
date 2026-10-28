import { Router } from 'express';
import { AppError } from '../../errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { createPublicGuestFoodOrder, getPublicGuestMenuByQrToken, getPublicGuestOrderTracking, resetRoomOrderRateBuckets, } from './guest-food.service.js';
export const guestFoodRouter = Router();
const MAX_TRACKED_KEYS = 5000;
const MENU_READ_WINDOW_MS = 5 * 60 * 1000;
const MAX_MENU_READS_PER_IP = 90;
const ORDER_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ORDER_ATTEMPTS_PER_IP = 15;
const ROOM_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ROOM_FAILURES_PER_IP = 10;
const TRACKING_READ_WINDOW_MS = 5 * 60 * 1000;
const MAX_TRACKING_READS_PER_IP = 90;
const menuIpHits = new Map();
const orderIpHits = new Map();
const roomFailureIpHits = new Map();
const trackingIpHits = new Map();
export function resetPublicGuestOrderRateLimiter() {
    menuIpHits.clear();
    orderIpHits.clear();
    roomFailureIpHits.clear();
    trackingIpHits.clear();
    resetRoomOrderRateBuckets();
}
function pruneBucket(bucket, key, now, windowMs) {
    const existing = bucket.get(key);
    if (!existing)
        return [];
    const active = existing.filter((ts) => now - ts < windowMs);
    if (active.length === 0) {
        bucket.delete(key);
    }
    else {
        bucket.set(key, active);
    }
    return active;
}
function pushHit(bucket, key, now, windowMs) {
    if (!bucket.has(key) && bucket.size >= MAX_TRACKED_KEYS) {
        const oldest = bucket.keys().next().value;
        if (oldest !== undefined)
            bucket.delete(oldest);
    }
    const active = pruneBucket(bucket, key, now, windowMs);
    active.push(now);
    bucket.set(key, active);
}
function checkAndRecordIpLimit(res, bucket, key, maxHits, windowMs, message, recordImmediately = true, now = Date.now()) {
    const active = pruneBucket(bucket, key, now, windowMs);
    if (active.length >= maxHits) {
        const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - active[0])) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        throw new AppError(429, message, 'RATE_LIMITED', { retryAfterSeconds });
    }
    if (recordImmediately) {
        pushHit(bucket, key, now, windowMs);
    }
}
guestFoodRouter.get('/menu/:qrToken', asyncHandler(async (req, res) => {
    const clientIp = String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64) ||
        'unknown';
    checkAndRecordIpLimit(res, menuIpHits, clientIp, MAX_MENU_READS_PER_IP, MENU_READ_WINDOW_MS, 'Too many menu requests from this network. Please wait briefly and try again.');
    const payload = await getPublicGuestMenuByQrToken(req.params.qrToken);
    res.json(payload);
}));
guestFoodRouter.post('/menu/:qrToken/orders', asyncHandler(async (req, res) => {
    const clientIp = String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64) ||
        'unknown';
    checkAndRecordIpLimit(res, roomFailureIpHits, clientIp, MAX_ROOM_FAILURES_PER_IP, ROOM_FAILURE_WINDOW_MS, 'Too many invalid room verification attempts. Please wait or contact the front desk.', false);
    checkAndRecordIpLimit(res, orderIpHits, clientIp, MAX_ORDER_ATTEMPTS_PER_IP, ORDER_ATTEMPT_WINDOW_MS, 'Too many order attempts from this device. Please wait a few minutes and try again.');
    const { payload, created } = await createPublicGuestFoodOrder(req.params.qrToken, req.body, {
        onRoomValidationFailure: () => {
            pushHit(roomFailureIpHits, clientIp, Date.now(), ROOM_FAILURE_WINDOW_MS);
        },
    });
    res.status(created ? 201 : 200).json(payload);
}));
guestFoodRouter.get('/orders/:trackingToken', asyncHandler(async (req, res) => {
    const clientIp = String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64) ||
        'unknown';
    checkAndRecordIpLimit(res, trackingIpHits, clientIp, MAX_TRACKING_READS_PER_IP, TRACKING_READ_WINDOW_MS, 'Too many order status refreshes. Please wait briefly.');
    const payload = await getPublicGuestOrderTracking(req.params.trackingToken);
    res.json(payload);
}));
