import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import ciWorkflow from '../../../.github/workflows/ci.yml?raw';
import prepareWorkflow from '../../../.github/workflows/prepare-release.yml?raw';
import releaseWorkflow from '../../../.github/workflows/release.yml?raw';
import retryWorkflow from '../../../.github/workflows/retry-store.yml?raw';

const REPO = resolve(__dirname, '../../..');

/** Top-level job ids, found by their heading indentation. */
const jobNames = (workflow: string) => [...workflow.matchAll(/^ {2}([\w-]+):\n {4}name:/gm)].map((m) => m[1]);
/** Text of one job, from its heading to the next job heading or the end. */
const job = (workflow: string, name: string) => {
  const match = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[\\w-]+:\\n {4}name:|(?![\\s\\S]))`, 'm').exec(workflow);
  if (!match) throw new Error(`job ${name} not found`);
  return match[0];
};
/** Workflow text without comment lines, for assertions about what the workflow executes. */
const withoutComments = (workflow: string) =>
  workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const scriptsReferenced = (workflow: string) => [...new Set([...workflow.matchAll(/scripts\/release\/[\w-]+\.mjs/g)].map((m) => m[0]))];
const actionPins = (workflow: string) => [...workflow.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)].map((m) => `${m[1]}@${m[2]}`);

/**
 * The Release and Retry workflows must agree on how a package reaches the store, and the Retry
 * workflow must be unable to do anything but resume the store step of an existing release.
 */
describe('Retry Chrome Web Store workflow', () => {
  it('is manual only, scoped to main, owner-gated and serialised with the Release workflow', () => {
    expect(retryWorkflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(retryWorkflow).not.toMatch(/^\s+(push|pull_request|release|schedule|workflow_run):/m);
    expect(retryWorkflow).toContain("if: github.ref != 'refs/heads/main'");
    expect(retryWorkflow).toContain('vars.RELEASE_PUBLISHERS');
    expect(retryWorkflow).toMatch(/concurrency:\n {2}group: release\n {2}cancel-in-progress: false/);
    expect(releaseWorkflow).toMatch(/concurrency:\n {2}group: release\n {2}cancel-in-progress: false/);
  });

  it('asks for the released version, a real store action and the draft acknowledgement', () => {
    expect(retryWorkflow).toMatch(/version:\n\s+description: .*\n\s+required: true\n\s+type: string/);
    expect(retryWorkflow).toMatch(/store:\n(?:\s+.*\n)*?\s+type: choice\n(?:\s+.*\n)*?\s+options:\n\s+- upload-only\n\s+- submit-for-review\n\s+- submit-staged\n/);
    expect(retryWorkflow).not.toMatch(/options:\n(?:\s+- .*\n)*\s+- none\n/);
    expect(retryWorkflow).toMatch(/replace_draft:\n(?:\s+.*\n)*?\s+type: boolean\n\s+default: false/);
  });

  it('never builds, tags, releases or bumps a version', () => {
    const executed = withoutComments(retryWorkflow);
    expect(executed).not.toMatch(/npm (ci|install|run build|run test)/);
    expect(executed).not.toMatch(/vite|rolldown/);
    expect(executed).not.toMatch(/gh release|gh api|git tag|git push|git commit/);
    expect(executed).not.toMatch(/release\/package\.mjs|prepare\.mjs|check-version\.mjs|zip\.mjs/);
    expect(executed).not.toMatch(/environment: release\b/);
    expect(retryWorkflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(retryWorkflow).not.toMatch(/contents: write|pull-requests: write/);
  });

  it('downloads and verifies the GitHub Release assets before any store call, and re-verifies in the store job', () => {
    expect(jobNames(retryWorkflow)).toEqual(['verify-release', 'chrome-web-store']);
    const verify = job(retryWorkflow, 'verify-release');
    expect(verify).toMatch(/node scripts\/release\/fetch-release\.mjs --version "\$VERSION" --repository "\$REPOSITORY" --out release/);
    expect(verify).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(verify).toMatch(/upload-artifact@[0-9a-f]{40}[\s\S]*?name: TokenLens-v\$\{\{ inputs\.version \}\}-released/);
    const store = job(retryWorkflow, 'chrome-web-store');
    expect(store).toContain('needs: verify-release');
    expect(store).toContain('environment: chrome-web-store');
    expect(store).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write/);
    expect(store).toMatch(/download-artifact@[0-9a-f]{40}[\s\S]*?name: TokenLens-v\$\{\{ inputs\.version \}\}-released/);
    expect(store).toMatch(/verify-package\.mjs --zip "release\/\$ZIP_NAME" --version "\$VERSION" --sha256 "\$SHA256" --checksum "release\/\$ZIP_NAME\.sha256"/);
    expect(store.indexOf('verify-package.mjs')).toBeLessThan(store.indexOf('google-github-actions/auth'));
    expect(store.indexOf('google-github-actions/auth')).toBeLessThan(store.indexOf('cws-recover.mjs'));
    expect(store).toMatch(/cws-recover\.mjs\n\s+--publisher "\$PUBLISHER"\n\s+--item "\$ITEM"\n\s+--zip "release\/\$ZIP_NAME"\n\s+--expect-version "\$VERSION"\n\s+--action "\$STORE"\n\s+--replace-draft "\$REPLACE_DRAFT"/);
  });

  it('passes workflow inputs to shell steps only through environment variables', () => {
    const inputLines = retryWorkflow.split('\n').filter((line) => /\$\{\{\s*inputs\./.test(line));
    expect(inputLines.length).toBeGreaterThan(3);
    for (const line of inputLines) expect(line, line).toMatch(/^\s+([A-Z_]+: \$\{\{ inputs\.\w+ \}\}|name: TokenLens-v\$\{\{ inputs\.version \}\}-released)$/);
    expect(retryWorkflow).not.toMatch(/run:.*\$\{\{\s*inputs\./);
  });

  it('uses the same credentials, token lifetime, action pins and environment as the Release workflow', () => {
    const releaseStore = job(releaseWorkflow, 'chrome-web-store');
    const retryStore = job(retryWorkflow, 'chrome-web-store');
    for (const line of [
      'token_format: access_token',
      'access_token_scopes: https://www.googleapis.com/auth/chromewebstore',
      'access_token_lifetime: 1200s',
      'create_credentials_file: false',
      'workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}',
      'service_account: ${{ vars.CWS_SERVICE_ACCOUNT }}',
      'CWS_ACCESS_TOKEN: ${{ steps.auth.outputs.access_token }}',
    ]) {
      expect(releaseStore).toContain(line);
      expect(retryStore).toContain(line);
    }
    for (const variable of ['CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID', 'GCP_WORKLOAD_IDENTITY_PROVIDER', 'CWS_SERVICE_ACCOUNT']) {
      expect(releaseStore).toContain(`vars.${variable}`);
      expect(retryStore).toContain(`vars.${variable}`);
    }
    const releasePins = new Map(actionPins(releaseWorkflow).map((p) => p.split('@') as [string, string]));
    for (const [action, sha] of actionPins(retryWorkflow).map((p) => p.split('@') as [string, string])) {
      expect(releasePins.get(action), `${action} pin differs from release.yml`).toBe(sha);
    }
  });

  it('references only release scripts that exist', () => {
    for (const workflow of [releaseWorkflow, retryWorkflow, prepareWorkflow]) {
      for (const script of scriptsReferenced(workflow)) expect(existsSync(resolve(REPO, script)), script).toBe(true);
    }
    expect(scriptsReferenced(retryWorkflow).sort()).toEqual(['scripts/release/cws-recover.mjs', 'scripts/release/fetch-release.mjs', 'scripts/release/verify-package.mjs']);
  });
});

describe('Release workflow input rules', () => {
  it('validates the input combination with the shared script before any job with side effects', () => {
    const validate = job(releaseWorkflow, 'validate');
    expect(validate).toMatch(/check-inputs\.mjs --github-release "\$GH_RELEASE" --store "\$STORE" --allow-non-monotonic "\$NON_MONOTONIC" --reason "\$REASON"/);
    expect(validate.indexOf('check-inputs.mjs')).toBeLessThan(validate.indexOf('check-version.mjs'));
    for (const name of ['build', 'e2e', 'github-release', 'chrome-web-store']) expect(job(releaseWorkflow, name)).toMatch(/needs: (\[validate|validate)/);
  });

  it('keeps the publishing jobs gated and passes the store action through the shared vocabulary', () => {
    expect(job(releaseWorkflow, 'github-release')).toContain('if: inputs.github_release');
    const store = job(releaseWorkflow, 'chrome-web-store');
    expect(store).toContain("if: inputs.store != 'none'");
    expect(store).toMatch(/needs: \[validate, build, github-release\]/);
    expect(store).toMatch(/STORE: \$\{\{ inputs\.store \}\}/);
    expect(store).toMatch(/cws-publish\.mjs\n\s+--publisher "\$PUBLISHER"\n\s+--item "\$ITEM"\n\s+--zip "release\/\$ZIP_NAME"\n\s+--expect-version "\$VERSION"\n\s+--action "\$STORE"/);
    expect(store).not.toMatch(/inputs\.store == 'upload-only' && 'upload'/);
  });

  it('describes the inputs so a real release cannot be configured without a store action', () => {
    expect(releaseWorkflow).toMatch(/github_release:\n\s+description: '.*on requires a store action.*'/);
    expect(releaseWorkflow).toMatch(/store:\n\s+description: '.*none is only valid for a dry run.*'/);
  });

  it('CI still never publishes and the prepare workflow never tags', () => {
    expect(ciWorkflow).not.toMatch(/gh release|cws-publish|cws-recover|chromewebstore/);
    expect(withoutComments(prepareWorkflow)).not.toMatch(/gh release|git tag (?!--list)|cws-/);
  });
});
