# One image runs both processes; `command` in docker-compose picks which.
# Yarn 4 comes from Corepack, pinned by the `packageManager` field in package.json.
FROM node:24-alpine AS yarn-env
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY ./package.json ./yarn.lock ./.yarnrc.yml /app/
RUN corepack enable && corepack install

FROM yarn-env AS development-dependencies-env
COPY . /app
RUN yarn install --immutable

FROM yarn-env AS production-dependencies-env
# `workspaces focus --production` is Yarn 4's equivalent of `npm ci --omit=dev`.
RUN yarn workspaces focus --all --production

FROM yarn-env AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
# Builds the React Router app and bundles worker/index.ts into build/worker/.
RUN yarn build

FROM yarn-env
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
# Migrations are applied by the web container at startup.
COPY --from=build-env /app/drizzle /app/drizzle
COPY --from=build-env /app/drizzle.config.ts /app/drizzle.config.ts
EXPOSE 3000
CMD ["yarn", "start"]
