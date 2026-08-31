/**
 * One-time OAuth helper: prints a Google consent URL, catches the redirect on
 * a local port, and prints the refresh token plus every calendar id on the
 * account — everything needed to fill in the GOOGLE_* / GCAL_* env vars.
 *
 * Run on a machine with a browser (not the Pi):  yarn auth:google
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first — see README.",
  );
  process.exit(1);
}

const state = randomBytes(16).toString("hex");

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("state mismatch — rerun and use the fresh URL");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(200).end(`Google returned: ${error}. Check the terminal.`);
      console.error(`\nGoogle refused consent: ${error}`);
      process.exit(1);
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("missing code");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Done — you can close this tab and return to the terminal.");
    server.close();

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResponse.ok) {
      console.error(`token exchange failed: ${tokenResponse.status}`);
      console.error(await tokenResponse.text());
      process.exit(1);
    }
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    if (!tokens.refresh_token) {
      console.error(
        "No refresh token returned. Remove this app under myaccount.google.com" +
          " > Security > Third-party access, then rerun.",
      );
      process.exit(1);
    }

    console.log("\nAdd this to server/.env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    const listResponse = await fetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );
    if (listResponse.ok) {
      const list = (await listResponse.json()) as {
        items?: { id: string; summary: string; accessRole: string }[];
      };
      console.log("Calendars on this account (id — name — your access):\n");
      for (const cal of list.items ?? []) {
        console.log(`  ${cal.id} — ${cal.summary} — ${cal.accessRole}`);
      }
      console.log(
        '\nAdd one GCAL_* line per calendar, format "label|color|calendarId"' +
          " (color without #):\n",
      );
      console.log("  GCAL_1=Mom|4c8dff|<one of the ids above>\n");
    } else {
      console.warn(`could not list calendars: ${listResponse.status}`);
    }
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
});

let redirectUri = "";
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  redirectUri = `http://127.0.0.1:${address.port}/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    // events covers reading and writing events; readonly is still needed for
    // the calendar list below (events alone can't call calendarList).
    scope:
      "https://www.googleapis.com/auth/calendar.events " +
      "https://www.googleapis.com/auth/calendar.readonly",
    access_type: "offline",
    // Force the consent screen so Google always issues a refresh token.
    prompt: "consent",
    state,
  });

  console.log("Open this URL in your browser and approve access:\n");
  console.log(`https://accounts.google.com/o/oauth2/v2/auth?${params}\n`);
  console.log("Waiting for Google to redirect back…");
});
