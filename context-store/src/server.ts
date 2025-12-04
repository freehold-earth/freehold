/**
 * PCI Context Store HTTP Server
 *
 * Simple HTTP server for the Context Store API.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = parseInt(process.env.PORT || "8081", 10);

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const { method, url } = req;

  if (method === "GET" && url === "/health") {
    sendJson(res, { status: "healthy", service: "pci-context-store" });
    return;
  }

  if (method === "GET" && url === "/") {
    sendJson(res, {
      service: "pci-context-store",
      version: "0.1.0",
      endpoints: ["/health", "/vaults", "/vaults/:id"],
    });
    return;
  }

  if (method === "GET" && url === "/vaults") {
    // Placeholder - would return list of vaults
    sendJson(res, { vaults: [] });
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}

const server = createServer(handleRequest);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PCI Context Store starting on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
