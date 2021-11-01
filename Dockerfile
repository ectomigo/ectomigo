FROM node:16-alpine

RUN apk update
RUN apk add python3 git build-base

# downgrade npm as long as it's throwing 401s in Docker
RUN npm install -g npm@6

RUN mkdir /srv/ectomigo

COPY ./entrypoint.sh ./package.json ./package-lock.json ./index.js ./lib/ /srv/ectomigo/

RUN cd /srv/ectomigo && npm ci

ENTRYPOINT ["/srv/ectomigo/entrypoint.sh"]
