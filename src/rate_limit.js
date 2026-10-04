import { jobsDb } from "./jobs.js";
// reference/app/controllers/sessions_controller.rb limits each IP to 10 attempts/3 minutes.
export function allowLogin(ip, at = Date.now()) {
  const db = jobsDb();
  db.exec(
    "CREATE TABLE IF NOT EXISTS login_limits(ip TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL)",
  );
  const row = db
    .prepare(
      "INSERT INTO login_limits(ip,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(ip) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING attempts",
    )
    .get(ip, at + 180000, at, at);
  db.prepare("DELETE FROM login_limits WHERE expires_at<=?").run(at);
  return row.attempts <= 10;
}
