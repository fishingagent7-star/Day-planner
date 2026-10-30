// ---------- reminder sender (Supabase Edge Function "send-reminders") ----------
// Supabase runs this every minute (a cron job). For each person who turned
// reminders on (their pushsub:* rows), it reads today's plan and sends
// "starts in 5 min" for blocks about to begin. It remembers what it sent in
// remindsent:<day>, so nothing arrives twice.
// Secret needed (Edge Functions → Secrets): VAPID_PRIVATE_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

// The public half of the reminder keys (same as VAPID_PUBLIC_KEY in app.js).
const PUBLIC_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "qZLED8ozu6zmfmEwoIYni4GFZzjxVA1wgjr-bzZlHoM",
  y: "S2LonguENn-wh28GT3LVxSpgpIbbVE5nTOaU8qr2KKM",
};
const TABLE = "planner_items";

// This runs on Supabase's server, so it may use the secret key (it skips the
// lock rules to read everyone's reminders). Supabase provides it automatically.
const secretKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const db = createClient(Deno.env.get("SUPABASE_URL")!, secretKey);

const vapidKeys = await webpush.importVapidKeys({
  publicKey: PUBLIC_JWK,
  privateKey: { ...PUBLIC_JWK, d: Deno.env.get("VAPID_PRIVATE_KEY")! },
});
const pushServer = await webpush.ApplicationServer.new({
  contactInformation: "https://fishingagent7-star.github.io/Day-planner/",
  vapidKeys,
});

// Today's date and the minute of the day, in the person's own time zone.
export function localNow(tz: string, at = new Date()) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).forEach((x) => { p[x.type] = x.value; });
  return { day: `${p.year}-${p.month}-${p.day}`, minute: +p.hour * 60 + +p.minute };
}

// Blocks starting within the next `ahead` minutes that aren't done or already reminded.
export function dueBlocks(blocks: any[], already: string[], nowMinute: number, ahead: number) {
  return blocks.flatMap((b) => {
    const m = /^(\d\d):(\d\d)$/.exec(b?.time ?? "");
    if (!m || b.done || already.includes(b.id)) return [];
    const left = +m[1] * 60 + +m[2] - nowMinute;
    return left >= 0 && left <= ahead ? [{ id: b.id, title: b.title, left }] : [];
  });
}

async function readJson(userId: string, key: string, fallback: any) {
  const { data } = await db.from(TABLE).select("value").eq("user_id", userId).eq("key", key).maybeSingle();
  try { return data ? JSON.parse(data.value) : fallback; } catch { return fallback; }
}

// shortcut: anyone who finds this address can make it check early; harmless (it only
// sends reminders that are due, once). Add a secret header check if it's ever abused.
Deno.serve(async () => {
  const { data: rows, error } = await db.from(TABLE).select("user_id, key, value").like("key", "pushsub:%");
  if (error) return new Response(error.message, { status: 500 });

  // Group each person's devices (phone, laptop…) together.
  const people = new Map<string, any[]>();
  for (const row of rows) {
    try {
      const device = { ...JSON.parse(row.value), key: row.key };
      people.set(row.user_id, (people.get(row.user_id) ?? []).concat(device));
    } catch { /* a broken row: skip it */ }
  }

  let sent = 0;
  for (const [userId, devices] of people) {
    const now = localNow(devices[0].tz || "Australia/Sydney");
    const sentKey = "remindsent:" + now.day;
    const already: string[] = await readJson(userId, sentKey, []);
    const due = dueBlocks(await readJson(userId, "plan:" + now.day, []), already, now.minute, devices[0].minutes ?? 5);
    if (!due.length) continue;

    // Note them as sent first, so two runs close together can't both send.
    await db.from(TABLE).upsert({
      user_id: userId, key: sentKey,
      value: JSON.stringify(already.concat(due.map((b) => b.id))),
      updated_at: new Date().toISOString(),
    });
    await db.from(TABLE).delete().eq("user_id", userId).like("key", "remindsent:%").neq("key", sentKey);

    for (const b of due) {
      const message = JSON.stringify({
        title: b.title || "Your next block",
        body: b.left > 0 ? `Starts in ${b.left} min` : "Starting now",
        tag: b.id,
      });
      for (const device of devices) {
        try {
          await pushServer.subscribe(device.sub).pushTextMessage(message, { ttl: 300 } as webpush.PushMessageOptions);
          sent++;
        } catch (e) {
          // The phone turned reminders off or was reset: forget that address.
          if (e instanceof webpush.PushMessageError && e.isGone()) {
            await db.from(TABLE).delete().eq("user_id", userId).eq("key", device.key);
          } else {
            console.error("push failed", e);
          }
        }
      }
    }
  }
  return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
});
