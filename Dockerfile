FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server ./server
COPY db-postgres.js ./

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server/server.js"]
