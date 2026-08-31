import JSZip from 'jszip';
import { salesforceRequest, SalesforceTokens } from './index';
import { timer } from '../../../utils/helper';
import { SALESFORCE_METADATA_API_VERSION } from '../../../constant';

// Metadata API version — sourced from ENV (SALESFORCE_METADATA_API_VERSION),
// shared by every file in this directory that imports it.
export const METADATA_API_VERSION = SALESFORCE_METADATA_API_VERSION;

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
  // Flat MDAPI zip root (package.xml at top level, singlePackage: true) — the
  // same layout trigger.ts's deploys already use successfully. createFolders:
  // false stops JSZip from writing implicit directory entries that confuse
  // Salesforce's deploy-zip component scanner.
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content, { createFolders: false });
  }
  zip.file('package.xml', packageXml);
  if (destructiveChangesXml) {
    zip.file('destructiveChanges.xml', destructiveChangesXml, { createFolders: false });
  }
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const deployOptions = JSON.stringify({
    deployOptions: {
      allowMissingFiles,
      autoUpdatePackage: false,
      checkOnly: false,
      ignoreWarnings: true,
      rollbackOnError: true,
      runAllTests: false,
      singlePackage: true,
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
