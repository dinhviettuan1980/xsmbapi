/**
 * Commit review notifier — sends a summary of a git commit to Telegram + email.
 * Wired as a post-commit hook (.githooks/post-commit) so EVERY commit notifies,
 * including your own. Sends directly from the local machine (reaches both
 * api.telegram.org and api.resend.com; the AWS server is blocked from Telegram).
 *
 * Usage: node scripts/commit-review.mjs [<commit-ish>]   (default HEAD)
 *
 * Keys baked in (prototype); override via env: TELEGRAM_BOT_TOKEN,
 * TELEGRAM_CHAT_ID, RESEND_API_KEY, NOTIFY_EMAIL.
 */
import { execSync } from "child_process";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "8000475351:AAHFDCHXk9MxHvw0TWnwVhJjaYpuORQLNqk";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "5689839645";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_edUJcpZr_D3FMaXSPhRn152zds4Fox3XS";
const EMAIL = process.env.NOTIFY_EMAIL ?? "tuandv@gmail.com";

const ref = process.argv[2] || "HEAD";
const git = (args) => execSync(`git ${args}`, { encoding: "utf8" }).replace(/\s+$/, "");
const fmt = (f) => git(`show -s --format=${f} ${ref}`);

let repo = "repo";
try { repo = git("rev-parse --show-toplevel").split(/[\\/]/).pop(); } catch {}

const short = fmt("%h");
const hash = fmt("%H");
const author = fmt("%an");
const date = fmt("%ci").slice(0, 16);
const subject = fmt("%s");
const fullMsg = fmt("%B");

let stat = "";
try { stat = git(`show ${ref} --stat --format= --no-color`).replace(/^\n+/, ""); } catch {}
if (stat.length > 2500) stat = stat.slice(0, 2500) + "\n…(truncated)";

const title = `📦 ${repo} · ${short} — ${subject}`;
const bodyText =
  `Repo:   ${repo}\n` +
  `Commit: ${short}  (${hash})\n` +
  `Author: ${author}\n` +
  `Date:   ${date}\n\n` +
  `${fullMsg}\n\n` +
  `Changes:\n${stat || "(no diff stat)"}`;

async function sendTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `${title}\n\n${bodyText}`.slice(0, 4000) }),
    });
    const json = await res.json();
    console.log(json.ok ? "[commit-review] Telegram sent" : `[commit-review] Telegram failed: ${JSON.stringify(json)}`);
  } catch (err) {
    console.log(`[commit-review] Telegram request failed: ${err.message}`);
  }
}

async function sendEmail() {
  if (!RESEND_API_KEY) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: "ConnectDoctor Agent <onboarding@resend.dev>",
        to: [EMAIL],
        subject: title,
        html: `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap">${bodyText
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
      }),
    });
    const json = await res.json();
    console.log(json.id ? `[commit-review] email sent (${json.id})` : `[commit-review] email failed: ${JSON.stringify(json)}`);
  } catch (err) {
    console.log(`[commit-review] email request failed: ${err.message}`);
  }
}

await Promise.allSettled([sendTelegram(), sendEmail()]);
