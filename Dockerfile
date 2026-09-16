# Reference Tool Dictionary service. Two stages so the runtime image carries
# only production dependencies and the compiled output.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` builds, and src is not copied yet.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY spec ./spec
COPY src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
# The JSON Schema is read at runtime by the validator.
COPY spec/schema ./spec/schema
USER node
EXPOSE 8080
ENV TD_HOST=0.0.0.0 TD_PORT=8080 TD_CONFIG=/config/tool-dictionary.json
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/v1/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
