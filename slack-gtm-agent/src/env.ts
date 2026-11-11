import fs from 'node:fs';

// Load .env from the working directory when there is one. Variables already set in the
// environment win, so `COMPANYENRICH_API_KEY=... npm start` still works without a file.
if (fs.existsSync('.env')) process.loadEnvFile('.env');
