FROM node:22-slim

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["pnpm", "server"]
