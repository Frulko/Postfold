FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@10.31.0
COPY package.json pnpm-lock.yaml ./

FROM dependencies AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM dependencies AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/Frulko/Postfold" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=3002 API_HOST=0.0.0.0 API_PORT=4000
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/LICENSE ./
COPY --from=build /app/.output ./.output
COPY --from=build /app/api/dist ./api/dist
USER node
EXPOSE 3002 4000
CMD ["node", ".output/server/index.mjs"]
