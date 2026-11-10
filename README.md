# Energiegedrag Cockpit

Web portal in which researchers set up [NeedForHeat](https://github.com/energiegedrag-nl/needforheat-server-api) campaigns, invite participants and see per participant and per data source whether measurements keep coming in.

## Table of contents
* [General info](#general-info)
* [Deploying](#deploying)
* [Developing](#developing)
* [Features](#features)
* [Contributing](#contributing)
* [Status](#status)
* [License](#license)
* [Credits](#credits)

## General info
A NeedForHeat campaign used to be set up and followed with `curl` calls and database queries. The Cockpit puts that in a browser:

- **Campaigns**: overview with state (planned, running, ended), number of participants and how many activated the app; create a campaign from an existing app and data source list; change info page, start and end date.
- **Invitations**: create any number of pseudonymous participant accounts at once, each with a personal activation link and QR code to print or send. Links are shown once; a participant who lost one gets a new link.
- **Monitoring**: a table of participants × data sources with the latest upload and a state (on time, waiting for first data, late, not connected). *Late* uses each data source's `notification_threshold`, the same rule the app uses to warn participants. Filters for *attention needed*, *incomplete* and *invited*.

The Cockpit stores no names or e-mail addresses: participants are account numbers. Keep the link between a person and a number in your own administration.

The interface is in Dutch. Later phases (flashing devices from the browser, device inventory, OIDC login, server-side mail) are listed in the [`cockpit` TODO](https://github.com/energiegedrag-nl/needforheat-server-api/blob/main/TODO.md#cockpit).

## Deploying

### Prerequisites
- `needforheat-server-api` with the `/admin` routes ([PR #22](https://github.com/energiegedrag-nl/needforheat-server-api/pull/22));
- an admin token: `docker compose exec api needforheat-server-api admin create -n <name> -e <yyyy-mm-dd>`;
- Docker, on the same Docker network as the API.

### Steps
1. Build the image: `docker build -t energiegedrag-cockpit .`
2. Run it next to the API; `API_UPSTREAM` is where nginx finds the API (default `http://api:8080`):
   ```shell
   docker run -d --name cockpit --network <api-network> -e API_UPSTREAM=http://api:8080 energiegedrag-cockpit
   ```
3. Publish it **only on the LAN or via WireGuard** (Traefik `lan-only` middleware), for example as `cockpit.energiegedrag.nl`. The public API route must not pass `/admin`.
4. Open the Cockpit and paste the admin token. It is kept in `sessionStorage` and is gone when the tab closes.

nginx serves the Cockpit and proxies `/api/` to the API, so browser and API share one origin (no CORS) and the token is only sent to that host.

## Developing

### Prerequisites
Node.js 22 and a running `needforheat-server-api` (local or through an SSH tunnel).

```shell
npm install
NFH_API=http://localhost:8080 npm run dev   # Vite proxies /api to NFH_API
npm test                                   # unit tests (Vitest)
npm run build                              # typecheck and production build in dist/
```

Stack: TypeScript, React 18, Vite, TanStack Query. API types: [`src/types.ts`](src/types.ts), matching package `needforheat/cockpit` of the server.

## Features
Ready:
* campaign overview, creation and settings;
* invitations with link and QR code, new link for a lost invitation;
* monitoring per participant and data source, refreshed every minute.

To-do:
* set up apps, device types and data source lists in the Cockpit (now: runbook);
* flash station: Web Serial + esptool-js, device inventory, labels;
* OIDC login with roles and an audit log;
* invitations and reminders by mail from the server;
* export per campaign for analysis.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status
Project is: _in progress_. First version, not yet deployed.

## License
This software is available under the [European Union Public Licence v1.2 (EUPL-1.2)](LICENSE), © 2026 Henri ter Hofte.

## Credits
This software is a collaborative effort of:
* Henri ter Hofte · [@henriterhofte](https://github.com/henriterhofte)

Built on [React](https://react.dev), [Vite](https://vitejs.dev), [TanStack Query](https://tanstack.com/query) and [node-qrcode](https://github.com/soldair/node-qrcode).
