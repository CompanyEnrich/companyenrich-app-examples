# state/

`state.json` is the monitor's memory between runs. It is created on the first real run, rewritten after every paid page or batch, and never touched by `--dry-run`. It is gitignored here because it holds data about real companies and people.

One entry per watcher id:

| Watcher type | What is stored | Why |
| --- | --- | --- |
| `new-companies` | `seenDomains`: every domain already reported, oldest first (up to 20,000) | The most recent 2,500 go into the search's `domain.notIn` rule so the free count only sees new companies. Older ones are filtered out locally. |
| `new-leaders` | `seen`: `personId:position`, plus the watched account and month each person was found under; `windowAnchor`; `queryKey` | Dedupes people and lets the free per-account, per-month counts be compared with what is already known. Entries older than the current window are dropped. |
| `account-changes` | `snapshots`: per domain, the employee and revenue range, industry, HQ city and country, latest funding stage, date and total, technologies, observed headcount and department headcounts, plus `capturedAt` | The next refresh is diffed against these. |

Every entry also has `lastRunAt`. No names, emails or full profiles are stored.

To start a watcher over, run `npm start -- --reset-state --watcher <id>`. Without `--watcher` it resets every watcher and does not read the old file at all, which is also how to recover from a corrupt one. If you schedule the monitor with GitHub Actions and commit this file, keep the repository private: it contains company domains and CompanyEnrich person ids.
