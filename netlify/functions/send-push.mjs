import webpush from "web-push";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function compactError(value) {
  return String(value || "Bilinmeyen Supabase hatası").replace(/\s+/g, " ").slice(0, 500);
}

function createRestClient(baseUrl, secretKey) {
  const root = cleanBaseUrl(baseUrl) + "/rest/v1";
  const baseHeaders = {
    apikey: secretKey,
    authorization: "Bearer " + secretKey,
    accept: "application/json"
  };

  return async function request(table, options = {}) {
    const target = new URL(root + "/" + table);
    Object.entries(options.query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    });

    const headers = { ...baseHeaders };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.prefer) headers.prefer = options.prefer;

    const response = await fetch(target, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error("Supabase REST " + response.status + ": " + compactError(raw));
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_error) {
      return raw;
    }
  };
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

  const supabaseUrl = cleanBaseUrl(process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL);
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

  const rest = createRestClient(supabaseUrl, supabaseSecret);
  let jobs;
  try {
    jobs = await rest("notification_jobs", {
      query: {
        select: "id,room_id,sender_user_id,recipient_user_id,kind,processed_at",
        id: "eq." + incomingRecord.id,
        limit: 1
      }
    });
  } catch (error) {
    return json({ error: "job_lookup_failed", detail: compactError(error?.message) }, 500);
  }
  const job = Array.isArray(jobs) ? jobs[0] : null;
  if (!job) return json({ error: "job_not_found" }, 404);
  if (job.processed_at) return json({ ok: true, duplicate: true });
  if (job.kind !== "drink_water") return json({ error: "unsupported_kind" }, 400);

  try {
    const senders = await rest("profiles", {
      query: { select: "display_name", user_id: "eq." + job.sender_user_id, limit: 1 }
    });
    const subscriptions = await rest("push_subscriptions", {
      query: { select: "endpoint,p256dh,auth", user_id: "eq." + job.recipient_user_id }
    });

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    const notification = JSON.stringify({
      title: (senders?.[0]?.display_name || "Arkadaşın") + " hatırlattı",
      body: "Su içmeyi unutma.",
      tag: "su-hatirlatma",
      url: "/?birlikte=1"
    });

    const staleEndpoints = [];
    let delivered = 0;
    for (const subscription of subscriptions || []) {
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
      await Promise.all(
        staleEndpoints.map((endpoint) =>
          rest("push_subscriptions", {
            method: "DELETE",
            query: { endpoint: "eq." + endpoint },
            prefer: "return=minimal"
          })
        )
      );
    }
    if (!delivered) {
      await rest("profiles", {
        method: "PATCH",
        query: { user_id: "eq." + job.recipient_user_id },
        body: { notifications_enabled: false, updated_at: new Date().toISOString() },
        prefer: "return=minimal"
      });
    }
    await rest("notification_jobs", {
      method: "PATCH",
      query: { id: "eq." + job.id },
      body: {
        processed_at: new Date().toISOString(),
        error: delivered ? null : "no_active_subscription"
      },
      prefer: "return=minimal"
    });

    return json({ ok: true, delivered });
  } catch (error) {
    try {
      await rest("notification_jobs", {
        method: "PATCH",
        query: { id: "eq." + job.id },
        body: { error: compactError(error?.message || error) },
        prefer: "return=minimal"
      });
    } catch (_updateError) {
      // The original delivery error is the useful response for the webhook caller.
    }
    return json({ error: "delivery_failed" }, 500);
  }
}
