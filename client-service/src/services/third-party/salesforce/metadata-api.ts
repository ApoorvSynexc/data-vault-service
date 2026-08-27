import JSZip from 'jszip';
import { salesforceRequest, SalesforceTokens } from './index';
import { timer } from '../../../utils/helper';

// Metadata API version — kept in sync with services/third-party/salesforce/trigger.ts.
export const METADATA_API_VERSION = '66.0';

interface DeployFile {
  path: string;
  content: string;
}

interface DeployOptions {
  files: DeployFile[];
  packageXml: string;
  destructiveChangesXml?: string;
  allowMissingFiles?: boolean;
}

// Shared Metadata API multipart-zip deploy + poll pattern. Extracted from the
// inlined logic in trigger.ts so any endpoint that needs to push metadata
// (permission sets, external client app updates, etc.) uses the same
// exact-once helper and doesn't reimplement the boundary construction.
export const deployMetadata = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  { files, packageXml, destructiveChangesXml, allowMissingFiles = false }: DeployOptions
): Promise<void> => {
  // createFolders: false — JSZip's default (true) additionally writes explicit
  // directory entries ("objects/", "objects/Account/", ...) into the zip for
  // every nested file path. Salesforce's deploy-zip scanner chokes on those:
  // it reports the real file as "named in package.xml, but was not found in
  // zipped directory" even though the file is genuinely present, because the
  // directory entries confuse its component lookup. Confirmed live — a
  // multi-file deploy (this function's first real multi-file caller,
  // restore-fields.ts's per-object field batches) failed 100% of the time
  // with exactly that error until this was set.
  // ponytail: experimental (round 2) — wrapping everything under unpackaged/
  // and switching to singlePackage:false, matching the classic Ant Migration
  // Tool deploy-root convention. Revert (drop the prefix, singlePackage:true)
  // if this doesn't fix the "not found in zipped directory" error.
  const zip = new JSZip();
  for (const file of files) {
    zip.file(`unpackaged/${file.path}`, file.content, { createFolders: false });
  }
  zip.file('unpackaged/package.xml', packageXml);
  if (destructiveChangesXml) {
    zip.file('unpackaged/destructiveChanges.xml', destructiveChangesXml, { createFolders: false });
  }
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  // ponytail: temporary diagnostic — createFolders:false didn't stop the
  // "named in package.xml, but not found in zipped directory" error, so log
  // exactly what we're about to send. Remove once the cause is confirmed.
  console.log('[deployMetadata] zip entries:', Object.keys(zip.files));
  console.log('[deployMetadata] package.xml:\n' + packageXml);

  const deployOptions = JSON.stringify({
    deployOptions: {
      allowMissingFiles,
      autoUpdatePackage: false,
      checkOnly: false,
      ignoreWarnings: true,
      rollbackOnError: true,
      runAllTests: false,
      singlePackage: false,
    },
  });

  const boundary = `----DataVaultBoundary${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="json"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${deployOptions}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="deploy.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`
    ),
    zipBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  // httpRequest hardcodes application/json — use native fetch for multipart upload.
  const deployResponse = await fetch(
    `${instanceUrl}/services/data/v${METADATA_API_VERSION}/metadata/deployRequest`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!deployResponse.ok) {
    throw new Error(`metadata_deploy_request_failed: ${await deployResponse.text()}`);
  }

  const { id: jobId } = await deployResponse.json() as { id: string };

  // Poll until the deploy job completes (Salesforce deploys are async).
  while (true) {
    await timer(2000);
    const { data } = await salesforceRequest<{
      deployResult: {
        done: boolean;
        success: boolean;
        errorMessage?: string;
        details?: {
          componentFailures?: { problem: string; componentType: string; fullName: string }[];
        };
      };
    }>(
      {
        url: `${instanceUrl}/services/data/v${METADATA_API_VERSION}/metadata/deployRequest/${jobId}?includeDetails=true`,
        method: 'GET',
      },
      tokens
    );

    const { done, success, errorMessage, details } = data.deployResult;
    if (!done) {
      continue;
    }
    if (!success) {
      const failures = details?.componentFailures
        ?.map((f) => `${f.componentType}:${f.fullName} — ${f.problem}`)
        .join('; ');
      throw new Error(`metadata_deploy_failed: ${failures ?? errorMessage ?? 'unknown error'}`);
    }
    return;
  }
};

// Convenience wrapper — builds the package.xml for a single metadata type + members.
export const buildPackageXml = (type: string, members: string[]): string => {
  const memberXml = members.map((m) => `        <members>${m}</members>`).join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <types>\n` +
    `${memberXml}\n` +
    `        <name>${type}</name>\n` +
    `    </types>\n` +
    `    <version>${METADATA_API_VERSION}</version>\n` +
    `</Package>`
  );
};
