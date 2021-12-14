FROM node:16-alpine

RUN apk update
RUN apk add python3 git build-base

# downgrade npm as long as it's throwing 401s in Docker
RUN npm install -g npm@6

RUN mkdir /srv/ectomigo

COPY ./package.json ./package-lock.json ./index.js /srv/ectomigo/
COPY ./lib /srv/ectomigo/lib

RUN cd /srv/ectomigo && npm ci

ENTRYPOINT ["/srv/ectomigo/index.js"]
