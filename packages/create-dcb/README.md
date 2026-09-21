# @sekiban/create-dcb

Create a named Cloudflare starter with a visible booking demo:

```sh
npx @sekiban/create-dcb my-booking-app
cd my-booking-app
npm install
```

Until this package is published, run the local CLI from this repository:

```sh
node packages/create-dcb/bin/create-dcb.mjs my-booking-app
```

The CLI slugifies the project name to lowercase hyphenated form, writes into
`./<slug>`, and refuses an existing non-empty directory. It does not publish
the package or create Cloudflare resources.
