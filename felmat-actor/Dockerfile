FROM apify/actor-node-playwright-chrome:20

COPY package.json ./
RUN npm install --omit=dev --include=dev

COPY tsconfig.json ./
COPY src/ ./src/

CMD ["npx", "tsx", "src/main.ts"]
