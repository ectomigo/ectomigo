FROM node:16-alpine

RUN mkdir /srv/ectomigo

COPY ./entrypoint.sh ./package.json ./package-lock.json ./index.js ./lib/ /srv/ectomigo/

RUN cd /srv/ectomigo && npm ci

ENTRYPOINT ["/srv/ectomigo/entrypoint.sh"]
