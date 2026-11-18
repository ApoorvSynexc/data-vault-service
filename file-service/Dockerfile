FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm i

COPY . .
RUN npm run build

ENV LOG_DIR=/app/logs
RUN mkdir -p /app/logs \
&& chown -R node:node /app

EXPOSE 3002

USER node

CMD ["npm", "start"]
