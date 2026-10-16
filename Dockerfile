# Remote Wrap Check MCP server (Streamable HTTP). Build from the repo root:
#   docker build -t wrap-check .
#   docker run -p 8080:8080 -e WRAPCHECK_TOKEN=<secret> -e PUBLIC_URL=https://your.host wrap-check
FROM node:22-bookworm-slim
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json mcp/
RUN cd mcp && npm ci --omit=dev && npx playwright-core install --with-deps chromium
# The viewer (index.html, godot engine) is served from here; car packs are fetched from GitHub Pages on first use.
COPY index.html compose.js server.js icon* apple-touch-icon.png ./
COPY godot godot
COPY mcp/server.js mcp/server.js
ENV PORT=8080
EXPOSE 8080
CMD ["node", "mcp/server.js", "--http"]
