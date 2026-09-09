import { appendFileSync } from "node:fs";

export const AUTH_MODES = Object.freeze({
  TRUSTED_PUBLISHING: "trusted-publishing",
  TOKEN: "token",
  DRY_RUN: "credential-free-dry-run",
});

export function selectAuthentication({ trustedPublishing, tokenConfigured }) {
  if (trustedPublishing === true || trustedPublishing === "true") {
    return AUTH_MODES.TRUSTED_PUBLISHING;
  }
  if (tokenConfigured === true || tokenConfigured === "true") {
    return AUTH_MODES.TOKEN;
  }
  return AUTH_MODES.DRY_RUN;
}

export function parseRepositoryVisibility(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`repository visibility must be the live boolean true/false, got: ${String(value)}`);
}

export function selectProvenance({ repositoryPrivate }) {
  if (repositoryPrivate === true) {
    return {
      provenanceEnabled: false,
      publishEnvironment: { NPM_CONFIG_PROVENANCE: "false" },
    };
  }
  if (repositoryPrivate === false) {
    return {
      provenanceEnabled: true,
      publishEnvironment: {},
    };
  }
  throw new Error("repository visibility must be a boolean");
}

export function buildPublishPlan({ trustedPublishing, tokenConfigured, repositoryPrivate }) {
  const privateRepository = parseRepositoryVisibility(repositoryPrivate);
  const authMode = selectAuthentication({ trustedPublishing, tokenConfigured });
  const provenance = selectProvenance({ repositoryPrivate: privateRepository });
  return {
    authMode,
    privateRepository,
    provenanceEnabled: provenance.provenanceEnabled,
    publishEnvironment: provenance.publishEnvironment,
    unsetNodeAuthToken: authMode === AUTH_MODES.TRUSTED_PUBLISHING,
    willPublish: authMode !== AUTH_MODES.DRY_RUN,
  };
}

function writeGithubOutput(path, plan) {
  appendFileSync(
    path,
    [
      `auth_mode=${plan.authMode}`,
      `private_repository=${plan.privateRepository}`,
      `provenance_enabled=${plan.provenanceEnabled}`,
      `unset_node_auth_token=${plan.unsetNodeAuthToken}`,
      `will_publish=${plan.willPublish}`,
    ].join("\n") + "\n",
  );
}

function main(argv) {
  const githubOutputIndex = argv.indexOf("--github-output");
  const githubOutput = githubOutputIndex === -1 ? undefined : argv[githubOutputIndex + 1];
  if (githubOutputIndex !== -1 && !githubOutput) {
    throw new Error("--github-output requires a file path");
  }
  if (argv.some((argument) => argument !== "--github-output" && argument !== githubOutput)) {
    throw new Error("usage: node scripts/g72-trusted-publishing-selection.mjs [--github-output PATH]");
  }

  const plan = buildPublishPlan({
    trustedPublishing: process.env.NPM_TRUSTED_PUBLISHING,
    tokenConfigured: Boolean(process.env.NODE_AUTH_TOKEN),
    repositoryPrivate: process.env.REPO_IS_PRIVATE,
  });
  if (githubOutput) writeGithubOutput(githubOutput, plan);
  console.log(JSON.stringify({
    ...plan,
    tokenConfigured: Boolean(process.env.NODE_AUTH_TOKEN),
  }, null, 2));
}

if (process.argv[1]?.endsWith("g72-trusted-publishing-selection.mjs")) {
  main(process.argv.slice(2));
}
