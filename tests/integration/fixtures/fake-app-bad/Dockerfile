FROM node:20-alpine
WORKDIR /app
RUN cat > server.js <<'EOF'
const http = require("http");
http.createServer((req, res) => {
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end('{"status":"down"}');
}).listen(3000, "0.0.0.0");
EOF
EXPOSE 3000
CMD ["node", "server.js"]
