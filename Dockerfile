FROM node:22-alpine

WORKDIR /app

# Instalar dependencias (usa package-lock.json para builds reproducibles)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el resto del proyecto
COPY . .

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "server/index.mjs"]
