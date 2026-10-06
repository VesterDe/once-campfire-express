import { createRequire } from "node:module";
// Lean router for POST /rooms/:roomId/messages (posting a message). It is the
// app's own router stack minus the layers whose path cannot match
// /rooms/<digits>/messages (other routes, /assets, /rails/active_storage/disk)
// and minus the JSON and text body parsers, which only parse other content types.
// Every remaining layer (headers, encoding, urlencoded parser, multipart,
// method override, session, bans/CSRF, the messages route, 404, errors) runs
// unchanged and in the same order.
const Router = createRequire(createRequire(import.meta.url).resolve("express"))(
  "router",
);
const PATH = /^\/rooms\/\d+\/messages$/;
const SAMPLE = "/rooms/123/messages";
const lean = new WeakMap();
function build(app) {
  const router = new Router({
    caseSensitive: app.enabled("case sensitive routing"),
    strict: app.enabled("strict routing"),
  });
  router.params = app.router.params;
  router.stack = app.router.stack.filter(
    (l) =>
      l.match(SAMPLE) &&
      !(
        l.handle.skipOnFastPath &&
        (l.handle.name === "jsonParser" || l.handle.name === "textParser")
      ),
  );
  return Object.create(app, { router: { value: router } });
}
export function postFastPath(app, req, res) {
  if (req.method !== "POST" || !PATH.test(req.url)) return false;
  const type = req.headers["content-type"];
  // Only urlencoded bodies: the dropped JSON/text parsers would skip them.
  if (
    type !== "application/x-www-form-urlencoded" &&
    type !== "application/x-www-form-urlencoded; charset=utf-8" &&
    type !== "application/x-www-form-urlencoded; charset=UTF-8"
  )
    return false;
  let l = lean.get(app);
  if (!l) lean.set(app, (l = build(app)));
  l.handle(req, res);
  return true;
}
