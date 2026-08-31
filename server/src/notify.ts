import nodemailer from "nodemailer";
import type { TasksView } from "./tasks.js";

export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Recipient(s), comma-separated. */
  to: string;
}

export interface Notifier {
  readonly enabled: boolean;
  /** Never throws — a failed email is logged, never fatal to the display. */
  send(subject: string, text: string): Promise<void>;
}

export function createNotifier(config: EmailConfig | null): Notifier {
  if (!config) {
    return {
      enabled: false,
      async send(subject) {
        console.log(`[notify] email not configured; would have sent: ${subject}`);
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });

  return {
    enabled: true,
    async send(subject, text) {
      try {
        await transport.sendMail({
          from: `Home Manager <${config.user}>`,
          to: config.to,
          subject,
          text,
        });
        console.log(`[notify] sent: ${subject}`);
      } catch (err) {
        console.error(`[notify] send failed (${subject}):`, err);
      }
    },
  };
}

/**
 * The daily report body, or null when every kid is caught up (no email on
 * good days). Weekly chores only count on the week's last day — nag at the
 * deadline, not all week. Pure so it can be tested without a clock.
 */
export function buildChoreReport(
  view: TasksView,
  includeWeekly: boolean,
  weekday = new Date().getDay(),
): string | null {
  const lines: string[] = [];
  for (const kid of view.kids) {
    const undone = view.chores.filter((c) => {
      if (c.kid !== kid || view.doneToday.includes(c.id)) return false;
      if (c.cadence === "weekly") return includeWeekly;
      if (c.cadence === "days") return c.days?.includes(weekday) ?? false;
      return true;
    });
    if (undone.length > 0) {
      lines.push(
        `${kid}: ${undone
          .map((c) => (c.cadence === "weekly" ? `${c.title} (weekly)` : c.title))
          .join(", ")}`,
      );
    }
  }
  if (lines.length === 0) return null;
  return `Still unchecked on the chore chart:\n\n${lines.join("\n")}`;
}

/**
 * The Sunday wrap-up: every kid's score and percentage — the basis for
 * partial payouts. Unlike the daily nag, this sends even on perfect weeks
 * (a 100% row is exactly the news worth reading). Null only if no kid has
 * any chores.
 */
export function buildWeeklySummary(view: TasksView): string | null {
  const scored = view.points.filter((p) => p.target > 0);
  if (scored.length === 0) return null;

  const lines = scored.map((p) => {
    const pct = Math.round((p.earned / p.target) * 100);
    const trophy = p.earned >= p.target ? " 🏆" : "";
    const redeemed = p.redeemed ? ` — redeemed: ${p.redeemed}` : "";
    return `${p.kid}: ${p.earned} / ${p.target} pts (${pct}%)${trophy}${redeemed}`;
  });
  return `Chore week wrap-up:\n\n${lines.join("\n")}`;
}

/**
 * Email the unfinished-chores report every day at `time` (local "HH:MM").
 * Fires once per day; days where everything is done send nothing. Sundays
 * send the weekly percentage summary instead.
 */
export function scheduleDailyChoreReport(
  notifier: Notifier,
  view: () => TasksView,
  time: string,
): void {
  const [hour = 20, minute = 0] = time.split(":").map(Number);

  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const timer = setTimeout(() => {
      // Weeks start Monday, so Sunday is the week's end: send the scored
      // summary (with anything still unfinished appended) instead of the nag.
      const isWeekEnd = new Date().getDay() === 0;
      if (isWeekEnd) {
        const summary = buildWeeklySummary(view());
        const unfinished = buildChoreReport(view(), true);
        if (summary) {
          void notifier.send(
            "Chore week wrap-up",
            summary + (unfinished ? `\n\n${unfinished}` : ""),
          );
        }
      } else {
        const report = buildChoreReport(view(), false);
        if (report) void notifier.send("Unfinished chores today", report);
      }
      schedule();
    }, next.getTime() - now.getTime());
    // The HTTP server keeps the process alive; this timer shouldn't.
    timer.unref();
  };

  schedule();
}
