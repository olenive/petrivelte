# Node's own root bundle is what the server-side fetches to the control plane
# and `npm ci` check certificates against, so the version is a trust decision:
# 22.23.4 is the first 22.x release without the emSign root whose intermediate
# keys were disclosed in October 2026. Pinned rather than the floating 22-slim
# so a cached builder layer cannot keep an older runtime.
FROM node:22.23.4-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Set API URL at build time for client-side code
ARG PUBLIC_API_URL=http://localhost:8000
ENV PUBLIC_API_URL=$PUBLIC_API_URL

RUN npm run build

FROM node:22.23.4-slim

WORKDIR /app

COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3000

ENV NODE_ENV=production
# PUBLIC_API_URL is read at runtime by $env/dynamic/public.
# Override at deploy time: docker run -e PUBLIC_API_URL=https://api.example.com ...
ARG PUBLIC_API_URL
ENV PUBLIC_API_URL=$PUBLIC_API_URL
CMD ["node", "build"]
