// 画面から見える1つの入口（54321）。パスの頭で、ログイン・データ・ファイルの各部品に振り分ける。
import http from "node:http";
const routes = { "/auth/v1": ["auth", 9999], "/rest/v1": ["rest", 3000], "/storage/v1": ["storage", 5000], "/functions/v1": ["functions", 9000] };
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, prefer, range, accept-profile, content-profile, x-upsert, x-supabase-api-version, cache-control, if-none-match",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  "access-control-expose-headers": "content-range, content-length, etag",
  "access-control-max-age": "86400",
};
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const prefix = Object.keys(routes).find((p) => req.url.startsWith(p));
  if (!prefix) { res.writeHead(404, cors); return res.end("not found"); }
  const [host, port] = routes[prefix];
  const up = http.request({ host, port, method: req.method, path: req.url.slice(prefix.length) || "/", headers: { ...req.headers, host: `${host}:${port}` } }, (r) => {
    res.writeHead(r.statusCode, { ...r.headers, ...cors });
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502, cors); res.end("upstream down"); });
  req.pipe(up);
}).listen(54321, "0.0.0.0", () => console.log("gateway :54321"));
