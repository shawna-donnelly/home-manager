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
): string | null {
  const lines: string[] = [];
  for (const kid of view.kids) {
    const undone = view.chores.filter(
      (c) =>
        c.kid === kid &&
        !view.doneToday.includes(c.id) &&
        (c.cadence !== "weekly" || includeWeekly),
    );
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
 * Email the unfinished-chores report every day at `time` (local "HH:MM").
 * Fires once per day; days where everything is done send nothing.
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
      // Weeks start Monday, so Sunday is the weekly-chore deadline.
      const isWeekEnd = new Date().getDay() === 0;
      const report = buildChoreReport(view(), isWeekEnd);
      if (report) void notifier.send("Unfinished chores today", report);
      schedule();
    }, next.getTime() - now.getTime());
    // The HTTP server keeps the process alive; this timer shouldn't.
    timer.unref();
  };

  schedule();
}
