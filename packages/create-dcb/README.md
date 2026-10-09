# @sekiban/create-dcb

Create a named Cloudflare starter with a visible booking demo:

```sh
npx @sekiban/create-dcb my-booking-app
cd my-booking-app
npm install
```

From a checkout of this repository, run the generator directly:

```sh
node packages/create-dcb/bin/create-dcb.mjs my-booking-app
```

The CLI slugifies the project name to lowercase hyphenated form, writes into
`./<slug>`, and refuses an existing non-empty directory. It does not publish
the package or create Cloudflare resources.

After generation, follow the project's [DEPLOYMENT.md](template/DEPLOYMENT.md)
for the complete topology, offline `npm run deploy:check`, and future
deployment steps. The generated check creates no Cloudflare resources.

The generated project includes `cosmos.experimental.json` as an experimental,
read-only layout and binding descriptor. It does not activate Cosmos: the
generated worker and Wrangler configuration continue to use D1 until the
consumer explicitly changes source composition.
