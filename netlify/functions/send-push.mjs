import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const expectedSecret = process.env.WEBHOOK_SECRET;
  const suppliedSecret =
    request.headers.get("x-webhook-secret") ||
    new URL(request.url).searchParams.get("secret");
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vapidPublicKey = process.env.PUBLIC_VAPID_KEY || process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || process.env.URL;

  if (!supabaseUrl || !supabaseSecret || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return json({ error: "missing_environment_variables" }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_error) {
    return json({ error: "invalid_json" }, 400);
  }

  const incomingRecord = payload && payload.record;
  if (!incomingRecord || !incomingRecord.id) return json({ error: "missing_record" }, 400);

  const admin = createClient(supabaseUrl, supabaseSecret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const jobResult = await admin
    .from("notification_jobs")
    .select("id,room_id,sender_user_id,recipient_user_id,kind,processed_at")
    .eq("id", incomingRecord.id)
    .maybeSingle();
  if (jobResult.error || !jobResult.data) return json({ error: "job_not_found" }, 404);
  const job = jobResult.data;
  if (job.processed_at) return json({ ok: true, duplicate: true });
  if (job.kind !== "drink_water") return json({ error: "unsupported_kind" }, 400);

  try {
    const senderResult = await admin
      .from("profiles")
      .select("display_name")
      .eq("user_id", job.sender_user_id)
      .maybeSingle();
    if (senderResult.error) throw senderResult.error;

    const subscriptionsResult = await admin
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth")
      .eq("user_id", job.recipient_user_id);
    if (subscriptionsResult.error) throw subscriptionsResult.error;

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    const notification = JSON.stringify({
      title: (senderResult.data?.display_name || "Arkadaşın") + " hatırlattı",
      body: "Su içmeyi unutma.",
      tag: "su-hatirlatma",
      url: "/?birlikte=1"
    });

    const staleEndpoints = [];
    let delivered = 0;
    for (const subscription of subscriptionsResult.data || []) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth }
          },
          notification,
          { TTL: 3600, urgency: "normal" }
        );
        delivered += 1;
      } catch (error) {
        if (error && (error.statusCode === 404 || error.statusCode === 410)) {
          staleEndpoints.push(subscription.endpoint);
        } else {
          throw error;
        }
      }
    }

    if (staleEndpoints.length) {
      await admin.from("push_subscriptions").delete().in("endpoint", staleEndpoints);
    }
    if (!delivered) {
      await admin
        .from("profiles")
        .update({ notifications_enabled: false, updated_at: new Date().toISOString() })
        .eq("user_id", job.recipient_user_id);
    }
    await admin
      .from("notification_jobs")
      .update({
        processed_at: new Date().toISOString(),
        error: delivered ? null : "no_active_subscription"
      })
      .eq("id", job.id);

    return json({ ok: true, delivered });
  } catch (error) {
    await admin
      .from("notification_jobs")
      .update({ error: String(error && error.message ? error.message : error).slice(0, 500) })
      .eq("id", job.id);
    return json({ error: "delivery_failed" }, 500);
  }
}
