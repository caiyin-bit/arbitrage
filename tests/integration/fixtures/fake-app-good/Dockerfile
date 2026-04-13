FROM node:20-alpine
WORKDIR /app
RUN cat > server.js <<'EOF'
const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok","checks":{"database":"ok","redis":"ok"}}');
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(3000, "0.0.0.0");
EOF
EXPOSE 3000
CMD ["node", "server.js"]
