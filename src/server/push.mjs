import webpush from 'web-push';
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
export function restClient(env = process.env, fetcher = fetch) {
  const base = String(env.PUBLIC_SUPABASE_URL || env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('missing_environment_variables');
  return async function rest(path, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(base + '/rest/v1/' + path);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const headers = { apikey: key, accept: 'application/json', 'content-type': 'application/json' };
    if (key.startsWith('eyJ')) headers.authorization = 'Bearer ' + key;
    const response = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('database_' + response.status);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}
export function allowedEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      /^(?:web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)$/.test(url.hostname);
  } catch { return false; }
}
export async function deliverJob(rest, id = null, { env = process.env, push = webpush, now = () => Date.now() } = {}) {
  const jobs = await rest('rpc/claim_push_job', { method: 'POST', body: { p_id: id } });
  const job = jobs?.[0];
  if (!job) return { ok: true, skipped: true };
  let delivered = 0;
  let temporaryFailure = false;
  let reason = 'no_active_subscription';
  try {
    const publicKey = env.PUBLIC_VAPID_KEY || env.VAPID_PUBLIC_KEY;
    const privateKey = env.VAPID_PRIVATE_KEY;
    const subject = env.VAPID_SUBJECT || env.URL;
    if (!publicKey || !privateKey || !subject) throw new Error('missing_environment_variables');
    const [members, senders, subscriptions] = await Promise.all([
      rest('room_members', { query: { select: 'user_id', room_id: 'eq.' + job.room_id } }),
      rest('profiles', { query: { select: 'display_name', user_id: 'eq.' + job.sender_user_id } }),
      rest('push_subscriptions', { query: { select: 'endpoint,p256dh,auth', user_id: 'eq.' + job.recipient_user_id } })
    ]);
    if (![job.sender_user_id, job.recipient_user_id].every(userId => members.some(member => member.user_id === userId))) reason = 'pair_unavailable';
    else {
      push.setVapidDetails(subject, publicKey, privateKey);
      const notification = JSON.stringify({ title: (senders[0]?.display_name || 'Arkadaşın') + ' hatırlattı', body: 'Su içmeyi unutma.', tag: 'su-' + job.id, url: '/?birlikte=1' });
      const ttl = Math.max(0, Math.floor((new Date(job.created_at).getTime() + 3600000 - now()) / 1000));
      if (!ttl) reason = 'expired';
      else await Promise.all(subscriptions.map(async subscription => {
        if (!allowedEndpoint(subscription.endpoint)) { reason = 'unsupported_push_service'; return; }
        try {
          await push.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, notification, { TTL: ttl, urgency: 'normal', timeout: 5000 });
          delivered++;
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) await rest('push_subscriptions', { method: 'DELETE', query: { endpoint: 'eq.' + subscription.endpoint, user_id: 'eq.' + job.recipient_user_id } });
          else {
            reason = 'push_' + (error.statusCode || 'connection');
            temporaryFailure ||= !error.statusCode || error.statusCode === 429 || error.statusCode >= 500;
          }
        }
      }));
    }
  } catch (error) {
    reason = error.message?.startsWith('database_') ? error.message : 'delivery_connection';
    temporaryFailure = true;
  }
  await rest('rpc/finish_push_job', { method: 'POST', body: { p_id: job.id, p_attempt: job.attempts, p_sent: delivered > 0, p_error: delivered ? null : reason, p_retryable: !delivered && temporaryFailure } });
  return { ok: delivered > 0, delivered, retrying: !delivered && temporaryFailure && job.attempts < 4 };
}
