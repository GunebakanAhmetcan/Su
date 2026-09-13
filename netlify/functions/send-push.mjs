import { timingSafeEqual } from 'node:crypto';
import { deliverJob, restClient, json } from '../../src/server/push.mjs';
export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = process.env.WEBHOOK_SECRET;
  const supplied = request.headers.get('x-webhook-secret') || '';
  if (!secret || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) return json({ error: 'unauthorized' }, 401);
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const id = payload?.record?.id;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'missing_record' }, 400);
  try { return json(await deliverJob(restClient(), id)); }
  catch { return json({ error: 'delivery_pending_retry' }, 500); }
}
