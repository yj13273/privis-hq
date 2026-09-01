import http from "node:http";

const port = Number(process.env.PORT || 8787);
const allowedActions = new Set(["click", "scroll", "focus", "type_placeholder", "navigate_safe"]);

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 8_000_000) reject(new Error("request too large")); });
    request.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid JSON")); } });
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/agent/analyze") { response.writeHead(404).end(); return; }
  try {
    const payload = await readJson(request);
    if (payload.rawImage || payload.rawScreenshot || payload.rawOCR || payload.password || payload.creditCard || payload.email || payload.phone) throw new Error("raw fields are not accepted");
    const action = { type: "click", target: "submit-button" };
    if (!allowedActions.has(action.type)) throw new Error("invalid mock action");
    response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify({ action }));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "bad request" }));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`PRIVIS mock agent listening on http://127.0.0.1:${port}`));
