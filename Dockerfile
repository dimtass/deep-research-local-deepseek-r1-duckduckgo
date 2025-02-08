FROM node:18-alpine

WORKDIR /app

COPY . .
COPY package.json ./

CMD ["make", "run"]
