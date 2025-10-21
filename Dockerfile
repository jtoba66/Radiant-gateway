FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY gateway-server.js ./

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

CMD ["node", "gateway-server.js"]