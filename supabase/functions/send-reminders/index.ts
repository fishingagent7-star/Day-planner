// ---------- reminder sender (Supabase Edge Function "send-reminders") ----------
// Supabase runs this every minute (a cron job). For each person who turned
// reminders on (their pushsub:* rows), it reads today's plan and sends
// "starts in N min" for blocks about to begin (N is "Remind me … before" in Settings),
// including repeating blocks on days the app hasn't been opened yet. It remembers what it sent in
// remindsent:<day>, so nothing arrives twice.
// Secrets needed (Edge Functions → Secrets): VAPID_PRIVATE_KEY and CRON_SECRET.
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
  contactInformation: "https://lodestarplanner.netlify.app/",
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
// A block is remembered by its time and title (not its id): a repeating block can be
// reminded before the app has added it to the day, and adding it gives it a new id.
export function dueBlocks(blocks: any[], already: string[], nowMinute: number, ahead: number) {
  return blocks.flatMap((b) => {
    const m = /^(\d\d):(\d\d)$/.exec(b?.time ?? "");
    const id = b?.time + "|" + b?.title;
    if (!m || b.done || already.includes(id)) return [];
    const left = +m[1] * 60 + +m[2] - nowMinute;
    return left >= 0 && left <= ahead ? [{ id, title: b.title, left }] : [];
  });
}

// Blocks from repeating templates that the app hasn't added to the day yet (it adds
// them when the day is first opened). Read only: the app still does the real adding.
export function pendingRepeats(day: string, rules: any[], applied: string[], templates: any) {
  const weekday = new Date(day + "T12:00:00Z").getUTCDay(); // 0 = Sunday, like the app
  return rules.filter((r) => r?.weekdays?.includes(weekday) && !applied.includes(r.id))
    .flatMap((r) => (templates[r.templateName] ?? []).map((t: any) => ({ time: t.time, title: t.title, done: false })));
}

async function readJson(userId: string, key: string, fallback: any) {
  const { data } = await db.from(TABLE).select("value").eq("user_id", userId).eq("key", key).maybeSingle();
  try { return data ? JSON.parse(data.value) : fallback; } catch { return fallback; }
}

// Only the cron job knows the password (secret CRON_SECRET, sent as the x-cron-secret
// header), so nobody else who finds this address can make it run.
Deno.serve(async (req) => {
  const password = Deno.env.get("CRON_SECRET");
  if (!password || req.headers.get("x-cron-secret") !== password) return new Response("Not allowed", { status: 401 });

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
    const blocks = (await readJson(userId, "plan:" + now.day, [])).concat(pendingRepeats(now.day,
      await readJson(userId, "recurring", []), await readJson(userId, "recurapplied:" + now.day, []), await readJson(userId, "templates", {})));
    const minutes = (await readJson(userId, "settings", {})).remindMinutes ?? devices[0].minutes ?? 5;
    const due = dueBlocks(blocks, already, now.minute, minutes);
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
