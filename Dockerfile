FROM node:16-alpine

RUN mkdir /srv/ectomigo

COPY ./entrypoint.sh ./package.json ./package-lock.json ./index.js ./lib/ /srv/ectomigo/

ENTRYPOINT ["/srv/ectomigo/entrypoint.sh"]
