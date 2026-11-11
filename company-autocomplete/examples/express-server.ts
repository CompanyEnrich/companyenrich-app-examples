// The company handler mounted in Express, serving the framework-free demo
// (examples/vanilla.html with the <company-autocomplete> web component).
//
//   npm run example:express    then open http://localhost:3105

import express from 'express';
import { fileURLToPath } from 'node:url';
import { createCompanyHandler } from '../src/server/handler';

const handler = createCompanyHandler({ apiKey: process.env.COMPANYENRICH_API_KEY });
const app = express();

app.get('/api/company', async (req, res) => {
  // The handler only needs the URL. Client headers are not copied, and the IP
  // comes from Express (set `trust proxy` if you run behind a load balancer).
  const response = await handler(new Request(new URL(req.originalUrl, 'http://localhost')), { clientIp: req.ip });
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(await response.text());
});

app.get('/', (_req, res) => res.sendFile(fileURLToPath(new URL('./vanilla.html', import.meta.url))));
app.get('/company-autocomplete.js', (_req, res) =>
  res.sendFile(fileURLToPath(new URL('../dist/company-autocomplete.js', import.meta.url))),
);

const port = Number(process.env.PORT ?? 3105);
app.listen(port, () => console.log(`Web component demo: http://localhost:${port}`));
